import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@step-harness/providers/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { StepConfigDocument } from "../src/step/config-toml.ts";
import { createStepMcpExtension } from "../src/step/mcp.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

const config = vi.hoisted(() => ({ value: {} as StepConfigDocument }));
vi.mock("../src/step/config-toml.ts", () => ({ readGlobalStepConfig: () => config.value }));
vi.mock("../src/step/plugins.ts", () => ({
	defaultStepPluginsDir: () => "/unused-test-plugins",
	ensureBuiltinPluginsInstalled: async () => ({ installed: [], warnings: [] }),
	listStepPluginDirectories: async () => [],
	provisionInstallCommand: () => undefined,
	readStepPluginManifest: async () => ({ manifest: undefined, errors: [] }),
}));
vi.mock("../src/step/steppage-provision.ts", () => ({
	ensureStepPageReady: async () => ({ command: undefined }),
	isManagedStepPageCommand: () => false,
}));
vi.mock("../src/step/mcp-oauth.ts", () => ({ hasStoredMcpOAuthCredential: () => false }));

/** A one-tool MCP server over streamable HTTP: handshake, list, and one call. */
async function mcpServer() {
	const calls: Array<Record<string, unknown>> = [];
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as {
			id?: number;
			method: string;
			params?: { name?: string; arguments?: Record<string, unknown> };
		};
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "tickets", version: "1" },
			};
		} else if (message.method === "tools/list") {
			result = {
				tools: [
					{
						name: "search_tickets",
						description: "Searches support tickets by text.",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string", description: "Text to search for" } },
							required: ["text"],
						},
					},
				],
			};
		} else {
			calls.push(message.params?.arguments ?? {});
			result = { content: [{ type: "text", text: `ticket about ${message.params?.arguments?.text ?? ""}` }] };
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		calls,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("MCP tools behind tool_search", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		config.value = {};
		tempDir = join(tmpdir(), `pi-tool-search-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		faux?.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(extensionFactories: InlineExtension[], defaultTools?: string[]) {
		faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const settingsManager = SettingsManager.inMemory(defaultTools ? { defaultTools } : {});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			extensionFactories,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			// The Step profile supplies `find_tools` and turns the native built-ins off.
			customTools: createStepToolProfile(tempDir),
			noTools: "builtin",
		});
		await session.bindExtensions({});
		cleanups.push(() => session.dispose());
		return session;
	}

	it("finds an MCP tool the model cannot see, then calls it", async () => {
		const server = await mcpServer();
		cleanups.push(server.close);
		config.value = { mcp_servers: { tickets: { url: server.url, description: "Support tickets" } } };

		const session = await createSession([createStepMcpExtension()]);
		const declared: string[][] = [];
		const prompts: string[] = [];
		faux.setResponses([
			(context) => {
				declared.push((context.tools ?? []).map((tool: { name: string }) => tool.name).sort());
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("find_tools", { query: "search support tickets" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				declared.push((context.tools ?? []).map((tool: { name: string }) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("tickets__search_tickets", { text: "login fails" }), {
					stopReason: "toolUse",
				});
			},
			() => fauxAssistantMessage("done"),
		]);

		await session.prompt("find the ticket about the login failure");

		// The server's tools stay undeclared until `find_tools` loads them.
		expect(declared[0]).toContain("find_tools");
		expect(declared[0]?.some((name) => name.startsWith("tickets__"))).toBe(false);
		// The prompt names the server so the model knows to search.
		expect(prompts[0]).toContain("# MCP servers");
		expect(prompts[0]).toContain("- tickets: Support tickets (1 tool)");
		// The next request declares the loaded tool, which the model then calls.
		expect(declared[1]).toContain("tickets__search_tickets");
		expect(server.calls).toEqual([{ text: "login fails" }]);
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("declares a server's tools directly when its declaration says so", async () => {
		const server = await mcpServer();
		cleanups.push(server.close);
		config.value = { mcp_servers: { tickets: { url: server.url, exposure: "direct" } } };

		const session = await createSession([createStepMcpExtension()]);
		const declared: string[][] = [];
		faux.setResponses([
			(context) => {
				declared.push((context.tools ?? []).map((tool: { name: string }) => tool.name).sort());
				return fauxAssistantMessage("done");
			},
		]);

		await session.prompt("hello");

		expect(declared[0]).toContain("tickets__search_tickets");
		// No deferred server, so the prompt carries no server section.
		expect(session.systemPrompt).not.toContain("# MCP servers");
	});
});
