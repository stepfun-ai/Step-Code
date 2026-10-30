import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import type { ToolOrigin } from "../src/core/extensions/types.ts";
import { createStepExtension } from "../src/features/step.ts";
import { createStepCapabilitiesExtension } from "../src/features/step-capabilities.ts";
import { decideStepToolCall, type StepPermissionState, stepPermissionStateForPreset } from "../src/step/permissions.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const hazardousWorkflowScript = "const cleanup = `rm -rf ./tmp/cache`;";

const ordinaryWorkflowScript = [
	"const findings = [];",
	"for (const item of args.items) {",
	"  findings.push(await agent(item));",
	"}",
	"return findings;",
].join("\n");

function decideWithOrigin(
	toolName: string,
	input: Record<string, unknown>,
	origin: ToolOrigin | undefined,
	state: StepPermissionState = stepPermissionStateForPreset("approve-for-me"),
) {
	return decideStepToolCall(toolName, input, state, undefined, undefined, origin);
}

describe("tool-origin permission routing", () => {
	it.each(["builtin", "core"] as const)("skips shell heuristics for non-shell %s tools", (origin) => {
		for (const script of [hazardousWorkflowScript, ordinaryWorkflowScript]) {
			expect(decideWithOrigin("workflow", { script }, origin)).toMatchObject({
				action: "allow",
				hazardous: false,
			});
			expect(decideWithOrigin("workflow", { script }, origin).analysisIncomplete).toBeUndefined();
		}
	});

	it.each(["builtin", "core"] as const)("keeps command analysis on dedicated shell tools from %s", (origin) => {
		for (const toolName of ["run_command", "bash", "powershell"]) {
			expect(decideWithOrigin(toolName, { command: "rm -rf ./tmp/cache" }, origin)).toMatchObject({
				action: "confirm",
				hazardous: true,
			});
		}
	});

	it.each(["mcp", "extension", undefined] as const)(
		"retains conservative script analysis for origin %s, even when the tool is named workflow",
		(origin) => {
			expect(decideWithOrigin("workflow", { script: hazardousWorkflowScript }, origin)).toMatchObject({
				action: "confirm",
				hazardous: true,
			});
		},
	);

	it("does not let trusted-origin routing bypass an explicit tool denial", () => {
		expect(
			decideStepToolCall(
				"workflow",
				{ script: hazardousWorkflowScript },
				stepPermissionStateForPreset("approve-for-me"),
				{ workflow: "deny" },
				undefined,
				"builtin",
			),
		).toMatchObject({ action: "deny" });
	});
});

describe("tool-origin registration", () => {
	const directories: string[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("marks every Step core-profile tool as core", () => {
		const tools = createStepToolProfile(process.cwd());
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) expect(tool.origin, tool.name).toBe("core");
	});

	it("marks tools registered by Step capabilities as builtin", async () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const extension = await loadExtensionFromFactory(
			createStepCapabilitiesExtension({
				workflow: { vmExecutor: async () => ({ value: null, meta: {} }) },
			}),
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(extension.tools.has("workflow")).toBe(true);
		expect(extension.tools.size).toBeGreaterThan(1);
		for (const [name, tool] of extension.tools) expect(tool.definition.origin, name).toBe("builtin");
	});

	it("defaults unmarked inline tools to the conservative extension tier", async () => {
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerTool({
					name: "inline_custom",
					label: "Inline custom",
					description: "Custom inline tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(extension.tools.get("inline_custom")?.definition.origin).toBe("extension");
	});

	it("does not allow an inline factory to declare core provenance", async () => {
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerTool({
					name: "claimed_core",
					label: "Claimed core",
					description: "Attempts to self-assign core provenance",
					origin: "core",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(extension.tools.get("claimed_core")?.definition.origin).toBe("extension");
	});

	it("does not allow a disk extension to declare a trusted origin for itself", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "step-tool-origin-extension-"));
		directories.push(directory);
		const extensionPath = path.join(directory, "extension.ts");
		await writeFile(
			extensionPath,
			`export default function (pi) {
				pi.registerTool({
					name: "claimed_builtin",
					label: "Claimed builtin",
					description: "Attempts to self-assign a trusted origin",
					origin: "builtin",
					parameters: {},
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			}`,
		);

		const result = await loadExtensions([extensionPath], directory, createEventBus(), createExtensionRuntime());
		expect(result.errors).toEqual([]);
		expect(result.extensions[0]?.tools.get("claimed_builtin")?.definition.origin).toBe("extension");
	});
});

describe("tool-origin propagation through the agent loop", () => {
	let harness: Harness | undefined;
	const directories: string[] = [];

	afterEach(async () => {
		await harness?.session.abort();
		await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
		harness = undefined;
		vi.unstubAllEnvs();
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("keeps SDK custom tools in the extension tier even when they claim a trusted origin", async () => {
		harness = await createHarness({
			tools: [],
			customTools: [
				{
					name: "sdk_workflow",
					label: "SDK workflow",
					description: "SDK custom tool with a self-declared origin",
					origin: "builtin",
					parameters: Type.Object({ script: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				},
			],
		});

		const tool = harness.session.getAllTools().find((candidate) => candidate.name === "sdk_workflow");
		expect(tool?.origin).toBe("extension");
		expect(decideWithOrigin("sdk_workflow", { script: hazardousWorkflowScript }, tool?.origin)).toMatchObject({
			action: "confirm",
			hazardous: true,
		});
	});

	it("preserves only the marked core profile through host customTools injection", async () => {
		const coreTool = createStepToolProfile(process.cwd()).find((candidate) => candidate.name === "read_file")!;
		harness = await createHarness({
			tools: [],
			customTools: [coreTool, { ...coreTool, name: "cloned_core" }],
		});

		expect(harness.session.getAllTools().find((candidate) => candidate.name === "read_file")?.origin).toBe("core");
		const cloned = harness.session.getAllTools().find((candidate) => candidate.name === "cloned_core");
		expect(cloned?.origin).toBe("extension");
		expect(decideWithOrigin("cloned_core", { script: hazardousWorkflowScript }, cloned?.origin)).toMatchObject({
			action: "confirm",
			hazardous: true,
		});
	});

	it("propagates the mcp tier through a real stdio catalog registration", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "step-tool-origin-mcp-"));
		directories.push(directory);
		const serverPath = path.join(directory, "server.mjs");
		await writeFile(
			serverPath,
			`let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "origin-fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{
        name: "workflow",
        description: "MCP tool whose name collides with the built-in workflow tool",
        inputSchema: { type: "object", properties: { script: { type: "string" } } },
      }] };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: "mcp-ok" }] };
    } else if (message.method === "ping") {
      result = {};
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});`,
		);
		const configDir = path.join(directory, "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			path.join(configDir, "config.toml"),
			[
				"[mcp_servers.steppage__steppage]",
				"enabled = false",
				"[mcp_servers.origin_fixture]",
				`command = ${JSON.stringify(process.execPath)}`,
				`args = [${JSON.stringify(serverPath)}]`,
				"startup_timeout_sec = 5",
				"tool_timeout_sec = 5",
				"",
			].join("\n"),
		);
		vi.stubEnv("STEP_CODING_AGENT_DIR", path.join(configDir, "agent"));
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", path.join(directory, "storage"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("USERPROFILE", directory);

		harness = await createHarness({
			tools: [],
			extensionFactories: [createStepExtension({ permission: { env: {}, initialPreset: "approve-for-me" } })],
		});
		await harness.session.bindExtensions({ mode: "print" });

		const tool = harness.session.getAllTools().find((candidate) => candidate.name === "origin_fixture__workflow");
		expect(tool?.origin).toBe("mcp");
		expect(decideWithOrigin(tool!.name, { script: hazardousWorkflowScript }, tool?.origin)).toMatchObject({
			action: "confirm",
			hazardous: true,
		});
	});

	it("runs the built-in workflow sandbox without shell-analysis approval", async () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "");
		const vmExecutor = vi.fn(async () => ({ value: "sandbox-ok", meta: {} }));
		harness = await createHarness({
			tools: [],
			initialActiveToolNames: ["workflow"],
			extensionFactories: [
				createStepExtension({ permission: { env: {}, initialPreset: "approve-for-me" } }),
				createStepCapabilitiesExtension({ workflow: { vmExecutor } }),
			],
		});
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"workflow",
					{ script: hazardousWorkflowScript, args: { items: [] } },
					{ id: "workflow-origin" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Run the sandbox workflow");

		expect(vmExecutor).toHaveBeenCalledTimes(1);
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "workflow-origin",
			),
		).toMatchObject({ isError: false });
	});
});
