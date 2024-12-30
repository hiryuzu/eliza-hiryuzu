import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { ClientBase, ProcessedTweet } from "./base";
import { wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:
Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

{{actions}}
# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

{{recentPosts}}

IMPORTANT: For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    async start() {
        const pollInterval = Number(this.runtime.getSetting("TWITTER_POLL_INTERVAL") || 120) * 1000;

        const handleLoop = async () => {
            await this.handleTwitterInteractions();
            setTimeout(handleLoop, pollInterval);
        };

        handleLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        try {
            const mentionCandidates = await this.fetchMentionedTweets();
            const targetUserTweets = await this.fetchTargetUserTweets();

            // Merge and deduplicate tweet candidates
            const allCandidates = this.mergeTweetCandidates(mentionCandidates, targetUserTweets);

            // Process each tweet
            for (const tweet of allCandidates) {
                await this.processTweetIfNeeded(tweet);
            }

            // Update the last checked tweet ID
            await this.client.cacheLatestCheckedTweetId();

            elizaLogger.log("Finished checking Twitter interactions.");
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    private async fetchMentionedTweets(): Promise<ProcessedTweet[]> {
        const username = this.client.profile.username;
        const mentionCandidates = await this.client.fetchSearchTweets(`@${username}`, 20);
        elizaLogger.log(`Fetched ${mentionCandidates.length} mentioned tweets.`);
        return mentionCandidates;
    }

    private async fetchTargetUserTweets(): Promise<ProcessedTweet[]> {
        const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS") || "";
        const targetUsers = targetUsersStr.split(",").map((u) => u.trim()).filter(Boolean);

        if (!targetUsers.length) {
            elizaLogger.log("No target users configured.");
            return [];
        }

        elizaLogger.log(`Fetching tweets for target users: ${targetUsers.join(", ")}`);
        const tweets: ProcessedTweet[] = [];

        for (const username of targetUsers) {
            try {
                const userTweets = await this.client.fetchSearchTweets(`from:${username}`, 3);
                tweets.push(...userTweets);
            } catch (error) {
                elizaLogger.error(`Error fetching tweets for user ${username}:`, error);
            }
        }

        return tweets;
    }

    private mergeTweetCandidates(
        mentions: ProcessedTweet[],
        targetTweets: ProcessedTweet[]
    ): ProcessedTweet[] {
        const allCandidates = [...mentions, ...targetTweets];
        const uniqueCandidates = allCandidates
            .filter((tweet, index, self) => self.findIndex((t) => t.id === tweet.id) === index)
            .sort((a, b) => a.id.localeCompare(b.id));

        elizaLogger.log(`Merged ${allCandidates.length} tweets into ${uniqueCandidates.length} unique candidates.`);
        return uniqueCandidates;
    }

    private async processTweetIfNeeded(tweet: ProcessedTweet) {
        if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
            const tweetIdUUID = stringToUuid(tweet.id + "-" + this.runtime.agentId);

            const existingResponse = await this.runtime.messageManager.getMemoryById(tweetIdUUID);
            if (existingResponse) {
                elizaLogger.log(`Tweet ${tweet.id} already processed, skipping.`);
                return;
            }

            const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
            const userIdUUID =
                tweet.authorId === this.client.profile.id
                    ? this.runtime.agentId
                    : stringToUuid(tweet.authorId);

            await this.runtime.ensureConnection(userIdUUID, roomId, tweet.username, tweet.authorName, "twitter");

            const thread = await this.buildConversationThread(tweet, 10);

            const message = {
                content: { text: tweet.text },
                agentId: this.runtime.agentId,
                userId: userIdUUID,
                roomId,
            };

            await this.handleTweet({
                tweet,
                message,
                thread,
            });

            this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: ProcessedTweet;
        message: Memory;
        thread: ProcessedTweet[];
    }) {
        if (tweet.authorId === this.client.profile.id) {
            // console.log("skipping tweet from bot itself", tweet.id);
            // Skip processing if the tweet is from the bot itself
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: ProcessedTweet) => {
            return `  ID: ${tweet.id}
            From: ${tweet.username} (@${tweet.username})
            Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        elizaLogger.debug("Thread: ", thread);
        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        elizaLogger.debug("formattedConversation: ", formattedConversation);

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
            currentPost,
            formattedConversation,
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.authorId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // 1. Get the raw target users string from settings
        const targetUsersStr = this.runtime.getSetting("TWITTER_TARGET_USERS");

        // 2. Process the string to get valid usernames
        const validTargetUsersStr =
            targetUsersStr && targetUsersStr.trim()
                ? targetUsersStr
                      .split(",") // Split by commas: "user1,user2" -> ["user1", "user2"]
                      .map((u) => u.trim()) // Remove whitespace: [" user1 ", "user2 "] -> ["user1", "user2"]
                      .filter((u) => u.length > 0)
                      .join(",")
                : "";

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        elizaLogger.debug("Interactions prompt:\n" + context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const tweet = await this.client.sendTweet(response.text);

                    // Convert the ProcessedTweet into Memory objects
                    const memory: Memory = {
                        id: stringToUuid(tweet.id),
                        userId: stringToUuid(tweet.authorId),
                        roomId: stringToUuid(tweet.conversationId),
                        agentId: this.runtime.agentId,
                        content: { text: tweet.text, url: tweet.permanentUrl },
                        createdAt: tweet.timestamp! * 1000,
                    };

                    return [memory]; // Return as an array of Memory
                };

                const responseMessages = await callback(response);

                state = (await this.runtime.updateRecentMessageState(
                    state
                )) as State;

                for (const responseMessage of responseMessages) {
                    if (
                        responseMessage ===
                        responseMessages[responseMessages.length - 1]
                    ) {
                        responseMessage.content.action = response.action;
                    } else {
                        responseMessage.content.action = "CONTINUE";
                    }
                    await this.runtime.messageManager.createMemory(
                        responseMessage
                    );
                }

                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                await this.runtime.cacheManager.set(
                    `twitter/tweet_generation_${tweet.id}.txt`,
                    responseInfo
                );
                await wait();
            } catch (error) {
                elizaLogger.error(`Error sending response tweet: ${error}`);
            }
        }
    }



    async buildConversationThread(
        tweet: ProcessedTweet,
        maxReplies: number = 10
    ): Promise<ProcessedTweet[]> {
        const thread: ProcessedTweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: ProcessedTweet, depth: number = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const authorId = stringToUuid(currentTweet.authorId);

                await this.runtime.ensureConnection(
                    authorId,
                    roomId,
                    currentTweet.username,
                    currentTweet.username,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.authorId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.authorId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            elizaLogger.debug("Current thread state:", {
                length: thread.length,
                currentDepth: depth,
                tweetId: currentTweet.id,
            });

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        elizaLogger.debug("Final thread built:", {
            totalTweets: thread.length,
            tweetIds: thread.map((t) => ({
                id: t.id,
                text: t.text?.slice(0, 50),
            })),
        });

        return thread;
    }
}
