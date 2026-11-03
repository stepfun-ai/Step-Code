import { readStepBuildIdentity } from "../build-identity.ts";

export type FeedbackBuildChannel = "dev" | "release";

export interface FeedbackBuildEnv {
	channel: FeedbackBuildChannel;
	commit?: string;
	/** ISO timestamp of the artifact, when the release pipeline embedded one. */
	buildTime?: string;
}

export function readFeedbackBuildEnv(env: NodeJS.ProcessEnv = process.env): FeedbackBuildEnv {
	return readStepBuildIdentity(env);
}
