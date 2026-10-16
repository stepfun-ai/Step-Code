import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { stepModel } from "./utilities.ts";

function tool(name = "restricted_tool"): ToolDefinition {
	return {
		name,
		label: "Local check",
		description: "Run a local check",
		promptSnippet: "Run the restricted local check",
		promptGuidelines: [`Use ${name} for the local check.`],
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

describe("extension-owned tool availability", () => {
	const sessions: AgentSession[] = [];
	const directories: string[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(
		policies: ExtensionFactory[],
		options: { tools?: string[]; excludeTools?: string[]; allowLoadErrors?: boolean } = {},
	) {
		const cwd = mkdtempSync(join(tmpdir(), "step-tool-availability-"));
		directories.push(cwd);
		const agentDir = join(cwd, "agent");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		let registrar!: ExtensionAPI;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					registrar = pi;
					pi.registerTool(tool());
				},
				...policies,
			],
		});
		await resourceLoader.reload();
		if (!options.allowLoadErrors) expect(resourceLoader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: stepModel(),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			tools: options.tools,
			excludeTools: options.excludeTools,
		});
		sessions.push(session);
		await session.bindExtensions({});
		return { session, registrar, resourceLoader };
	}

	function expectUnavailable(session: AgentSession, name = "restricted_tool") {
		expect(session.getActiveToolNames()).not.toContain(name);
		expect(session.getAllTools().map((entry) => entry.name)).not.toContain(name);
		expect(session.agent.state.tools.map((entry) => entry.name)).not.toContain(name);
		expect(session.systemPrompt).not.toContain(`${name}:`);
		expect(session.systemPrompt).not.toContain(`Use ${name} for the local check.`);
	}

	it("filters a load-time declaration from the schema, catalog, and prompt", async () => {
		const { session } = await setup([(pi) => pi.setUnavailableTools(["restricted_tool"])]);
		expectUnavailable(session);
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("combines independent declarations and releases only the caller's restriction", async () => {
		let first!: ExtensionAPI;
		let second!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				first = pi;
			},
			(pi) => {
				second = pi;
			},
		]);
		expect(session.getActiveToolNames()).toContain("restricted_tool");
		first.setUnavailableTools(["restricted_tool"]);
		second.setUnavailableTools(["restricted_tool"]);
		expectUnavailable(session);
		first.setUnavailableTools([]);
		expectUnavailable(session);
		second.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toContain("restricted_tool");
		expect(session.systemPrompt).toContain("restricted_tool:");
	});

	it("does not activate a previously inactive tool when a restriction is released", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				policy = pi;
			},
		]);
		policy.setActiveTools(["read"]);
		policy.setUnavailableTools(["restricted_tool"]);
		policy.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getAllTools().map((entry) => entry.name)).toContain("restricted_tool");
	});

	it("does not reactivate a deselected CLI-allowed tool after availability changes", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup(
			[
				(pi) => {
					policy = pi;
				},
			],
			{ tools: ["read", "restricted_tool"] },
		);
		policy.setActiveTools(["read"]);
		policy.setUnavailableTools(["restricted_tool"]);
		policy.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("preserves an explicit selection made while a tool is unavailable", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				policy = pi;
			},
		]);
		policy.setUnavailableTools(["restricted_tool"]);
		policy.setActiveTools(["restricted_tool"]);
		expect(session.getActiveToolNames()).toEqual([]);
		policy.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toEqual(["restricted_tool"]);
		policy.setUnavailableTools(["restricted_tool"]);
		policy.setActiveTools(["read"]);
		policy.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("applies declarations to tools registered later", async () => {
		let policy!: ExtensionAPI;
		const { session, registrar } = await setup([
			(pi) => {
				policy = pi;
				pi.setUnavailableTools(["late_tool"]);
			},
		]);
		registrar.registerTool(tool("late_tool"));
		expectUnavailable(session, "late_tool");
		policy.setUnavailableTools([]);
		expect(session.getActiveToolNames()).toContain("late_tool");
	});

	it("retains explicit CLI exclusions when extensions release restrictions", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup(
			[
				(pi) => {
					policy = pi;
				},
			],
			{ excludeTools: ["restricted_tool"] },
		);
		policy.setUnavailableTools(["restricted_tool"]);
		policy.setUnavailableTools([]);
		policy.setActiveTools(["read", "restricted_tool"]);
		expectUnavailable(session);
		expect(session.getUnknownToolSelectors().excludeTools).toEqual([]);
	});

	it("does not retain a declaration from an extension that fails to load", async () => {
		const { session, resourceLoader } = await setup(
			[
				(pi) => {
					pi.setUnavailableTools(["restricted_tool"]);
					throw new Error("test load failure");
				},
			],
			{ allowLoadErrors: true },
		);
		expect(resourceLoader.getExtensions().errors).toHaveLength(1);
		expect(resourceLoader.getExtensions().errors[0].error).toContain("test load failure");
		expect(session.getActiveToolNames()).toContain("restricted_tool");
	});

	it("restores a selected tool across reload and rejects the old extension API", async () => {
		let restrict = true;
		let policy!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				policy = pi;
				pi.setUnavailableTools(restrict ? ["write"] : []);
			},
		]);
		const oldPolicy = policy;
		expectUnavailable(session, "write");
		restrict = false;
		await session.reload();
		expect(session.getActiveToolNames()).toContain("write");
		expect(() => oldPolicy.setUnavailableTools(["read"])).toThrow(/stale/i);
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("preserves inactive tools across reload while activating genuinely new registrations", async () => {
		let policy!: ExtensionAPI;
		let restricted = true;
		let addNewTool = false;
		const { session } = await setup([
			(pi) => {
				policy = pi;
				pi.setUnavailableTools(restricted ? ["restricted_tool"] : []);
				if (addNewTool) pi.registerTool(tool("new_tool"));
			},
		]);
		policy.setActiveTools(["read"]);
		restricted = false;
		addNewTool = true;
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "new_tool"]);
		expect(session.getAllTools().map((entry) => entry.name)).toContain("restricted_tool");
	});

	it("copies the declaration and preserves it when invalid updates are rejected", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				policy = pi;
			},
		]);
		const names = ["restricted_tool"];
		policy.setUnavailableTools(names);
		names.length = 0;
		expectUnavailable(session);
		expect(() => policy.setUnavailableTools([""])).toThrow(/nonempty tool names/);
		expectUnavailable(session);
	});

	it("rejects changes from a disposed extension runtime", async () => {
		let policy!: ExtensionAPI;
		const { session } = await setup([
			(pi) => {
				policy = pi;
			},
		]);
		session.dispose();
		expect(() => policy.setUnavailableTools(["read"])).toThrow(/stale/i);
	});
});
