import { readStepBuildIdentity } from "../build-identity.ts";

export type FeedbackBuildChannel = "dev" | "release";

export interface FeedbackBuildEnv {
	channel: FeedbackBuildChannel;
	commit?: string;
}

export function readFeedbackBuildEnv(env: NodeJS.ProcessEnv = process.env): FeedbackBuildEnv {
	return readStepBuildIdentity(env);
}
