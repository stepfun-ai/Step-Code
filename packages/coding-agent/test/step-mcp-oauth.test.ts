import { type ChildProcess, spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildOAuthClientMetadata,
	createStoredMcpOAuthProvider,
	hasStoredMcpOAuthCredential,
	loginMcpServer,
	logoutMcpServer,
	resolveOAuthCallback,
} from "../src/step/mcp-oauth.ts";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: authMock }));

function sink(): { calls: string[]; resolve(code: string): void; reject(error: Error): void } {
	const calls: string[] = [];
	return {
		calls,
		resolve: (code) => calls.push(`resolve:${code}`),
		reject: (error) => calls.push(`reject:${error.message}`),
	};
}

function callbackUrl(query: string, path = "/callback"): URL {
	return new URL(`${path}${query}`, "http://127.0.0.1");
}

function waitForChildMessage(child: ChildProcess, type: string, round?: number, timeoutMs = 10000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${type} from child ${child.pid}`));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
		};
		const onMessage = (message: { type?: string; round?: number; error?: string }) => {
			if (message.type === "save-error") {
				cleanup();
				reject(new Error(message.error));
				return;
			}
			if (message.type !== type || (round !== undefined && message.round !== round)) return;
			cleanup();
			resolve();
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(new Error(`Child ${child.pid} exited early: code=${code}, signal=${signal}`));
		};
		child.on("message", onMessage);
		child.on("exit", onExit);
	});
}

describe("MCP OAuth callback", () => {
	it("ignores any path other than the callback path", () => {
		const target = sink();

		expect(resolveOAuthCallback(callbackUrl("?code=abc&state=s", "/"), "s", target)).toEqual({
			status: 404,
			body: "Not found",
		});
		expect(target.calls).toEqual([]);
	});

	it("refuses a callback whose state is missing or forged", () => {
		// A page in another tab can reach the loopback port. Without this check it
		// could hand us an authorization code minted for a different client.
		const target = sink();

		expect(resolveOAuthCallback(callbackUrl("?code=abc"), "expected", target).status).toBe(400);
		expect(resolveOAuthCallback(callbackUrl("?code=abc&state=other"), "expected", target)).toEqual({
			status: 400,
			body: "Invalid OAuth state",
		});
		// A prefix must not pass either: the comparison is length-checked first.
		expect(resolveOAuthCallback(callbackUrl("?code=abc&state=expect"), "expected", target).status).toBe(400);
		expect(target.calls).toEqual([]);
	});

	it("reports an authorization error and a missing code separately", () => {
		const denied = sink();
		expect(resolveOAuthCallback(callbackUrl("?error=access_denied&state=s"), "s", denied)).toEqual({
			status: 400,
			body: "Authorization failed",
		});
		expect(denied.calls).toEqual(["reject:OAuth authorization failed: access_denied"]);

		const empty = sink();
		expect(resolveOAuthCallback(callbackUrl("?state=s"), "s", empty)).toEqual({
			status: 400,
			body: "Missing authorization code",
		});
		expect(empty.calls).toEqual([]);
	});

	it("accepts the authorization code when the state matches", () => {
		const target = sink();

		expect(resolveOAuthCallback(callbackUrl("?code=abc&state=s"), "s", target).status).toBe(200);
		expect(target.calls).toEqual(["resolve:abc"]);
	});
});

describe("MCP OAuth client metadata", () => {
	it("declares the configured scopes so registration requests them too", () => {
		expect(buildOAuthClientMetadata("http://127.0.0.1:1/callback", { scopes: ["read", " ", "write"] })).toMatchObject(
			{
				redirect_uris: ["http://127.0.0.1:1/callback"],
				scope: "read write",
				token_endpoint_auth_method: "none",
			},
		);
	});

	it("omits the scope entirely when none are configured", () => {
		expect(buildOAuthClientMetadata("http://127.0.0.1:1/callback", {})).not.toHaveProperty("scope");
		expect(buildOAuthClientMetadata("http://127.0.0.1:1/callback", { scopes: [" "] })).not.toHaveProperty("scope");
	});

	it("switches the auth method when a client secret is configured", () => {
		expect(buildOAuthClientMetadata("http://127.0.0.1:1/callback", { client_secret: "s" })).toMatchObject({
			token_endpoint_auth_method: "client_secret_post",
		});
	});
});

describe("MCP OAuth login", () => {
	it("fails by name when the declared callback port is unavailable", async () => {
		// A provider that only accepts a pre-registered redirect URI would reject
		// a silently relocated listener, so the taken port has to surface here.
		const occupied = createServer(() => undefined);
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
		const address = occupied.address();
		if (!address || typeof address === "string") throw new Error("no port");

		try {
			await expect(
				loginMcpServer("demo", "https://example.invalid/mcp", { callback_port: address.port }),
			).rejects.toThrow(`Could not open OAuth callback port ${address.port} for 'demo'`);
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});
});

describe("MCP OAuth credential storage", () => {
	const roots: string[] = [];

	function makeEnv(): { env: NodeJS.ProcessEnv; configRoot: string } {
		const root = join(process.cwd(), `test-step-mcp-oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const configRoot = join(root, ".stepcode");
		mkdirSync(configRoot, { recursive: true });
		roots.push(root);
		return { env: { HOME: root, STEP_CODING_AGENT_DIR: join(configRoot, "agent") }, configRoot };
	}

	afterEach(() => {
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
		authMock.mockReset();
		vi.restoreAllMocks();
	});

	it("stores credentials beside the config, not inside an injected agent directory", async () => {
		const { env, configRoot } = makeEnv();
		const provider = createStoredMcpOAuthProvider("demo", "https://example.invalid/mcp", env);

		await provider.saveTokens({ access_token: "token", token_type: "Bearer" });

		const path = join(configRoot, ".credentials.json");
		expect(existsSync(path)).toBe(true);
		expect(existsSync(join(configRoot, "agent", ".credentials.json"))).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			"demo|https://example.invalid/mcp": { serverName: "demo", tokens: { access_token: "token" } },
		});
		expect(hasStoredMcpOAuthCredential("demo", "https://example.invalid/mcp", env)).toBe(true);

		expect(logoutMcpServer("demo", "https://example.invalid/mcp", env)).toBe(true);
		expect(logoutMcpServer("demo", "https://example.invalid/mcp", env)).toBe(false);
		expect(hasStoredMcpOAuthCredential("demo", "https://example.invalid/mcp", env)).toBe(false);
	});

	it("persists interactive login tokens through the credential store lock", async () => {
		const { env, configRoot } = makeEnv();
		const lockSpy = vi.spyOn(lockfile, "lock");
		authMock.mockImplementation(
			async (provider: {
				saveTokens(tokens: { access_token: string; token_type: string }): void | Promise<void>;
			}) => {
				await provider.saveTokens({ access_token: "login-token", token_type: "Bearer" });
				return "AUTHORIZED";
			},
		);

		await loginMcpServer("demo", "https://example.invalid/mcp", {}, env);

		expect(lockSpy).toHaveBeenCalledWith(join(configRoot, ".credentials.json"), {
			realpath: false,
			retries: 0,
			stale: 60_000,
		});
		expect(JSON.parse(readFileSync(join(configRoot, ".credentials.json"), "utf8"))).toMatchObject({
			"demo|https://example.invalid/mcp": { tokens: { access_token: "login-token" } },
		});
	});

	it("fails closed when the credential store lock cannot be acquired", async () => {
		const { env, configRoot } = makeEnv();
		const path = join(configRoot, ".credentials.json");
		writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o600 });
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			throw Object.assign(new Error("locked"), { code: "ELOCKED" });
		});
		const startedAt = Date.now();
		let now = startedAt;
		vi.spyOn(Date, "now").mockImplementation(() => {
			now += 1000;
			return now;
		});
		const provider = createStoredMcpOAuthProvider("demo", "https://example.invalid/mcp", env);

		await expect(provider.saveTokens({ access_token: "blocked", token_type: "Bearer" })).rejects.toThrow("locked");
		expect(now - startedAt).toBeGreaterThanOrEqual(30_000);
		expect(lockSpy.mock.calls.length).toBeGreaterThan(1);
		expect(readFileSync(path, "utf8")).toBe("{}\n");
	});

	it("cleans up a failed publication and releases the credential store lock", async () => {
		const { env, configRoot } = makeEnv();
		const path = join(configRoot, ".credentials.json");
		const original = '{"version":1}\n';
		writeFileSync(path, original, { encoding: "utf8", mode: 0o600 });
		const provider = createStoredMcpOAuthProvider("demo", "https://example.invalid/mcp", env);
		const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw new Error("rename blocked");
		});
		syncBuiltinESMExports();

		try {
			await expect(provider.saveTokens({ access_token: "new-token", token_type: "Bearer" })).rejects.toThrow(
				"rename blocked",
			);
		} finally {
			renameSpy.mockRestore();
			syncBuiltinESMExports();
		}

		expect(readFileSync(path, "utf8")).toBe(original);
		expect(readdirSync(configRoot).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

		await provider.saveTokens({ access_token: "after-error", token_type: "Bearer" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			"demo|https://example.invalid/mcp": { tokens: { access_token: "after-error" } },
		});
	});

	it("does not steal a live lock while the holder is blocked in synchronous I/O", async () => {
		const { env, configRoot } = makeEnv();
		const path = join(configRoot, ".credentials.json");
		writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o600 });
		const childScript = join(process.cwd(), "test", "fixtures", "mcp-oauth-lock-holder-child.ts");
		const child = spawn(process.execPath, ["--import", "tsx", childScript], {
			cwd: process.cwd(),
			env: {
				...process.env,
				...env,
				MCP_OAUTH_CREDENTIALS_PATH: path,
				MCP_OAUTH_SERVER_NAME: "server-a",
				MCP_OAUTH_SERVER_URL: "https://server-a.example.invalid/mcp",
			},
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});

		try {
			await waitForChildMessage(child, "ready");
			const provider = createStoredMcpOAuthProvider("server-b", "https://server-b.example.invalid/mcp", env);
			const saving = provider.saveTokens({ access_token: "token-server-b", token_type: "Bearer" });
			child.send({ type: "write", holdMs: 11_000 });
			await Promise.all([saving, waitForChildMessage(child, "released", undefined, 15000)]);

			const store = JSON.parse(readFileSync(path, "utf8"));
			expect(store["server-a|https://server-a.example.invalid/mcp"]?.tokens?.access_token).toBe("token-server-a");
			expect(store["server-b|https://server-b.example.invalid/mcp"]?.tokens?.access_token).toBe("token-server-b");
		} finally {
			const exited = new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
			child.kill();
			await exited;
		}
	}, 20000);

	it("preserves concurrent token saves from separate processes", async () => {
		const { env, configRoot } = makeEnv();
		const path = join(configRoot, ".credentials.json");
		writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o600 });
		const moduleUrl = pathToFileURL(join(process.cwd(), "src", "step", "mcp-oauth.ts")).href;
		const childScript = join(process.cwd(), "test", "fixtures", "mcp-oauth-save-tokens-child.ts");
		const servers = [
			{ name: "server-a", url: "https://server-a.example.invalid/mcp" },
			{ name: "server-b", url: "https://server-b.example.invalid/mcp" },
		];
		const children = servers.map((server) =>
			spawn(process.execPath, ["--import", "tsx", childScript], {
				cwd: process.cwd(),
				env: {
					...process.env,
					...env,
					MCP_OAUTH_MODULE: moduleUrl,
					MCP_OAUTH_CREDENTIALS_PATH: path,
					MCP_OAUTH_BARRIER_DIR: configRoot,
					MCP_OAUTH_SERVER_NAME: server.name,
					MCP_OAUTH_SERVER_URL: server.url,
				},
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			}),
		);

		try {
			await Promise.all(children.map((child) => waitForChildMessage(child, "ready")));
			const round = 1;
			const saved = children.map((child) => waitForChildMessage(child, "saved", round));
			children.forEach((child, index) => {
				child.send({ type: "save", round, token: `token-${servers[index].name}` });
			});

			const readMarkers = servers.map((server) => join(configRoot, `read-${server.name}-${round}`));
			const releaseMarkers = servers.map((server) => join(configRoot, `release-${server.name}-${round}`));
			const lockMarkers = servers.map((server) => join(configRoot, `lock-${server.name}-${round}`));
			const released = new Set<number>();
			const deadline = Date.now() + 10000;
			while (released.size < servers.length) {
				const allReadersGated = readMarkers.every((marker) => existsSync(marker));
				for (let index = 0; index < servers.length; index += 1) {
					if (released.has(index) || !existsSync(readMarkers[index])) continue;
					// Without a lock, release only after both processes hold the same old snapshot.
					// With a lock, this reader owns it and must finish before its peer can read.
					if (allReadersGated || existsSync(lockMarkers[index])) {
						writeFileSync(releaseMarkers[index], "");
						released.add(index);
					}
				}
				if (released.size < servers.length) {
					if (Date.now() > deadline) throw new Error("Timed out gating concurrent credential writes");
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			}
			await Promise.all(saved);

			const store = JSON.parse(readFileSync(path, "utf8"));
			for (const server of servers) {
				expect(store[`${server.name}|${server.url}`]?.tokens?.access_token).toBe(`token-${server.name}`);
			}
		} finally {
			const exited = children.map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) resolve();
						else child.once("exit", () => resolve());
					}),
			);
			for (const child of children) child.kill();
			await Promise.all(exited);
		}
	}, 20000);
});
