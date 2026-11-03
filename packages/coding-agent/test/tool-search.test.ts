import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InlineExtension, ToolInfo } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	Bm25Ranker,
	createToolSearchDocument,
	DEFAULT_TOOL_SEARCH_LIMIT,
	searchAndLoad,
	type ToolSearchCatalog,
	tokenize,
} from "../src/core/tools/tool-search.ts";
import { decideStepToolCall, stepPermissionStateForPreset } from "../src/step/permissions.ts";
import { stepModel } from "./utilities.ts";

function toolInfo(
	name: string,
	description: string,
	exposure: ToolInfo["exposure"] = "deferred",
	parameters = Type.Object({}),
): ToolInfo {
	return {
		name,
		description,
		parameters,
		exposure,
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
	const active = toolInfo("read", "Reads a file", "direct");

	it("activates the matches and keeps the active tools", () => {
		const catalog = fakeCatalog([active, inactive], ["read"]);
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

	it("skips a direct or hidden tool", () => {
		const direct = toolInfo("issues_direct", "Lists open issues directly", "direct");
		const hidden = toolInfo("issues_hidden", "Lists open issues secretly", "hidden");
		const catalog = fakeCatalog([direct, hidden], []);
		expect(searchAndLoad(catalog, "issues", DEFAULT_TOOL_SEARCH_LIMIT)).toEqual([]);
	});
});

describe("find_tools permissions", () => {
	it("runs without approval because it touches no files", () => {
		const decision = decideStepToolCall(
			"find_tools",
			{ query: "weather" },
			stepPermissionStateForPreset("approve-for-me"),
		);
		expect(decision).toMatchObject({ action: "allow", hazardous: false });
	});
});

describe("exposure and the session tool set", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-exposure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(factories: InlineExtension[] = []) {
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: factories,
		});
		await resourceLoader.reload();
		const session = (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: stepModel(),
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
			})
		).session;
		await session.bindExtensions({});
		return session;
	}

	function pluginTool(name: string, exposure: "direct" | "deferred" | "hidden") {
		return {
			name,
			label: name,
			description: `${name} plugin tool`,
			exposure,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		};
	}

	it("leaves a hidden tool out of the catalog", async () => {
		const session = await createSession([(pi) => void pi.registerTool(pluginTool("secret_tool", "hidden"))]);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("secret_tool");
		expect(session.getActiveToolNames()).not.toContain("secret_tool");
		session.dispose();
	});

	it("keeps a deferred tool registered but undeclared", async () => {
		const session = await createSession([(pi) => void pi.registerTool(pluginTool("plugin_tool", "deferred"))]);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("plugin_tool");
		expect(session.getActiveToolNames()).not.toContain("plugin_tool");
		session.dispose();
	});

	it("declares a direct tool like any other", async () => {
		const session = await createSession([(pi) => void pi.registerTool(pluginTool("direct_tool", "direct"))]);
		expect(session.getActiveToolNames()).toContain("direct_tool");
		session.dispose();
	});

	it("activates a deferred tool the settings name", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "plugin_tool"] });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [(pi) => void pi.registerTool(pluginTool("plugin_tool", "deferred"))],
		});
		await resourceLoader.reload();
		const session = (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: stepModel(),
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
			})
		).session;
		await session.bindExtensions({});
		expect(session.getActiveToolNames()).toContain("plugin_tool");
		session.dispose();
	});
});
