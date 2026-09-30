/**
 * The credential store is keyed by `<name>|<url>`, and the two sides must agree
 * on `name`: `step mcp login` writes the key, the MCP connection reads it. A
 * plugin's servers are published as `<pluginId>__<serverName>`, so a login that
 * stored the user's bare input would report success and then fail the same way
 * on the next start. This file exists separately from `mcp-startup.test.ts`
 * because that file mocks the credential reader out entirely.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveStepMcpServer } from "./mcp.ts";
import { hasStoredMcpOAuthCredential } from "./mcp-oauth.ts";

const pluginMocks = vi.hoisted(() => ({ dirs: [] as string[], manifests: new Map<string, unknown>() }));
vi.mock("./plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	listStepPluginDirectories: async () => pluginMocks.dirs,
	readStepPluginManifest: async (dir: string) => ({ manifest: pluginMocks.manifests.get(dir), errors: [] }),
	ensureBuiltinPluginsInstalled: async () => ({ installed: [], warnings: [] }),
	provisionBuiltinPlugin: async () => undefined,
}));
vi.mock("./config-toml.ts", () => ({ readGlobalStepConfig: () => ({}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	pluginMocks.dirs = [];
	pluginMocks.manifests.clear();
});

test("login and the runtime agree on the credential key", async () => {
	// Credentials sit beside config.toml: the parent of the agent directory.
	const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), "cred-")));
	cleanups.push(async () => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, STEP_CODING_AGENT_DIR: join(root, "agent") };
	await mkdir(join(root, "agent"), { recursive: true });

	const dir = "/mock-plugins/context7";
	pluginMocks.dirs = [dir];
	pluginMocks.manifests.set(dir, {
		id: "context7",
		mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } },
	});

	// The CLI is handed this resolved name; passing the user's bare input instead
	// would write a key the connection never reads.
	const resolved = await resolveStepMcpServer("context7");
	expect(resolved?.name).toBe("context7__context7");

	const url = "https://mcp.context7.com/mcp";
	const write = (key: string) =>
		writeFile(
			join(root, ".credentials.json"),
			JSON.stringify({ [key]: { serverName: key, serverUrl: url, tokens: { access_token: "t" } } }),
		);

	// The bare-name key is what a login using the user's input stores, and the
	// runtime never looks it up.
	await write(`context7|${url}`);
	expect(hasStoredMcpOAuthCredential("context7__context7", url, env)).toBe(false);

	// The published key is what both sides use after the fix.
	await write(`context7__context7|${url}`);
	expect(hasStoredMcpOAuthCredential("context7__context7", url, env)).toBe(true);
});
