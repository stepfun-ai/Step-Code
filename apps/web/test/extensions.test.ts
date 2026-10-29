import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, SUBAGENT_LANE_CHANNEL, SUBAGENT_RESPONSE_ENTRY, type ExtensionAPI, type ToolDefinition, type SubagentLaneSnapshot } from "@step-harness/coding-agent";
import { projectEntry, webExtensions } from "../src/runtime.ts";

/**
 * The Web host mounts its extensions through `webExtensions`. Losing one is
 * silent: its slash command and tools simply never register, so `/goal` falls
 * through to the model as ordinary text and the session has no `create_goal`.
 * These tests run every factory and assert the surface a Web session promises.
 */

interface Surface {
	commands: Set<string>;
	tools: Set<string>;
}

/** A registration recorder. Unmodelled capabilities are no-ops rather than crashes. */
function api(commands: Set<string>, tools: Set<string>): ExtensionAPI {
	const noop = () => undefined;
	const known: Record<string, unknown> = {
		registerCommand: (name: string) => commands.add(name),
		registerTool: (tool: Pick<ToolDefinition, "name">) => tools.add(tool.name),
		registerFlag: noop,
		on: () => noop,
		getFlag: () => false,
		sendMessage: () => Promise.resolve(),
		sendUserMessage: () => Promise.resolve(),
		appendEntry: noop,
		setSessionName: noop,
		getSessionName: () => undefined,
		setLabel: noop,
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: noop,
		refreshTools: noop,
		getCommands: () => [],
		setModel: () => Promise.resolve(),
		getModel: () => undefined,
		getScopedModels: () => [],
		setThinkingLevel: noop,
		getThinkingLevel: () => undefined,
		// The task extension subscribes to an import channel; a minimal stub must
		// still expose the bus shape rather than a bare no-op function.
		events: { on: () => noop, emit: () => Promise.resolve() },
	};
	return new Proxy(known, {
		get(target, property: string) {
			return property in target ? target[property] : noop;
		},
	}) as unknown as ExtensionAPI;
}

async function mountWeb(): Promise<Surface> {
	const commands = new Set<string>();
	const tools = new Set<string>();
	const settingsManager = {
		getStepSettings: () => ({ permissionPreset: "approve-for-me", nonInteractiveApproval: "deny" }),
		getStepPermissionPreset: () => "approve-for-me",
	} as unknown as Parameters<typeof webExtensions>[0];
	const broker = { captureToolCall: () => {} } as unknown as Parameters<typeof webExtensions>[1];
	const extensionApi = api(commands, tools);
	for (const extension of webExtensions(settingsManager, broker, () => {})) {
		// An inline extension is either a bare factory or a named descriptor.
		const name = typeof extension === "function" ? "<inline>" : extension.name;
		try {
			if (typeof extension === "function") await extension(extensionApi);
			else await extension.factory(extensionApi);
		} catch (error) {
			throw new Error(`extension "${name}" failed to register: ${String(error)}`);
		}
	}
	return { commands, tools };
}

test("the Web host registers the product's session commands", async () => {
	const { commands } = await mountWeb();
	// Each of these is a product promise: a missing entry silently turns the
	// typed command into a model prompt. `/usage` is absent on purpose: it needs a
	// usage host, and this host has no usage panel to render.
	for (const name of [
		"compact",
		"goal",
		"plan",
		"init",
		"permissions",
		"status",
		"mcp",
		"clear",
		"theme",
		"feedback",
		"todos",
		"cron",
		"workflows",
	]) {
		assert.ok(commands.has(name), `/${name} is not registered by the Web host`);
	}
});

test("the Web host registers the goal tools its command drives", async () => {
	const { tools } = await mountWeb();
	for (const name of ["create_goal", "get_goal", "update_goal"]) {
		assert.ok(tools.has(name), `${name} is not registered by the Web host`);
	}
});

test("the Web host does not expose the terminal-only standing switch", async () => {
	const { commands } = await mountWeb();
	// Ultraloop is a per-message opt-in on Web; `/ultraloop on` is the CLI's
	// standing switch, a state the client cannot show or revoke.
	assert.equal(commands.has("ultraloop"), false);
});

test("the Web host subscribes to its own lane bus, not TUI widgets or another session", async () => {
	const settings = { getStepSettings: () => ({}) } as unknown as Parameters<typeof webExtensions>[0];
	const broker = { captureToolCall: () => {} } as unknown as Parameters<typeof webExtensions>[1];
	const bus = createEventBus();
	const other = createEventBus();
	const seen: Array<SubagentLaneSnapshot | null> = [];
	const host = webExtensions(settings, broker, () => {}, undefined, (lane) => seen.push(lane))[0];
	assert.ok(typeof host !== "function");
	await host.factory({ ...api(new Set(), new Set()), events: bus });
	const lane = { laneId: "lane-1", status: "running", details: { agentId: "lane-1", mode: "single", agentScope: "user", userAgentsDir: "/fixture", projectAgentsDir: null, results: [] } };
	other.emit(SUBAGENT_LANE_CHANNEL, lane);
	assert.equal(seen.length, 0);
	bus.emit(SUBAGENT_LANE_CHANNEL, lane);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.laneId, lane.laneId);
	for (const invalid of [null, undefined, {}, { ...lane, details: {} }]) bus.emit(SUBAGENT_LANE_CHANNEL, invalid);
	assert.equal(seen.length, 1, "malformed payloads cannot clear or pollute the cache");
	bus.clear();
	other.clear();
});

test("completed child answers survive the host's journal projection", () => {
	const projected = projectEntry({ type: "custom", customType: SUBAGENT_RESPONSE_ENTRY, id: "result", parentId: null, timestamp: new Date(0).toISOString(), data: { laneId: "lane-1", sessionId: "child-1", taskIndex: 0, output: "completed report" } });
	assert.equal(projected.customType, SUBAGENT_RESPONSE_ENTRY);
	assert.deepEqual(projected.data, { laneId: "lane-1", sessionId: "child-1", taskIndex: 0, output: "completed report" });
});
