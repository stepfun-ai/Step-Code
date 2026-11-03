import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	Bm25Ranker,
	createToolSearchDocument,
	createToolSearchToolDefinition,
	DEFAULT_TOOL_SEARCH_LIMIT,
	searchAndLoad,
	type ToolSearchCatalog,
	tokenize,
} from "../src/core/tools/tool-search.ts";
import { createStepToolSearchExtension } from "../src/features/step-tool-search.ts";
import { decideStepToolCall, stepPermissionStateForPreset } from "../src/step/permissions.ts";
import { stepModel } from "./utilities.ts";

function toolInfo(name: string, description: string, parameters = Type.Object({})): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: createSyntheticSourceInfo(`<test:${name}>`, { source: "extension" }),
	};
}

interface FakeCatalog extends ToolSearchCatalog {
	active: string[];
	activations: string[][];
}

function fakeCatalog(tools: ToolInfo[], active: string[]): FakeCatalog {
	const state: FakeCatalog = {
		active,
		activations: [],
		getActiveTools: () => [...state.active],
		getAllTools: () => tools,
		setActiveTools: (names) => {
			state.active = [...names];
			state.activations.push([...names]);
		},
	};
	return state;
}

describe("tool search ranker", () => {
	it("splits identifiers, drops stop words, and folds plurals", () => {
		expect(tokenize("Search the issue_tracker for Issues")).toEqual(["search", "issue", "tracker", "issue"]);
	});

	it("ranks a name match above a description mention", () => {
		const documents = [
			createToolSearchDocument(toolInfo("report", "Reads calendar entries and issues")),
			createToolSearchDocument(toolInfo("issues", "Lists open items")),
		];
		expect(new Bm25Ranker().rank("issue", documents, 2).map((match) => match.name)).toEqual(["issues", "report"]);
	});

	it("ranks an exact name query first", () => {
		const documents = [
			createToolSearchDocument(toolInfo("issue_search", "Searches issues")),
			createToolSearchDocument(toolInfo("search", "Search anything, including issues")),
		];
		expect(new Bm25Ranker().rank("search", documents, 3)[0]?.name).toBe("search");
	});

	it("matches a tool by its suffix after the namespace separator", () => {
		const documents = [createToolSearchDocument(toolInfo("mcp__app__thread_read", "Reads a thread"))];
		expect(new Bm25Ranker().rank("thread_read", documents, 1).map((match) => match.name)).toEqual([
			"mcp__app__thread_read",
		]);
	});

	it("ignores a query made only of stop words", () => {
		const documents = [createToolSearchDocument(toolInfo("issues", "Lists open items"))];
		expect(new Bm25Ranker().rank("the of and", documents, 3)).toEqual([]);
	});
});

describe("searchAndLoad", () => {
	const inactive = toolInfo("issues", "Lists open issues in a repository");
	const active = toolInfo("read", "Reads a file");

	it("activates the matches and keeps the active tools", () => {
		const tools = [active, inactive];
		const catalog = fakeCatalog(tools, ["read"]);
		const found = searchAndLoad(catalog, "open issues", DEFAULT_TOOL_SEARCH_LIMIT);
		expect(found.map((tool) => tool.name)).toEqual(["issues"]);
		expect(found[0]?.description).toBe("Lists open issues in a repository");
		expect(catalog.active).toEqual(["read", "issues"]);
	});

	it("leaves the active set alone when nothing matches", () => {
		const catalog = fakeCatalog([active, inactive], ["read"]);
		expect(searchAndLoad(catalog, "kubernetes", DEFAULT_TOOL_SEARCH_LIMIT)).toEqual([]);
		expect(catalog.activations).toEqual([]);
	});

	it("searches only the tools that are not active yet", () => {
		const catalog = fakeCatalog([active, inactive], ["read", "issues"]);
		expect(searchAndLoad(catalog, "issues", DEFAULT_TOOL_SEARCH_LIMIT)).toEqual([]);
	});
});

describe("tool_search tool", () => {
	it("reports the loaded tools", async () => {
		const catalog = fakeCatalog([toolInfo("issues", "Lists open issues")], []);
		const definition = createToolSearchToolDefinition(catalog);
		const result = await definition.execute("call-1", { query: "issues" });
		expect(result.content).toEqual([
			{ type: "text", text: "Loaded 1 tool. They are available from your next call:\n- issues: Lists open issues" },
		]);
		expect(result.details).toEqual({ loaded: ["issues"] });
	});

	it("reports an empty result without activating anything", async () => {
		const catalog = fakeCatalog([toolInfo("issues", "Lists open issues")], []);
		const result = await createToolSearchToolDefinition(catalog).execute("call-1", { query: "kubernetes" });
		expect(result.content).toEqual([{ type: "text", text: "No matching tools found." }]);
		expect(catalog.activations).toEqual([]);
	});

	it("rejects an empty query and a bad limit", async () => {
		const definition = createToolSearchToolDefinition(fakeCatalog([], []));
		await expect(definition.execute("call-1", { query: "  " })).rejects.toThrow("query must not be empty");
		await expect(definition.execute("call-1", { query: "x", limit: 0 })).rejects.toThrow(
			"limit must be a positive integer",
		);
	});
});

describe("tool_search permissions", () => {
	it("runs without approval because it touches no files", () => {
		const decision = decideStepToolCall("tool_search", { query: "weather" }, stepPermissionStateForPreset("approve-for-me"));
		expect(decision).toMatchObject({ action: "allow", hazardous: false });
	});
});

describe("tool_search session wiring", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(defaultTools?: string[], options: { tools?: string[] } = {}) {
		const settingsManager = SettingsManager.inMemory(defaultTools ? { defaultTools } : {});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [createStepToolSearchExtension()],
		});
		await resourceLoader.reload();
		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: stepModel(),
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				tools: options.tools,
			})
		).session;
	}

	it("registers tool_search without declaring it", async () => {
		const session = await createSession();
		expect(session.getAllTools().map((tool) => tool.name)).toContain("tool_search");
		expect(session.getActiveToolNames()).not.toContain("tool_search");
		expect(session.systemPrompt).not.toContain("- tool_search:");
		session.dispose();
	});

	it("declares tool_search when the tool settings ask for it", async () => {
		const session = await createSession(["read", "bash", "edit", "write", "tool_search"]);
		expect(session.getActiveToolNames()).toContain("tool_search");
		expect(session.systemPrompt).toContain("- tool_search:");
		session.dispose();
	});

	it("declares tool_search when the tool selector names it", async () => {
		const session = await createSession(undefined, { tools: ["read", "tool_search"] });
		expect(session.getActiveToolNames()).toContain("tool_search");
		session.dispose();
	});

	it("keeps tool_search active once a session enables it", async () => {
		const session = await createSession();
		session.setActiveToolsByName(["read", "bash", "edit", "write", "tool_search"]);
		expect(session.getActiveToolNames()).toContain("tool_search");
		session.dispose();
	});
});
