import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildOAuthClientMetadata,
	createStoredMcpOAuthProvider,
	hasStoredMcpOAuthCredential,
	loginMcpServer,
	logoutMcpServer,
	resolveOAuthCallback,
} from "../src/step/mcp-oauth.ts";

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
	});

	it("stores credentials beside the config, not inside an injected agent directory", () => {
		const { env, configRoot } = makeEnv();
		const provider = createStoredMcpOAuthProvider("demo", "https://example.invalid/mcp", env);

		provider.saveTokens({ access_token: "token", token_type: "Bearer" });

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
});
