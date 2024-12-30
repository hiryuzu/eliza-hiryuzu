import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

export const DEFAULT_MAX_TWEET_LENGTH = 280;

export const twitterEnvSchema = z.object({
    TWITTER_DRY_RUN: z
        .string()
        .transform((val) => val.toLowerCase() === "true"),
        TWITTER_API_KEY: z.string().min(1).max(50, "Twitter API Key seems invalid"),
    TWITTER_API_SECRET: z.string().min(1, "Twitter API Secret is required"),
    TWITTER_ACCESS_TOKEN: z.string().min(1, "Twitter Access Token is required"),
    TWITTER_ACCESS_SECRET: z.string().min(1, "Twitter Access Secret is required"),
    MAX_TWEET_LENGTH: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default(DEFAULT_MAX_TWEET_LENGTH.toString()),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

export async function validateTwitterConfig(
    runtime: IAgentRuntime
): Promise<TwitterConfig> {
    try {
        const twitterConfig = {
            TWITTER_DRY_RUN:
                runtime.getSetting("TWITTER_DRY_RUN") ||
                process.env.TWITTER_DRY_RUN ||
                "false",
            TWITTER_API_KEY: process.env.TWITTER_API_KEY,
            TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
            TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
            TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET,
            MAX_TWEET_LENGTH:
                runtime.getSetting("MAX_TWEET_LENGTH") ||
                process.env.MAX_TWEET_LENGTH ||
                DEFAULT_MAX_TWEET_LENGTH.toString(),
        };

        return twitterEnvSchema.parse(twitterConfig);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Twitter configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
