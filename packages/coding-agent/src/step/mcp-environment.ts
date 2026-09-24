/**
 * Environment resolution shared by the MCP runtime and the plugin doctor.
 *
 * It lives apart from `./mcp.ts` because `mcp.ts` imports `./plugins.ts`, so a
 * plugin-side import of the runtime resolver would close a module cycle. Both
 * sides must answer "does this server have a credential?" the same way: a
 * doctor with its own rule reports a plugin as broken while the server it
 * describes starts fine.
 */

import { readStoredCredential } from "../core/auth-storage.ts";
import { getStepAuthPath } from "./auth.ts";

/**
 * The variables a Step login can supply on its own, so callers can tell a user
 * whose only gap is `/login` apart from one who has to configure a variable
 * StepCode knows nothing about.
 */
export const STEP_LOGIN_SUPPLIED_ENV: readonly string[] = ["STEPFUN_API_KEY"];

/** Resolve the environment passed to a plugin server, including Step login fallback. */
export function resolveStepMcpEnvironment(
	declared: Record<string, string> | undefined,
	input: { env?: NodeJS.ProcessEnv; authPath?: string } = {},
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.env ?? process.env)) if (value !== undefined) resolved[key] = value;
	Object.assign(resolved, declared ?? {});
	if (!resolved.STEPFUN_API_KEY?.trim()) {
		const credential = readStoredCredential("step", input.authPath ?? getStepAuthPath());
		if (credential?.type === "oauth" && typeof credential.access === "string" && credential.access.trim()) {
			resolved.STEPFUN_API_KEY = credential.access;
		}
		if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
			resolved.STEPFUN_API_KEY = credential.key;
		}
	}
	return resolved;
}
