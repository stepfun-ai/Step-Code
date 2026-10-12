import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStepTelemetryRuntime,
	type StepExtensionOptions,
	type StepTelemetryRecord,
	type StepTelemetryReporter,
	type StepTelemetryRuntime,
} from "@step-harness/coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../../packages/coding-agent/test/suite/harness.ts";
import { createStepExtensionFactories } from "../src/bootstrap/extensions.ts";
import { observability } from "../src/observability.ts";

// Isolate external MCP discovery/provisioning, not the product registration,
// permission controller, agent loop, lifecycle adapter, or telemetry runtime.
vi.mock("../../../packages/coding-agent/src/step/mcp.ts", () => ({
	createStepMcpExtension: () => () => undefined,
}));

describe("internal CLI lifecycle telemetry wiring", () => {
	let sandbox: string;
	let reporter: StepTelemetryRuntime;
	let records: StepTelemetryRecord[];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "step-lifecycle-telemetry-"));
		vi.stubEnv("STEP_CODING_AGENT_DIR", join(sandbox, "agent"));
		vi.stubEnv("STEPCODE_STORAGE_ROOT_DIR", join(sandbox, "storage"));
		records = [];
		reporter = createStepTelemetryRuntime({
			env: {},
			config: { spool: false },
			endpoint: "https://collector.invalid/events",
			flushIntervalMs: 0,
			flushThreshold: 1000,
			fetchImpl: async (_url, init) => {
				const batch = JSON.parse(String(init?.body)) as { events: StepTelemetryRecord[] };
				records.push(...batch.events);
				return new Response("{}", { status: 200 });
			},
		});
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.abort();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
		await reporter.shutdown();
		rmSync(sandbox, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function setup(
		permission: StepExtensionOptions["permission"] = { initialPreset: "ask" },
		telemetry: StepTelemetryReporter = reporter,
	) {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		const harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			tools: ["read_file", "write_file"].map((name) => ({
				name,
				label: name,
				description: "In-memory test tool",
				parameters: Type.Object({ then_run: Type.Optional(Type.String()) }),
				execute,
			})),
			initialActiveToolNames: ["read_file", "write_file"],
			extensionFactories: createStepExtensionFactories({
				telemetry,
				traceHeaderPolicy: { allowedBaseUrls: [], highSensitivityFields: [] },
				stepSettings: undefined,
				feedbackIdentity: undefined,
				permission: { env: {}, ...permission },
				stepCodeProviderExtension: undefined,
			}),
		});
		harnesses.push(harness);
		return { harness, execute };
	}

	function events(name: string) {
		return records.filter((record) => record.event === name);
	}

	it("produces a session, one product turn, usage, and one completion per actual tool", async () => {
		const shellContext = vi.fn(() => ({}));
		const { harness, execute } = await setup({ initialPreset: "ask", shellContext });
		await harness.session.bindExtensions({ mode: "print" });
		const first = fauxAssistantMessage(fauxToolCall("read_file", {}, { id: "read-1" }), { stopReason: "toolUse" });
		const last = fauxAssistantMessage("done");
		harness.setResponses([first, last]);
		await harness.session.prompt("Read the fixture");
		await reporter.flush();

		expect(execute).toHaveBeenCalledOnce();
		expect(shellContext).toHaveBeenCalledOnce();
		// Faux computes usage from the real assembled context. Compare against
		// its two delivered messages, not the pre-stream response templates.
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		const firstUsage = assistants[0]!.usage;
		const lastUsage = assistants[1]!.usage;
		expect(firstUsage.input + lastUsage.input).toBeGreaterThan(0);
		expect(events("session_started")).toHaveLength(1);
		expect(events("session_started")[0]?.properties).toMatchObject({ resumed: false, ui_mode: "headless" });
		expect(events("turn_completed")).toHaveLength(1);
		expect(events("turn_completed")[0]?.properties).toMatchObject({
			outcome: "ok",
			step_count: 2,
			tool_call_count: 1,
			input_token_count: firstUsage.input + lastUsage.input,
			cached_input_token_count:
				firstUsage.cacheRead + firstUsage.cacheWrite + lastUsage.cacheRead + lastUsage.cacheWrite,
			output_token_count: firstUsage.output + lastUsage.output,
		});
		expect(events("tool_call_completed")).toHaveLength(1);
		expect(events("tool_call_completed")[0]?.properties).toMatchObject({ tool_name: "read_file", outcome: "ok" });
		expect(events("permission_decision")).toHaveLength(1);
		expect(events("permission_decision")[0]?.properties).toMatchObject({ tool_name: "read_file", mode: "allow" });
		expect(events("permission_approval_result")).toEqual([]);
		for (const record of records) expect(record.context.sessionId).toBe(harness.sessionManager.getSessionId());
	});

	it.each([
		{
			name: "approved prompt", preset: "ask", hasUI: true, approved: true,
			mode: "confirm", outcome: "ok", approval: "allow-once", toolOverrides: undefined,
		},
		{
			name: "rejected prompt", preset: "ask", hasUI: true, approved: false,
			mode: "confirm", outcome: "denied", approval: "deny", toolOverrides: undefined,
		},
		{
			// The retired Read Only tier degrades to Ask rather than to a tier that
			// would silently execute writes, so a policy denial now comes from an
			// explicit per-tool override instead of a preset.
			name: "policy denial", preset: "ask", hasUI: true, approved: true,
			mode: "deny", outcome: "denied", approval: undefined,
			toolOverrides: { write_file: "deny" },
		},
		{
			name: "unattended denial", preset: "ask", hasUI: false, approved: false,
			mode: "confirm", outcome: "denied", approval: undefined, toolOverrides: undefined,
		},
		{
			name: "unattended allow", preset: "approve-for-me", hasUI: false, approved: false,
			mode: "allow", outcome: "ok", approval: undefined, toolOverrides: undefined,
		},
	] as const)("records the real permission path: $name", async ({ preset, hasUI, approved, mode, outcome, approval, toolOverrides }) => {
		const { harness, execute } = await setup({ initialPreset: preset, ...(toolOverrides ? { toolOverrides } : {}) });
		const confirm = vi.fn(async () => approved);
		await harness.session.bindExtensions({
			mode: hasUI ? "tui" : "print",
			...(hasUI ? { uiContext: { ...harness.session.extensionRunner.getUIContext(), confirm } } : {}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write_file", {}, { id: "write-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write the fixture");
		await reporter.flush();

		expect(execute).toHaveBeenCalledTimes(outcome === "ok" ? 1 : 0);
		expect(confirm).toHaveBeenCalledTimes(approval ? 1 : 0);
		expect(events("permission_decision")).toHaveLength(1);
		expect(events("permission_decision")[0]?.properties).toMatchObject({ tool_name: "write_file", mode });
		expect(events("permission_approval_result").map((record) => record.properties.decision)).toEqual(
			approval ? [approval] : [],
		);
		expect(events("tool_call_completed")).toHaveLength(1);
		expect(events("tool_call_completed")[0]?.properties).toMatchObject({
			outcome,
			error_code: outcome === "denied" ? "PERMISSION_DENIED" : null,
		});
	});

	it("preserves then_run availability checks without inventing a permission decision", async () => {
		const { harness, execute } = await setup({ initialPreset: "approve-for-me" });
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write_file", { then_run: "printf safe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write and verify");
		await reporter.flush();
		expect(execute).not.toHaveBeenCalled();
		expect(events("permission_decision")).toEqual([]);
		expect(events("tool_call_completed")).toHaveLength(1);
		expect(events("tool_call_completed")[0]?.properties.outcome).toBe("error");
	});

	it("records approval errors and keeps tool execution blocked", async () => {
		const { harness, execute } = await setup();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: {
				...harness.session.extensionRunner.getUIContext(),
				confirm: async () => {
					throw new Error("confirmation unavailable");
				},
			},
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write_file", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write the fixture");
		await reporter.flush();
		expect(execute).not.toHaveBeenCalled();
		expect(events("permission_approval_result").map((record) => record.properties.decision)).toEqual(["error"]);
		expect(events("tool_call_completed")[0]?.properties.outcome).toBe("error");
	});

	it("attributes pre-request commands and late requests across session replacement and shutdown", async () => {
		const { harness: first } = await setup();
		await first.session.bindExtensions({ mode: "print" });
		const sessionA = first.sessionManager.getSessionId();
		await first.session.prompt("/permissions bypass");
		await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		// Use a fresh extension instance, as the session replacement host does.
		const { harness: second } = await setup();
		await second.session.bindExtensions({ mode: "print" });
		const sessionB = second.sessionManager.getSessionId();
		expect(sessionB).not.toBe(sessionA);
		await second.session.prompt("/permissions read-only");
		const observer = observability.createModelRequestObserver(reporter);
		expect(observer).toBeDefined();
		await observer?.onRequestCompleted?.({
			provider: "faux",
			model: "faux-model",
			api: "faux",
			baseUrl: "https://model.invalid/v1",
			streamed: true,
			sessionId: sessionA,
			startedAt: 0,
			completedAt: 100,
			durationMs: 100,
			ttftMs: 10,
			statusCode: 200,
			outcome: "ok",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		});
		await second.session.prompt("/permissions ask");
		await second.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		reporter.track("cli_exited", { exit_reason: "normal" });
		// Flush only after switching and clearing: buffered records retain identity.
		await reporter.flush();
		expect(events("slash_command_used").map((record) => record.context.sessionId)).toEqual([
			sessionA, sessionB, sessionB,
		]);
		expect(events("permission_mode_toggled").map((record) => record.context.sessionId)).toEqual([
			sessionA, sessionB, sessionB,
		]);
		expect(events("model_request_completed").map((record) => record.context.sessionId)).toEqual([sessionA]);
		expect(events("cli_exited")[0]?.context.sessionId).toBeUndefined();
	});

	it("does not let reporter failures change permission or session behavior", async () => {
		const unavailable = () => {
			throw new Error("reporter unavailable");
		};
		const { harness, execute } = await setup(
			{ initialPreset: "approve-for-me" },
			{ track: unavailable, setContext: unavailable },
		);
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write_file", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write the fixture");
		expect(execute).toHaveBeenCalledOnce();
		await expect(
			harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
		).resolves.toBeUndefined();
	});
});
