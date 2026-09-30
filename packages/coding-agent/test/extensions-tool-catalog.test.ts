import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepToolProfile, stepToolNames } from "../src/step/tool-profile.ts";
import { createTestExtensionsResult, createTestResourceLoader, stepModel } from "./utilities.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function definition(name: string, description = name) {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: description }], details: {} }),
	} satisfies ToolDefinition;
}

async function setup(factories: ExtensionFactory[], stepProfile = false) {
	const cwd = await mkdtemp(join(tmpdir(), "extension-catalog-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const extensionsResult = await createTestExtensionsResult(factories, cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		model: stepModel(),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		...(stepProfile ? { customTools: createStepToolProfile(cwd) } : {}),
	});
	cleanups.push(() => session.dispose());
	await session.bindExtensions({});
	if (stepProfile) session.setActiveToolsByName([...stepToolNames]);
	return { session, ...extensionsResult };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

test("a replacement batch removes only its owner's tools and refreshes the session once", async () => {
	let owner!: ExtensionAPI;
	const { session, runtime, extensions } = await setup([
		(pi) => {
			owner = pi;
			pi.registerTools([definition("keep", "old"), definition("remove")]);
		},
		(pi) => {
			pi.registerTool(definition("other"));
		},
	]);
	const refresh = vi.fn(runtime.refreshTools);
	runtime.refreshTools = refresh;
	owner.registerTools([definition("keep", "updated"), definition("add")], { remove: ["remove", "other", "read"] });
	expect([...extensions[0].tools.keys()].sort()).toEqual(["add", "keep"]);
	expect(extensions[1].tools.has("other")).toBe(true);
	expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["keep", "add", "other", "read"]));
	expect(session.getActiveToolNames()).not.toContain("remove");
	expect(session.getAllTools().find((tool) => tool.name === "keep")?.description).toBe("updated");
	expect(refresh).toHaveBeenCalledTimes(1);
});

test("removing the winning extension registration reveals the next extension overlay", async () => {
	let first!: ExtensionAPI;
	let second!: ExtensionAPI;
	const { session, runtime } = await setup([
		(pi) => {
			first = pi;
			pi.registerTool(definition("shared", "first"));
		},
		(pi) => {
			second = pi;
			pi.registerTool(definition("shared", "second"));
		},
	]);
	expect(session.getAllTools().find((tool) => tool.name === "shared")?.description).toBe("first");
	const refresh = vi.fn(runtime.refreshTools);
	runtime.refreshTools = refresh;
	first.registerTools([], { remove: ["shared"] });
	expect(session.getAllTools().find((tool) => tool.name === "shared")?.description).toBe("second");
	expect(session.getActiveToolNames()).toContain("shared");
	const callable = session.agent.state.tools.find((tool) => tool.name === "shared")!;
	expect(resultText(await callable.execute("overlay", {}))).toBe("second");
	expect(refresh).toHaveBeenCalledTimes(1);
	second.registerTools([], { remove: ["shared"] });
	expect(session.getAllTools().some((tool) => tool.name === "shared")).toBe(false);
	expect(session.getActiveToolNames()).not.toContain("shared");
});

test("removing a shadowed registration leaves the current winner active", async () => {
	let shadowed!: ExtensionAPI;
	const { session, extensions } = await setup([
		(pi) => pi.registerTool(definition("shared", "winner")),
		(pi) => {
			shadowed = pi;
			pi.registerTool(definition("shared", "shadowed"));
		},
	]);
	shadowed.registerTools([], { remove: ["shared"] });
	expect(extensions[1].tools.has("shared")).toBe(false);
	expect(session.getAllTools().find((tool) => tool.name === "shared")?.description).toBe("winner");
	expect(session.getActiveToolNames()).toContain("shared");
});

test("removal can reveal a builtin override without removing another owner's definition", async () => {
	let owner!: ExtensionAPI;
	const { session } = await setup([
		(pi) => {
			owner = pi;
			pi.registerTool(definition("read", "overridden"));
		},
	]);
	expect(session.getAllTools().find((tool) => tool.name === "read")?.description).toBe("overridden");
	owner.registerTools([], { remove: ["read"] });
	expect(session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source).toBe("builtin");
	expect(session.getActiveToolNames()).toContain("read");
});

test("empty or non-owned removals do not refresh, and stale runtimes cannot remove tools", async () => {
	let owner!: ExtensionAPI;
	const { runtime, extensions } = await setup([
		(pi) => {
			owner = pi;
			pi.registerTool(definition("owned"));
		},
	]);
	const refresh = vi.fn(runtime.refreshTools);
	runtime.refreshTools = refresh;
	owner.registerTools([], { remove: ["missing", "read"] });
	owner.registerTools([], { remove: [] });
	expect(refresh).not.toHaveBeenCalled();
	runtime.invalidate();
	expect(() => owner.registerTools([], { remove: ["owned"] })).toThrow(/stale/);
	expect(extensions[0].tools.has("owned")).toBe(true);
});

test("the optional context catalog accessor reads active tools live and rejects stale contexts", async () => {
	let api!: ExtensionAPI;
	let ctx!: ExtensionContext;
	const { session, runtime } = await setup([
		(pi) => {
			api = pi;
			pi.on("session_start", (_event, context) => {
				ctx = context;
			});
		},
	]);
	expect(typeof ctx.getToolCatalog).toBe("function");
	expect(ctx.getToolCatalog!().map((tool) => tool.name)).toContain("read");
	api.registerTool(definition("late", "late catalog entry"));
	expect(ctx.getToolCatalog!()).toContainEqual(
		expect.objectContaining({ name: "late", description: "late catalog entry" }),
	);
	session.setActiveToolsByName(["read"]);
	expect(ctx.getToolCatalog!().map((tool) => tool.name)).toEqual(["read"]);
	runtime.invalidate();
	expect(() => ctx.getToolCatalog!()).toThrow(/stale/);
});

test("find_tools discovers late tools, callable schemas, and updated descriptions through a real session", async () => {
	let api!: ExtensionAPI;
	const { session } = await setup(
		[
			(pi) => {
				api = pi;
			},
		],
		true,
	);
	const find = session.agent.state.tools.find((tool) => tool.name === "find_tools")!;
	expect(resultText(await find.execute("before", { query: "calendar" }))).toBe("(no matching tools)");
	const parameters = Type.Object({ calendar_id: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1 })) });
	api.registerTool({ ...definition("plugin__calendar", "Query calendar events"), parameters });
	const discovered = resultText(await find.execute("after", { query: "calendar_id" }));
	expect(discovered).toContain("plugin__calendar");
	expect(discovered).toContain("Query calendar events");
	expect(discovered).toContain(JSON.stringify(parameters));
	api.registerTool({
		...definition("plugin__calendar", "Query revised calendar events"),
		parameters: Type.Object({ date: Type.String() }),
	});
	const updated = resultText(await find.execute("updated", { query: "calendar" }));
	expect(updated).toContain("Query revised calendar events");
	expect(updated).toContain('"date"');
	expect(updated).not.toContain("calendar_id");
});

test("find_tools excludes inactive and removed tools without falling back to captured builtins", async () => {
	let api!: ExtensionAPI;
	const { session } = await setup(
		[
			(pi) => {
				api = pi;
			},
		],
		true,
	);
	api.registerTool(definition("plugin__calendar", "Query calendar events"));
	const find = session.agent.state.tools.find((tool) => tool.name === "find_tools")!;
	session.setActiveToolsByName(["find_tools"]);
	expect(resultText(await find.execute("inactive", { query: "calendar" }))).toBe("(no matching tools)");
	expect(resultText(await find.execute("builtin-inactive", { query: "read_file" }))).toBe("(no matching tools)");
	session.setActiveToolsByName(["find_tools", "plugin__calendar"]);
	expect(resultText(await find.execute("active", { query: "calendar" }))).toContain("plugin__calendar");
	api.registerTools([], { remove: ["plugin__calendar"] });
	expect(resultText(await find.execute("removed", { query: "calendar" }))).toBe("(no matching tools)");
});
