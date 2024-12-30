import {
    Content,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    State,
    getEmbeddingZeroVector,
    elizaLogger,
    stringToUuid,
} from "@elizaos/core";
import { EventEmitter } from "events";
import { TweetV2, TwitterApi, TwitterApiReadWrite, TweetPublicMetricsV2 } from 'twitter-api-v2';

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

export type TwitterProfile = {
    id: string;
    username: string;
    screenName: string;
    bio: string;
    nicknames: string[];
};

export type ProcessedTweet = {
    id: string;
    text: string;
    authorId: string;
    username: string;
    authorName: string;
    createdAt?: string;
    timestamp?: number;
    conversationId?: string;
    inReplyToStatusId?: string;
    hashtags?: { tag: string }[];
    mentions?: { username: string; id?: string }[];
    urls?: { url: string; expanded_url?: string }[];
    photos?: string[];
    videos?: string[];
    metrics?: TweetPublicMetricsV2;
    permanentUrl?: string;
    thread?: any[]; // Adjust this if threads are implemented
    referenced_tweets?: {
        type: "retweeted" | "quoted" | "replied_to";
        id: string;
    }[];
};

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing: boolean = false;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                console.error("Error processing request:", error);
                this.queue.unshift(request);
                await this.exponentialBackoff(this.queue.length);
            }
            await this.randomDelay();
        }

        this.processing = false;
    }

    private async exponentialBackoff(retryCount: number): Promise<void> {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async randomDelay(): Promise<void> {
        const delay = Math.floor(Math.random() * 2000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}

export class ClientBase extends EventEmitter {
    static _twitterClients: { [accountIdentifier: string]: TwitterApiReadWrite } = {};
    twitterClient: TwitterApiReadWrite;
    runtime: IAgentRuntime;
    directions: string;
    lastCheckedTweetId: bigint | null = null;
    imageDescriptionService: IImageDescriptionService;
    temperature: number = 0.5;

    requestQueue: RequestQueue = new RequestQueue();

    profile: TwitterProfile | null;

    async cacheTweet(tweet: ProcessedTweet): Promise<void> {
        if (!tweet) {
            console.warn("Tweet is undefined, skipping cache");
            return;
        }

        this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
    }

    async getCachedTweet(tweetId: string): Promise<ProcessedTweet | undefined> {
        const cached = await this.runtime.cacheManager.get<ProcessedTweet>(
            `twitter/tweets/${tweetId}`
        );

        return cached;
    }

    async getTweet(tweetId: string): Promise<ProcessedTweet> {
        const cachedTweet = await this.getCachedTweet(tweetId);

        if (cachedTweet) {
            return cachedTweet;
        }

        try {
            const tweetResult = await this.requestQueue.add(() =>
                this.twitterClient.v2.singleTweet(tweetId, {
                    expansions: ['author_id'],
                    'tweet.fields': ['id', 'text', 'created_at', 'author_id', 'public_metrics'],
                })
            );

            const tweet = tweetResult.data;
            const processedTweet = this.convertTweetV2ToProcessedTweet(tweet)
            await this.cacheTweet(processedTweet);
            return processedTweet;
        } catch (error) {
            console.error(`Error fetching tweet with ID ${tweetId}:`, error);
            throw new Error('Failed to fetch the tweet');
        }
    }

    callback: (self: ClientBase) => any = null;

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }

    constructor(runtime: IAgentRuntime) {
        super();
        this.runtime = runtime;
        const username = this.runtime.getSetting("TWITTER_USERNAME");
        if (!username) {
            throw new Error("TWITTER_USERNAME is not configured.");
        }

        if (ClientBase._twitterClients[username]) {
            this.twitterClient = ClientBase._twitterClients[username];
        } else {
            const twitterApi = new TwitterApi({
                appKey: this.runtime.getSetting("TWITTER_API_KEY") || process.env.TWITTER_API_KEY,
                appSecret: this.runtime.getSetting("TWITTER_API_SECRET") || process.env.TWITTER_API_SECRET,
                accessToken: this.runtime.getSetting("TWITTER_ACCESS_TOKEN") || process.env.TWITTER_ACCESS_TOKEN,
                accessSecret: this.runtime.getSetting("TWITTER_ACCESS_SECRET") || process.env.TWITTER_ACCESS_SECRET,
            });

            this.twitterClient = twitterApi.readWrite; // Use readWrite client for full API access
            ClientBase._twitterClients[username] = this.twitterClient;
        }

        this.directions =
            "- " +
            this.runtime.character.style.all.join("\n- ") +
            "- " +
            this.runtime.character.style.post.join();
    }

    async init() {
        const twitterApi = new TwitterApi({
            appKey: this.runtime.getSetting('TWITTER_API_KEY') || process.env.TWITTER_API_KEY,
            appSecret: this.runtime.getSetting('TWITTER_API_SECRET') || process.env.TWITTER_API_SECRET,
            accessToken: this.runtime.getSetting('TWITTER_ACCESS_TOKEN') || process.env.TWITTER_ACCESS_TOKEN,
            accessSecret: this.runtime.getSetting('TWITTER_ACCESS_SECRET') || process.env.TWITTER_ACCESS_SECRET,
        });

        // Verify Twitter API credentials
        try {
            const user = await this.twitterClient.v2.me({
                'user.fields': ['id', 'name', 'username', 'description', 'profile_image_url'],
            });

            const userData = user.data; // Extract the user data from the response
            elizaLogger.info(`Successfully authenticated as ${userData.username}`);

            // Store user profile data in the runtime
            this.profile = {
                id: userData.id,
                username: userData.username,
                screenName: userData.name,
                bio: userData.description,
                nicknames: [], // You can populate this based on other logic
            };

            // Populate runtime character details
            this.runtime.character.twitterProfile = {
                id: this.profile.id,
                username: this.profile.username,
                screenName: this.profile.screenName,
                bio: this.profile.bio,
                nicknames: this.profile.nicknames,
            };
        } catch (error) {
            elizaLogger.error(`Failed to authenticate with Twitter API: ${error.message}`);
            throw new Error('Twitter API authentication failed.');
        }

        // If needed, fetch timeline or other user-specific data
        await this.populateTimeline();
    }

    async fetchOwnPosts(): Promise<ProcessedTweet[]> {
        elizaLogger.debug("fetching own posts");
        if (!this.profile || !this.profile.id) {
            throw new Error("User profile is not loaded. Cannot fetch posts.");
        }
        try {
            const timeline = await this.twitterClient.v2.userTimeline(this.profile.id, {
                exclude: ['replies', 'retweets'], // Exclude replies and retweets
                max_results: 100, // Specify max results if needed
            });

            const tweets = timeline.tweets || []; // Safely access the data property
            const processedTweets: ProcessedTweet[] = tweets?.map((tweet) => this.convertTweetV2ToProcessedTweet(tweet)) || [];
            elizaLogger.info(`Fetched ${tweets.length} tweets from user timeline`);
            return processedTweets
        } catch (error) {
            elizaLogger.error(`Error fetching user timeline: ${error.message}`);
            throw new Error("Failed to fetch user's own posts");
        }
    }

    async fetchTimelineForActions(count: number): Promise<ProcessedTweet[]> {
        elizaLogger.debug("Fetching timeline for actions");

        try {
            // Use Twitter API to fetch the user's home timeline
            const timeline = await this.twitterClient.v2.homeTimeline({
                max_results: count, // Specify the number of tweets to fetch
                expansions: ['author_id', 'attachments.media_keys', 'referenced_tweets.id'], // Optional expansions
                'tweet.fields': [
                    'created_at',
                    'text',
                    'author_id',
                    'conversation_id',
                    'entities',
                    'public_metrics',
                    'attachments',
                ], // Specify tweet fields
                'user.fields': ['name', 'username'], // Specify user fields
            });

            const tweets = timeline.tweets || []; // Extract the tweets data
            elizaLogger.debug(`Fetched ${tweets.length} tweets for actions`);

            // Process and return the tweets in the desired format
            const processedTweets: ProcessedTweet[] = timeline.tweets?.map((tweet) => this.convertTweetV2ToProcessedTweet(tweet)) || [];

            return processedTweets;
        } catch (error) {
            elizaLogger.error(`Failed to fetch timeline for actions: ${error.message}`);
            throw new Error("Error fetching timeline for actions");
        }
    }



    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        cursor?: string
    ): Promise<ProcessedTweet[]> {
        try {
            elizaLogger.debug(`Fetching search tweets with query: "${query}"`);

            const result = await this.twitterClient.v2.search(query, {
                max_results: maxTweets, // Maximum number of tweets to fetch in one request (10–100)
                next_token: cursor, // Optional pagination token
                expansions: ['author_id'], // Optional: expand author information
                'tweet.fields': ['created_at', 'text', 'author_id', 'public_metrics'], // Specify tweet fields
                'user.fields': ['name', 'username'], // Specify user fields
            });

            // Extract and log information
            elizaLogger.info(`Fetched ${result.tweets?.length || 0} tweets`);

            // Process tweets into the desired format
            const processedTweets: ProcessedTweet[] = result.tweets?.map((tweet) => this.convertTweetV2ToProcessedTweet(tweet)) || [];

            return processedTweets;
        } catch (error) {
            elizaLogger.error("Error fetching search tweets:", error);
            return []; // Return empty array on error
        }
    }

    private convertTweetV2ToProcessedTweet(tweet: TweetV2): ProcessedTweet {
        return {
            id: tweet.id,
            text: tweet.text,
            authorId: tweet.author_id!,
            metrics: tweet.public_metrics, // Likes, retweets, etc.
            username: 'Unknown',
            authorName: 'Unknown',
            createdAt: tweet.created_at,
            timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() / 1000 : undefined,
            conversationId: tweet.conversation_id,
            hashtags: tweet.entities?.hashtags || [],
            mentions: tweet.entities?.mentions || [],
            urls: tweet.entities?.urls || [],
            photos: [], // Add logic to process media if needed
            videos: [], // Add logic to process media if needed
            permanentUrl: `https://twitter.com/${'username'}/status/${tweet.id}`, // Replace 'username' dynamically
            inReplyToStatusId: tweet.referenced_tweets?.[0]?.id,
            thread: [], // Populate if needed
            referenced_tweets: tweet.referenced_tweets || [], // Directly map from TweetV2
        };
    }

    private async populateTimeline() {
        elizaLogger.debug("Populating timeline...");

        try {
            const cachedTimeline = await this.getCachedTimeline();

            if (cachedTimeline) {
                elizaLogger.info("Using cached timeline data.");
                await this.processCachedTimeline(cachedTimeline);
                return;
            }

            const newTimeline = await this.fetchHomeTimeline();
            const mentions = await this.fetchMentions(this.profile.id);


            const allTweets = [...newTimeline, ...mentions];
            await this.processAndSaveTweets(allTweets);
        } catch (error) {
            elizaLogger.error("Error populating timeline:", error);
        }
    }

    // Fetch timeline using `twitter-api-v2`
    async fetchHomeTimeline(): Promise<ProcessedTweet[]> {
        elizaLogger.debug("Fetching home timeline...");
        const timeline = await this.twitterClient.v2.homeTimeline({
            max_results: 50,
            expansions: ['author_id'],
            'tweet.fields': ['id', 'text', 'created_at', 'author_id', 'public_metrics'],
        });

        elizaLogger.info(`Fetched ${timeline.tweets.length} tweets from timeline.`);

        const processedTweets: ProcessedTweet[] = timeline.tweets?.map((tweet) => this.convertTweetV2ToProcessedTweet(tweet)) || [];

        return processedTweets;
    }

    // Fetch mentions using `twitter-api-v2`
    private async fetchMentions(userId: string): Promise<ProcessedTweet[]> {
        elizaLogger.debug("Fetching mentions...");

        try {
            // Fetch mentions for the specified user
            const mentions = await this.twitterClient.v2.userMentionTimeline(userId, {
                max_results: 20,
                expansions: ['author_id'],
                'tweet.fields': ['id', 'text', 'created_at', 'author_id', 'public_metrics'],
            });

            elizaLogger.info(`Fetched ${mentions.tweets.length} mentions.`);

            const processedTweets: ProcessedTweet[] = mentions.tweets?.map((tweet) => this.convertTweetV2ToProcessedTweet(tweet)) || [];
            return processedTweets;
        } catch (error) {
            elizaLogger.error("Error fetching mentions:", error);
            throw new Error("Failed to fetch mentions");
        }
    }

    // Process cached timeline
    private async processCachedTimeline(cachedTimeline: ProcessedTweet[]) {
        elizaLogger.debug("Processing cached timeline...");
        const missingTweets = await this.filterMissingTweets(cachedTimeline);
        if (missingTweets.length > 0) {
            await this.processAndSaveTweets(missingTweets);
        }
    }

    // Filter tweets not already in memory
    private async filterMissingTweets(tweets: ProcessedTweet[]): Promise<ProcessedTweet[]> {
        elizaLogger.debug("Filtering missing tweets...");
        const existingMemoryIds = new Set(
            (
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    roomIds: tweets.map((tweet) =>
                        stringToUuid(tweet.id + "-" + this.runtime.agentId)
                    ),
                })
            ).map((memory) => memory.id.toString())
        );

        return tweets.filter(
            (tweet) => !existingMemoryIds.has(stringToUuid(tweet.id + "-" + this.runtime.agentId))
        );
    }

    // Process and save new tweets
    private async processAndSaveTweets(tweets: ProcessedTweet[]) {
        for (const tweet of tweets) {
            await this.saveTweetAsMemory(tweet);
        }
    }

    // Save a single tweet as memory
    private async saveTweetAsMemory(tweet: ProcessedTweet) {
        const roomId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const userId = stringToUuid(tweet.authorId);
        const content: Content = {
            text: tweet.text,
            url: `https://twitter.com/${tweet.authorId}/status/${tweet.id}`,
            source: "twitter",
        };

        await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: new Date(tweet.createdAt).getTime(),
        });

        elizaLogger.info(`Saved tweet ${tweet.id} as memory.`);
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                elizaLogger.debug("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: getEmbeddingZeroVector(),
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }

    async loadLatestCheckedTweetId(): Promise<void> {
        const latestCheckedTweetId =
            await this.runtime.cacheManager.get<string>(
                `twitter/${this.profile.username}/latest_checked_tweet_id`
            );

        if (latestCheckedTweetId) {
            this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
        }
    }

    async cacheLatestCheckedTweetId() {
        if (this.lastCheckedTweetId) {
            await this.runtime.cacheManager.set(
                `twitter/${this.profile.username}/latest_checked_tweet_id`,
                this.lastCheckedTweetId.toString()
            );
        }
    }

    private async getCachedTimeline(): Promise<ProcessedTweet[] | undefined> {
        return await this.runtime.cacheManager.get<ProcessedTweet[]>(
            `twitter/${this.profile.username}/timeline`
        );
    }

    async cacheTimeline(timeline: ProcessedTweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile.username}/timeline`,
            timeline,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async cacheMentions(mentions: ProcessedTweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile.username}/mentions`,
            mentions,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async getCachedCookies(username: string) {
        return await this.runtime.cacheManager.get<any[]>(
            `twitter/${username}/cookies`
        );
    }

    async cacheCookies(username: string, cookies: any[]) {
        await this.runtime.cacheManager.set(
            `twitter/${username}/cookies`,
            cookies
        );
    }

    async getCachedProfile(username: string) {
        return await this.runtime.cacheManager.get<TwitterProfile>(
            `twitter/${username}/profile`
        );
    }

    async cacheProfile(profile: TwitterProfile) {
        await this.runtime.cacheManager.set(
            `twitter/${profile.username}/profile`,
            profile
        );
    }

    async fetchProfile(twitterApi: TwitterApi, username: string): Promise<TwitterProfile> {
        const cached = await this.getCachedProfile(username);

        if (cached) return cached;

        try {
            // Fetch user profile using the v2 API
            const user = await twitterApi.v2.userByUsername(username, {
                'user.fields': ['id', 'name', 'username', 'description'],
            });

            // Map the result to the TwitterProfile structure
            const profile: TwitterProfile = {
                id: user.data.id,
                username: user.data.username,
                screenName: user.data.name,
                bio: user.data.description || '',
                nicknames: [], // Populate this based on your application logic
            };

            // Cache the profile for future use
            await this.cacheProfile(profile);

            return profile;
        } catch (error) {
            console.error("Error fetching Twitter profile:", error);
            throw new Error('Failed to fetch Twitter profile');
        }
    }

    async sendTweet(
        content: string,
        replyToTweetId?: string,
        options?: { mediaIds?: string[] }
    ): Promise<ProcessedTweet> {
        const params: any = { text: content };

        if (options?.mediaIds?.length) {
            params.media = { media_ids: options.mediaIds };
        }
        if (replyToTweetId) {
            params.reply = { in_reply_to_tweet_id: replyToTweetId };
        }

        const response = await this.twitterClient.v2.tweet(params);

        // Construct a valid TweetV2 object by adding missing properties
        const tweetData: TweetV2 = {
            ...response.data,
            edit_history_tweet_ids: [response.data.id],
        };

        return this.convertTweetV2ToProcessedTweet(tweetData);
    }

    async likeTweet(tweetId: string): Promise<void> {
        try {
            await this.twitterClient.v2.like(this.profile.id, tweetId);
            console.log(`Liked tweet with ID: ${tweetId}`);
        } catch (error) {
            console.error(`Error liking tweet ${tweetId}:`, error);
            throw error;
        }
    }

    async unlikeTweet(tweetId: string): Promise<void> {
        try {
            await this.twitterClient.v2.unlike(this.profile.id, tweetId);
            console.log(`Unliked tweet with ID: ${tweetId}`);
        } catch (error) {
            console.error(`Error unliking tweet ${tweetId}:`, error);
            throw error;
        }
    }

    async retweetTweet(tweetId: string): Promise<void> {
        try {
            await this.twitterClient.v2.retweet(this.profile.id, tweetId);
            console.log(`Retweeted tweet with ID: ${tweetId}`);
        } catch (error) {
            console.error(`Error retweeting tweet ${tweetId}:`, error);
            throw error;
        }
    }

    async unretweetTweet(tweetId: string): Promise<void> {
        try {
            await this.twitterClient.v2.unretweet(this.profile.id, tweetId);
            console.log(`Unretweeted tweet with ID: ${tweetId}`);
        } catch (error) {
            console.error(`Error unretweeting tweet ${tweetId}:`, error);
            throw error;
        }
    }

    async quoteTweet(content: string, tweetId: string): Promise<void> {
        try {
            await this.twitterClient.v2.tweet(content, {
                quote_tweet_id: tweetId,
            });
            console.log(`Quoted tweet with ID: ${tweetId}`);
        } catch (error) {
            console.error(`Error quoting tweet ${tweetId}:`, error);
            throw error;
        }
    }
}
