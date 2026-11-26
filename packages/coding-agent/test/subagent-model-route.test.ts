import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@step-harness/providers";
import { validateToolArguments } from "@step-harness/providers";
import { describe, expect, it, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { listModelsText } from "../src/features/step-models-catalog.ts";
import { createStepSubagentExtension, type StepSubagentRunInput } from "../src/features/step-subagent.ts";
import { prepareSubagentRun } from "../src/features/subagent/execute.ts";
import {
	matchCatalogRoute,
	parseSubagentModelRoute,
	type SubagentModelRoute,
	sameSubagentRoute,
	subagentRouteKey,
} from "../src/features/subagent/model-route.ts";
import { createSubagentRpcSession } from "../src/features/subagent/rpc-adapter.ts";

const parent: SubagentModelRoute = { provider: "step", model: "step-5-preview" };
const cheap: SubagentModelRoute = { provider: "step", model: "step-3.5-flash" };

/** Minimal catalog entries; only the fields the tools read. */
function model(provider: string, id: string, extra: Partial<Model<any>> = {}): Model<any> {
	return {
		id,
		name: extra.name ?? id,
		provider,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: extra.reasoning ?? false,
		input: extra.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		...extra,
	} as Model<any>;
}

const catalog = [model("step", parent.model), model("step", cheap.model), model("other", "other-chat")];

describe("parseSubagentModelRoute", () => {
	it("reads provider/modelId into both halves", () => {
		expect(parseSubagentModelRoute("step/step-3.5-flash", parent)).toEqual(cheap);
	});

	it("resolves a bare id against the parent's provider", () => {
		expect(parseSubagentModelRoute("step-3.5-flash", parent)).toEqual(cheap);
	});

	it("trims surrounding whitespace", () => {
		expect(parseSubagentModelRoute("  step/step-3.5-flash  ", parent)).toEqual(cheap);
	});

	it("rejects an unusable value", () => {
		for (const value of ["", "   ", "/", "step/", "/model"]) {
			expect(parseSubagentModelRoute(value, parent)).toBeUndefined();
		}
	});

	it("cannot resolve a bare id without a parent provider", () => {
		expect(parseSubagentModelRoute("step-3.5-flash")).toBeUndefined();
	});
});

describe("route identity", () => {
	it("separates provider and model so neither can bleed into the other", () => {
		expect(subagentRouteKey({ provider: "a/b", model: "c" })).not.toBe(
			subagentRouteKey({ provider: "a", model: "b/c" }),
		);
	});

	it("folds case, because the CLI's --model resolver does", () => {
		expect(sameSubagentRoute({ provider: "Step", model: "STEP-3.5-FLASH" }, cheap)).toBe(true);
	});
});

describe("matchCatalogRoute", () => {
	it("returns the catalog spelling of an exact match", () => {
		expect(matchCatalogRoute({ provider: "STEP", model: "Step-3.5-Flash" }, catalog)).toEqual({
			ok: true,
			route: cheap,
		});
	});

	it("names the candidates when the model id is wrong", () => {
		const result = matchCatalogRoute({ provider: "step", model: "step-9" }, catalog);
		expect(result?.ok).toBe(false);
		if (result?.ok === false) {
			expect(result.reason).toContain('no model "step-9" on provider "step"');
			expect(result.reason).toContain("step/step-3.5-flash");
		}
	});

	it("names the providers when the provider is unknown", () => {
		const result = matchCatalogRoute({ provider: "nope", model: "x" }, catalog);
		expect(result?.ok).toBe(false);
		if (result?.ok === false) expect(result.reason).toContain("providers in this session: other, step");
	});

	it("returns undefined for an empty catalog, leaving the CLI as the authority", () => {
		expect(matchCatalogRoute(cheap, [])).toBeUndefined();
	});
});

describe("listModelsText", () => {
	it("lists every model and puts the session's own provider first", () => {
		const text = listModelsText(catalog, {}, "step");
		expect(text).toContain("3 models available");
		expect(text.indexOf("step/step-5-preview")).toBeLessThan(text.indexOf("other/other-chat"));
	});

	it("filters by provider", () => {
		const text = listModelsText(catalog, { provider: "other" }, "step");
		expect(text).toContain("other/other-chat");
		expect(text).not.toContain("step/step-5-preview");
	});

	it("filters by free-text query", () => {
		const text = listModelsText(catalog, { query: "flash" }, "step");
		expect(text).toContain("step/step-3.5-flash");
		expect(text).not.toContain("other/other-chat");
	});

	it("says how to recover when nothing matches", () => {
		const text = listModelsText(catalog, { provider: "nope" }, "step");
		expect(text).toContain('No model matches provider "nope"');
		expect(text).toContain("Providers in this session: other, step");
	});

	it("never returns an empty answer for an empty catalog", () => {
		expect(listModelsText([], {}, undefined)).toContain("no models are available");
	});
});

function registeredTools(subagentOptions: Record<string, unknown> = {}): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	createStepSubagentExtension(subagentOptions)(api);
	return tools;
}

function validate(tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>): unknown {
	const tool = tools.get(name);
	if (!tool) throw new Error(`${name} was not registered`);
	return validateToolArguments(
		{ name, parameters: tool.parameters } as never,
		{
			name,
			arguments: args,
		} as never,
	);
}

describe("subagent schema", () => {
	it("always offers `model` on the call, on tasks and on chain", () => {
		// No configuration gate: any model the session can run is selectable.
		const tools = registeredTools();
		expect(validate(tools, "subagent", { agent: "general", task: "x", model: "step/step-3.5-flash" })).toMatchObject({
			model: "step/step-3.5-flash",
		});
		expect(
			validate(tools, "subagent", { tasks: [{ agent: "general", task: "x", model: cheap.model }] }),
		).toMatchObject({ tasks: [{ model: cheap.model }] });
		expect(
			validate(tools, "subagent", { chain: [{ agent: "general", task: "x", model: cheap.model }] }),
		).toMatchObject({ chain: [{ model: cheap.model }] });
	});

	it("points the caller at the models tool instead of pasting a catalog", () => {
		const tools = registeredTools();
		const subagent = tools.get("subagent");
		const parameters = JSON.stringify(subagent?.parameters);
		expect(parameters).toContain("Do not guess the ID");
		expect(parameters).toContain("`models` tool");
		expect(parameters).toContain("Omit to inherit this session's model");
		// A catalog in the description would be the largest, most volatile part of
		// the cached prefix; it belongs in a tool result.
		expect(parameters).not.toContain("step-3.5-flash");
	});

	it("keeps the description to what a caller needs before choosing", () => {
		// Three copies of this text sit in one schema (call, tasks item, chain item),
		// so anything that only pays off when a call is actually refused is dead
		// weight: that answer arrives as a tool error, which is not in the prefix.
		// The provider hint lives in the `models` tool's own parameter description.
		const tools = registeredTools();
		const parameters = JSON.stringify(tools.get("subagent")?.parameters ?? {});
		expect(parameters).not.toContain("is refused before the child starts");
		expect(parameters).not.toContain("filtering to your own provider first");
	});

	it("keeps the model description within a fixed size budget", () => {
		// A guard, not a target: the schema repeats this string three times, and the
		// cost is paid once per session in the cached prompt prefix. Growth here is
		// easy to miss because it arrives as prose.
		const tools = registeredTools();
		const properties = (tools.get("subagent")?.parameters as { properties: Record<string, { description?: string }> })
			.properties;
		expect(properties.model?.description?.length ?? 0).toBeLessThanOrEqual(200);
	});

	it("keeps the tool set at exactly subagent and agent_send", () => {
		expect([...registeredTools().keys()].sort()).toEqual(["agent_send", "subagent"]);
	});
});

/** Preflight with a context that carries the catalog. */
async function prepare(
	cwd: string,
	params: Record<string, unknown>,
	models: readonly Model<any>[] = catalog,
	parentModel: { provider: string; id: string } | undefined = { provider: parent.provider, id: parent.model },
) {
	const ctx = {
		cwd,
		model: parentModel,
		modelRegistry: { getAvailable: () => [...models] },
	} as unknown as ExtensionContext;
	return prepareSubagentRun(params as never, ctx, {
		agentDir: cwd,
		configDirName: ".stepcode-test",
		includeBuiltinAgents: true,
		maxParallelTasks: 8,
		maxConcurrency: 1,
		runner: async () => {
			throw new Error("preflight must not start a child");
		},
		worktreeManager: {
			allocate: async () => {
				throw new Error("preflight must not allocate a worktree");
			},
		},
	} as never);
}

describe("subagent route preflight", () => {
	it("rejects a malformed explicit model", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			for (const value of ["", "   ", "/", "step/", "/model"]) {
				const result = await prepare(cwd, { agent: "general", task: "inspect", model: value });
				expect(result.ok).toBe(false);
				if (!result.ok) expect(JSON.stringify(result.result.content)).toContain("invalid model");
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("canonicalizes a bare id and records the authorized route", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			const result = await prepare(cwd, { agent: "general", task: "inspect", model: cheap.model });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.run.tasks[0].model).toBe(`${cheap.provider}/${cheap.model}`);
				expect(result.run.tasks[0].authorizedRoute).toEqual(cheap);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("fixes the case of a model id from the catalog", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			const result = await prepare(cwd, { agent: "general", task: "inspect", model: "STEP/Step-3.5-Flash" });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.run.tasks[0].model).toBe("step/step-3.5-flash");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("refuses a model the session cannot run, naming what it can", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			const result = await prepare(cwd, { agent: "general", task: "inspect", model: "step/step-9" });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const text = result.result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
				expect(text).toContain('no model "step-9" on provider "step"');
				expect(text).toContain("step/step-3.5-flash");
				expect(text).toContain("models tool");
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("leaves an unparsable host catalog out of the decision", async () => {
		// No catalog (embedded host, or no credentials yet): the CLI stays the
		// authority, so a syntactically valid route is forwarded rather than refused.
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			const result = await prepare(cwd, { agent: "general", task: "inspect", model: "x/y" }, []);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.run.tasks[0].model).toBe("x/y");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("lets an explicit model outrank the definition's default", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			await writePinnedAgent(cwd);
			const result = await prepare(cwd, { agent: "custom", task: "inspect", model: parent.model });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.run.tasks[0].model).toBe(`${parent.provider}/${parent.model}`);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps a pinned definition working untouched when the call names no model", async () => {
		// The definition's `model` is host configuration that predates this
		// parameter, and the CLI resolves it (fuzzy ids included). Preflight must not
		// rewrite or refuse it.
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-"));
		try {
			await writePinnedAgent(cwd);
			const result = await prepare(cwd, { agent: "custom", task: "inspect" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.run.tasks[0].model).toBeUndefined();
				expect(result.run.discovery.agents.find((agent) => agent.name === "custom")?.model).toBe(cheap.model);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

async function writePinnedAgent(cwd: string): Promise<void> {
	await mkdir(path.join(cwd, "agents"), { recursive: true });
	await writeFile(
		path.join(cwd, "agents", "custom.md"),
		`---\nname: custom\ndescription: Inspect code\nmodel: ${cheap.model}\n---\nInspect.`,
	);
}

it.each(["match", "mismatch", "exit", "abort"] as const)(
	"checks the child's actual route before sending its prompt (%s)",
	async (mode) => {
		const cwd = await mkdtemp(path.join(tmpdir(), "subagent-model-rpc-"));
		const script = path.join(cwd, "child.mjs");
		const promptLog = path.join(cwd, "prompts.txt");
		const originalArgv = process.argv;
		const originalExecArgv = process.execArgv;
		let session: Awaited<ReturnType<typeof createSubagentRpcSession>> | undefined;
		try {
			await writeFile(promptLog, "");
			await writeFile(
				script,
				`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    if (${JSON.stringify(mode)} === "exit") process.exit(0);
    console.log(JSON.stringify({ type: "response", id: command.id, success: true,
      data: { model: { provider: ${JSON.stringify(mode === "mismatch" ? "other" : cheap.provider)}, id: ${JSON.stringify(cheap.model)} } } }));
  } else if (command.type === "prompt") {
    appendFileSync(${JSON.stringify(promptLog)}, command.message);
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
`,
			);
			process.argv = [process.execPath, script];
			process.execArgv = [];
			const controller = new AbortController();
			const input: StepSubagentRunInput = {
				agent: { name: "general", description: "test", source: "builtin", systemPrompt: "" },
				task: "inspect",
				cwd,
				model: `${cheap.provider}/${cheap.model}`,
				expectedModelRoute: cheap,
				signal: controller.signal,
				keepAlive: mode === "abort",
			};
			session = await createSubagentRpcSession(input, path.basename(cwd));
			const pending = session.runTurn(input);
			if (mode === "abort") controller.abort();
			const result = await pending;
			session.stop();
			await session.exited;
			expect(await readFile(promptLog, "utf8")).toBe(mode === "match" ? "inspect" : "");
			if (mode === "abort") expect(result.stopReason).toBe("aborted");
			else expect(result.exitCode).toBe(mode === "match" ? 0 : 1);
			if (mode === "mismatch") expect(result.errorMessage).toContain("it resolved to other/step-3.5-flash");
		} finally {
			process.argv = originalArgv;
			process.execArgv = originalExecArgv;
			session?.terminate();
			await session?.exited;
			await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
	},
);

test("a background lane reply keeps the model it was launched with", async () => {
	const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
	const api = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		on: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getFlag: () => false,
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		model: { provider: parent.provider, id: parent.model },
		modelRegistry: { getAvailable: () => [...catalog] },
		thinkingLevel: "high",
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: { confirm: async () => true, notify: () => {}, setWidget: () => {} },
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	const models: Array<string | undefined> = [];
	createStepSubagentExtension({
		includeBuiltinAgents: true,
		agentDir: "/tmp/step-agent-test",
		runner: async (input) => {
			models.push(input.agent.model ?? input.model);
			return {
				messages: [],
				stderr: "",
				exitCode: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				startedAt: Date.now(),
				updatedAt: Date.now(),
			} as never;
		},
	})(api);

	const subagent = tools.get("subagent");
	const agentSend = tools.get("agent_send");
	if (!subagent || !agentSend) throw new Error("tools were not registered");
	await subagent.execute(
		"call-1" as never,
		{ agent: "general", task: "first", model: "step/step-3.5-flash", run_in_background: true } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
	const status = (await agentSend.execute(
		"call-2" as never,
		{ action: "status" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	)) as { content: Array<{ text: string }> };
	const laneId = /lane_[\w-]+/.exec(status.content.map((part) => part.text).join(" "))?.[0];
	if (!laneId) throw new Error("lane id was not reported");
	// The stub runner leaves no live child, so this reply respawns the lane from
	// the params recorded at launch — the path that used to drop the model.
	await agentSend.execute(
		"call-3" as never,
		{ action: "reply", lane_id: laneId, message: "second" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(models[0]).toBe("step/step-3.5-flash");
	expect(models.at(-1)).toBe("step/step-3.5-flash");
});

test("the models tool answers from the live catalog", async () => {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	const { createStepModelsExtension } = await import("../src/features/step-models.ts");
	createStepModelsExtension()(api);
	const tool = tools.get("models");
	if (!tool) throw new Error("models tool was not registered");
	const ctx = {
		model: { provider: "step", id: parent.model },
		modelRegistry: { getAvailable: () => [...catalog] },
	} as unknown as ExtensionContext;
	const result = (await tool.execute("call", { provider: "step" }, undefined, undefined, ctx)) as {
		content: Array<{ text: string }>;
	};
	const text = result.content.map((part) => part.text).join("\n");
	expect(text).toContain("step/step-3.5-flash");
	expect(text).not.toContain("other/other-chat");
});
