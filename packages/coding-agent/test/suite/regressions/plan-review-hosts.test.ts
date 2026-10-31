import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { beforeAll, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeHost } from "../../../src/core/agent-session-runtime.ts";
import type { ClarificationResult } from "../../../src/core/extensions/clarification.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { getPlanFilePath } from "../../../src/features/plan-mode-tools.ts";
import { createStepPlanExtension, getStepPlanState } from "../../../src/features/step-plan.ts";
import { encodeStepStdioFrame, type StepFrame, StepStdioFrameDecoder } from "../../../src/step/stdio.ts";
import { StepStdioHost } from "../../../src/step/stdio-host.ts";
import { initTheme } from "../../../src/theme/theme.ts";
import { createHarness } from "../harness.ts";

beforeAll(() => initTheme("dark"));

it("a request without a proposal may answer directly but cannot disable plan mode", async () => {
	const harness = await createHarness({
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});
	try {
		await harness.session.bindExtensions({ mode: "print" });
		expect(harness.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain("plan");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("exit_plan_mode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("This is a read-only answer; no proposal is needed."),
		]);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		await harness.session.prompt("/plan");
		expect(errors).toEqual([]);
		await harness.session.prompt("Explain the repository.");
		expect(getStepPlanState(harness.sessionManager.getBranch())).toMatchObject({ enabled: true });
		expect(harness.eventsOfType("tool_execution_end")[0]?.result.details).toBeUndefined();
		expect(harness.eventsOfType("tool_execution_end")[0]?.result.stopTurn).toBeUndefined();
	} finally {
		harness.cleanup();
	}
});

it("a task passed through /plan expands an inner command under active plan mode", async () => {
	let received = "";
	let planning = false;
	const harness = await createHarness({
		extensionFactories: [
			{ name: "step-plan", factory: createStepPlanExtension(), hidden: true },
			{
				name: "inner-command",
				factory: (pi) => {
					pi.registerCommand("inspect_plan", {
						description: "Inspect mode",
						handler: async (args, ctx) => {
							received = args;
							planning = getStepPlanState(ctx.sessionManager.getBranch())?.enabled === true;
						},
					});
				},
				hidden: true,
			},
		],
	});
	try {
		await harness.session.bindExtensions({ mode: "print" });
		expect(harness.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain("plan");
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		await harness.session.prompt("/plan /inspect_plan marker");
		expect(errors).toEqual([]);
		await vi.waitFor(() => expect(received).toBe("marker"));
		expect(planning).toBe(true);
	} finally {
		harness.cleanup();
	}
});

it.each([true, false])("an embedded rpc session waits for its clarification reviewer (approve=%s)", async (approve) => {
	let writes = 0;
	const harness = await createHarness({
		tools: [
			{
				name: "write_file",
				label: "Write",
				description: "Write",
				parameters: Type.Object({ path: Type.String() }),
				execute: async () => {
					writes++;
					return { content: [{ type: "text", text: "written" }], details: {} };
				},
			},
		],
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});
	let respond!: (result: ClarificationResult) => void;
	const clarify = vi.fn(
		() =>
			new Promise<ClarificationResult>((resolve) => {
				respond = resolve;
			}),
	);
	try {
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: {
				...harness.session.extensionRunner.getUIContext(),
				clarify,
			} as ExtensionUIContext,
		});
		await harness.session.prompt("/plan");
		const planPath = getPlanFilePath(harness.sessionManager.getSessionId(), harness.tempDir);
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# Embedded proposal\n\nFull text.\n");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exit_plan_mode", {}), fauxToolCall("write_file", { path: "implementation.ts" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		const pending = harness.session.prompt("Review the proposal.");
		await vi.waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
		expect(writes).toBe(0);
		expect(getStepPlanState(harness.sessionManager.getBranch())).toMatchObject({ enabled: true });
		respond({
			answers: [
				{ id: "plan-review", value: approve ? "execute" : "dismissed", label: "decision", wasCustom: false },
			],
			cancelled: false,
		});
		await pending;
		expect(writes).toBe(approve ? 1 : 0);
		expect(getStepPlanState(harness.sessionManager.getBranch())).toMatchObject({ enabled: !approve });
	} finally {
		await harness.session.abort();
		harness.cleanup();
	}
});

it.each([
	{ supported: true, action: "execute", executed: true },
	{ supported: true, action: "dismissed", executed: false },
	{ supported: false, action: "dismissed", executed: false },
])("real session gates a mixed batch through stdio ($supported / $action)", async ({ supported, action, executed }) => {
	const effects: string[] = [];
	const harness = await createHarness({
		tools: ["read", "write_file"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				effects.push(name);
				return { content: [{ type: "text" as const, text: name }], details: {} };
			},
		})),
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});
	const input = new PassThrough();
	const output = new PassThrough();
	const decoder = new StepStdioFrameDecoder();
	const frames: StepFrame[] = [];
	output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
	const runtime = {
		session: harness.session,
		cwd: harness.tempDir,
		onSessionChange: () => () => {},
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntimeHost;
	const host = new StepStdioHost({ runtimeHost: runtime, input, output, diagnostics: () => {} });
	const running = host.run();
	const send = (id: string, method: string, payload: unknown) =>
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			}),
		);
	try {
		send("init", "initialize", { protocolRange: { min: 1, max: 1 }, capabilities: { planReview: supported } });
		await vi.waitFor(() => expect(frames.some((frame) => frame.replyTo === "init")).toBe(true));
		await harness.session.prompt("/plan");
		const planPath = getPlanFilePath(harness.sessionManager.getSessionId(), harness.tempDir);
		mkdirSync(path.dirname(planPath), { recursive: true });
		writeFileSync(planPath, "# Proposal\n\nImplement only after approval.\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "source.ts" }),
					fauxToolCall("exit_plan_mode", {}),
					fauxToolCall("write_file", { path: "implementation.ts" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Implementation finished."),
		]);
		send("query", "query.start", {
			prompt: "Review the proposal.",
			streamingInput: false,
			options: { permissionMode: "acceptEdits" },
		});
		if (supported) {
			await vi.waitFor(() => expect(frames.some((frame) => frame.method === "user_dialog.request")).toBe(true));
			const review = frames.find((frame) => frame.method === "user_dialog.request")!;
			expect(review.payload).toMatchObject({
				kind: "plan_review",
				planContents: "# Proposal\n\nImplement only after approval.\n",
			});
			expect(effects).toEqual(["read"]);
			expect(getStepPlanState(harness.sessionManager.getBranch())).toMatchObject({
				enabled: true,
				review: { outcome: "pending" },
			});
			input.write(
				encodeStepStdioFrame({
					protocol: "step-agent-sdk",
					version: 1,
					kind: "response",
					id: "answer",
					replyTo: review.id,
					payload: { action },
				}),
			);
		}
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));
		expect(effects).toEqual(executed ? ["read", "write_file"] : ["read"]);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(3);
		if (!executed) {
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.eventsOfType("tool_execution_end").at(-1)).toMatchObject({
				toolName: "write_file",
				isError: true,
				result: { content: [{ text: expect.stringContaining("skipped") }] },
			});
		}
		if (!supported) expect(frames.some((frame) => frame.method === "user_dialog.request")).toBe(false);
	} finally {
		await host.close();
		await running;
		harness.cleanup();
	}
});
