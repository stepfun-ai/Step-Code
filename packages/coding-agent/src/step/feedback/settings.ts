import type { StepSettings } from "../settings-manager.ts";

export const STEPCODE_DISABLE_FEEDBACK_ENV_NAMES = ["STEPCODE_DISABLE_FEEDBACK"] as const;

export type FeedbackDisabledReason = "env-opt-out" | "config-opt-out";

export interface ResolvedFeedbackSettings {
	enabled: boolean;
	reason?: FeedbackDisabledReason;
}

function readEnvFlag(value: string | undefined): boolean {
	return value !== undefined && /^(?:1|true|yes|on)$/iu.test(value.trim());
}

/** Environment opt-out wins over the persisted Step setting. */
export function resolveFeedbackSettings(input: {
	env?: NodeJS.ProcessEnv;
	settings?: Pick<StepSettings, "feedbackEnabled">;
}): ResolvedFeedbackSettings {
	const env = input.env ?? process.env;
	if (STEPCODE_DISABLE_FEEDBACK_ENV_NAMES.some((name) => readEnvFlag(env[name]))) {
		return { enabled: false, reason: "env-opt-out" };
	}
	if (input.settings?.feedbackEnabled === false) {
		return { enabled: false, reason: "config-opt-out" };
	}
	return { enabled: true };
}
