import { type AgentSessionRuntimeHost, StepStdioHost } from "@step-harness/coding-agent";
import type { RawStdoutWrite } from "#bootstrap/stdout-capture";

/**
 * --sdk-stdio: length-prefixed framed stdio host.
 *
 * Source of truth for the framing is coding-agent's step/stdio.ts (codec) and
 * step/stdio-host.ts (host). The shell only decides *when* to run it and hands
 * it the original stdout byte writer captured before any redirection, so frames
 * are never corrupted by diagnostics. This is distinct from --mode rpc, which
 * uses newline-delimited JSONL framing (see ./rpc.ts).
 */
export interface SdkStdioModeOptions {
	/** Original stdout byte writer captured by bootstrap step 1. */
	writeFrame: RawStdoutWrite;
	/** Terminate the process with the host-requested exit code. */
	onExitRequested?: (code: number) => void;
}

/**
 * Build the framed stdio-host factory passed to pi's main() as
 * `stdioModeFactory`. pi creates the runtime, then hands the runtime host here.
 */
export function createSdkStdioMode(
	options: SdkStdioModeOptions,
): (runtimeHost: AgentSessionRuntimeHost) => Promise<void> {
	const onExitRequested = options.onExitRequested ?? ((code: number) => process.exit(code));
	return async (runtimeHost: AgentSessionRuntimeHost) => {
		const host = new StepStdioHost({
			runtimeHost,
			writeFrame: options.writeFrame,
			onExitRequested,
		});
		await host.run();
	};
}
