import { readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";
import lockfile from "proper-lockfile";

const path = process.env.MCP_OAUTH_CREDENTIALS_PATH;
const serverName = process.env.MCP_OAUTH_SERVER_NAME;
const serverUrl = process.env.MCP_OAUTH_SERVER_URL;
if (!path || !serverName || !serverUrl) throw new Error("Missing MCP OAuth lock holder environment");

const release = await lockfile.lock(path, { realpath: false, stale: 60_000 });
process.send?.({ type: "ready", pid: process.pid });

process.on("message", async (message: { type?: string; holdMs?: number }) => {
	if (message.type !== "write" || typeof message.holdMs !== "number") return;
	try {
		const started = Date.now();
		while (Date.now() - started < message.holdMs) {
			// Simulate a slow synchronous read-modify-write that blocks lock heartbeat.
		}
		const store = JSON.parse(readFileSync(path, "utf8"));
		store[`${serverName}|${serverUrl}`] = {
			serverName,
			serverUrl,
			tokens: { access_token: `token-${serverName}`, token_type: "Bearer" },
		};
		const temporary = `${path}.${process.pid}.holder.tmp`;
		writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
		process.send?.({ type: "released" });
	} catch (error) {
		process.send?.({ type: "save-error", error: error instanceof Error ? error.stack : String(error) });
	} finally {
		await release();
	}
});
