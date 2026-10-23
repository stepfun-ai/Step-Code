/** A private `node` fallback for children of the Electron-hosted web server. */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { NodeExecutable } from "./server-host.ts";

/**
 * StepPage's installer and launcher invoke `node` by name. Electron bundles
 * Node, but is not named `node`, and MCP children do not inherit its Node-mode
 * flag. Keep that flag in a private wrapper rather than widening MCP's env.
 * Append the directory so a user's system Node still takes precedence.
 */
export async function addBundledNodeToPath(input: {
	readonly environment: NodeJS.ProcessEnv;
	readonly node: NodeExecutable;
	readonly directory: string;
	readonly platform?: NodeJS.Platform;
}): Promise<NodeJS.ProcessEnv> {
	if (!input.node.electron || (input.platform ?? process.platform) === "win32") return input.environment;

	await mkdir(input.directory, { recursive: true, mode: 0o700 });
	const temporary = join(input.directory, `.node-${randomUUID()}`);
	const command = `'${input.node.command.replace(/'/gu, "'\\''")}'`;
	try {
		await writeFile(temporary, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${command} "$@"\n`, {
			flag: "wx",
			mode: 0o700,
		});
		// Refresh the path after an app move/update without truncating a wrapper
		// that a concurrent child is about to execute.
		await rename(temporary, join(input.directory, "node"));
	} finally {
		// A failed write/rename must retain its original error; only our temporary
		// file is removed, and an existing working wrapper stays in place.
		await rm(temporary, { force: true }).catch(() => undefined);
	}

	const entries = (input.environment.PATH ?? "/usr/bin:/bin").split(delimiter);
	if (!entries.includes(input.directory)) entries.push(input.directory);
	return { ...input.environment, PATH: entries.join(delimiter) };
}
