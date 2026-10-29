import fs, { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import process from "node:process";
import lockfile from "proper-lockfile";

const moduleUrl = process.env.MCP_OAUTH_MODULE;
const credentialsPath = process.env.MCP_OAUTH_CREDENTIALS_PATH;
const barrierDir = process.env.MCP_OAUTH_BARRIER_DIR;
const serverName = process.env.MCP_OAUTH_SERVER_NAME;
const serverUrl = process.env.MCP_OAUTH_SERVER_URL;
if (!moduleUrl || !credentialsPath || !barrierDir || !serverName || !serverUrl) {
	throw new Error("Missing MCP OAuth child fixture environment");
}

let armedRound: number | undefined;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = ((...args: unknown[]) => {
	const result: unknown = Reflect.apply(originalReadFileSync, fs, args);
	if (armedRound !== undefined && String(args[0]) === credentialsPath) {
		writeFileSync(join(barrierDir, `read-${serverName}-${armedRound}`), "");
		const releasePath = join(barrierDir, `release-${serverName}-${armedRound}`);
		while (!existsSync(releasePath)) {
			// The parent releases this read only after the competing writer is gated too.
		}
	}
	return result;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();

const originalLock = lockfile.lock;
lockfile.lock = (async (...args: unknown[]) => {
	const release: unknown = await Reflect.apply(originalLock, lockfile, args);
	if (armedRound !== undefined) {
		writeFileSync(join(barrierDir, `lock-${serverName}-${armedRound}`), "");
	}
	return release;
}) as typeof lockfile.lock;

const { createStoredMcpOAuthProvider } = await import(moduleUrl);
const provider = createStoredMcpOAuthProvider(serverName, serverUrl, process.env);

process.on("message", async (message: { type?: string; round?: number; token?: string }) => {
	if (message.type === "exit") {
		process.exit(0);
	}
	if (message.type !== "save" || typeof message.round !== "number" || !message.token) return;
	try {
		armedRound = message.round;
		await provider.saveTokens({ access_token: message.token, token_type: "Bearer" });
		process.send?.({ type: "saved", round: message.round });
	} catch (error) {
		process.send?.({
			type: "save-error",
			round: message.round,
			error: error instanceof Error ? error.stack : String(error),
		});
	} finally {
		armedRound = undefined;
	}
});

process.send?.({ type: "ready", pid: process.pid });
