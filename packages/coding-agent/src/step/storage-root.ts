import { join } from "node:path";
import { resolveStepConfigDir, resolveStepHomeDir } from "./environment.ts";

/** Resolve the shared Step storage root used by product-owned state. */
export function resolveStepStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.STEP_CLI_STORAGE_ROOT_DIR?.trim() ||
		env.STEPCLI_STORAGE_ROOT_DIR?.trim() ||
		join(resolveStepHomeDir(env), resolveStepConfigDir(env))
	);
}
