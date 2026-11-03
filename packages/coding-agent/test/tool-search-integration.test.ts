import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@step-harness/providers/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

/** A plugin tool the model never sees until `find_tools` loads it. */
function deferredTool(name: string, description: string) {
	return {
		name,
		label: name,
		description,
		exposure: "deferred" as const,
		parameters: Type.Object({ query: Type.String() }),
		async execute(_toolCallId: string) {
			return { content: [{ type: "text" as const, text: `${name} ran` }], details: {} };
		},
	};
}

describe("find_tools over a real model turn", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-find-tools-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		faux?.unregister();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(extensionFactories: InlineExtension[]) {
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
		const settingsManager = SettingsManager.inMemory({});
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

	it("declares the loaded tool on the next request", async () => {
		const declared: string[][] = [];
		const toolResultTexts: string[] = [];
		const session = await createSession([
			(pi) => {
				pi.registerTool(deferredTool("issue_search", "Lists open issues in a repository"));
				pi.registerTool(deferredTool("calendar_read", "Reads calendar entries"));
				pi.on("tool_result", (event) => {
					toolResultTexts.push(event.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
				});
			},
		]);
		faux.setResponses([
			(context) => {
				declared.push((context.tools ?? []).map((tool: { name: string }) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("find_tools", { query: "open issues" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				declared.push((context.tools ?? []).map((tool: { name: string }) => tool.name).sort());
				return fauxAssistantMessage("done");
			},
		]);

		await session.prompt("list the open issues");

		// First request: the deferred tools are registered but not declared.
		expect(declared[0]).toContain("find_tools");
		expect(declared[0]).not.toContain("issue_search");
		expect(declared[0]).not.toContain("calendar_read");
		// Second request: the loaded tool is declared, the unrelated one still is not.
		expect(declared[1]).toContain("issue_search");
		expect(declared[1]).not.toContain("calendar_read");
		expect(toolResultTexts.join("\n")).toContain("Newly available from your next call: issue_search");
		expect(toolResultTexts.join("\n")).toContain("1. issue_search");
	});

	it("records the loaded tools as an active-tool change on the tool result", async () => {
		const addedToolNames: string[][] = [];
		const session = await createSession([
			(pi) => pi.registerTool(deferredTool("issue_search", "Lists open issues in a repository")),
		]);
		faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("find_tools", { query: "open issues" }), { stopReason: "toolUse" }),
			(context) => {
				addedToolNames.push(
					context.messages
						.filter((message) => message.role === "toolResult")
						.flatMap((message) => message.addedToolNames ?? []),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await session.prompt("list the open issues");

		expect(addedToolNames).toEqual([["issue_search"]]);
	});
});
