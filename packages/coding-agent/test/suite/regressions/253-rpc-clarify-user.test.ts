import type { AgentToolResult } from "@step-harness/agent-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionContext } from "../../../src/core/extensions/index.ts";
import {
	registerStepClarifyUserExtension,
	type StepQuestionnaireDetails,
} from "../../../src/features/step-questionnaire.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};
type DialogRequest = {
	type: "extension_ui_request";
	id: string;
	method: "select" | "input";
	title: string;
	options?: string[];
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function outputRecords(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dialogRequests(): DialogRequest[] {
	return outputRecords().filter(
		(record): record is DialogRequest =>
			record.type === "extension_ui_request" && (record.method === "select" || record.method === "input"),
	) as DialogRequest[];
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC clarify_user regression (#253)", () => {
	const harnesses: Harness[] = [];
	let listenerSnapshot: ListenerSnapshot;

	beforeEach(() => {
		listenerSnapshot = takeListenerSnapshot();
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		restoreListeners(listenerSnapshot);
		expect(process.stdin.listeners("end")).toEqual(listenerSnapshot.stdinEnd);
		for (const [signal, previousListeners] of listenerSnapshot.signals) {
			expect(process.listeners(signal)).toEqual(previousListeners);
		}
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function createQuestionnaireHarness(): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [registerStepClarifyUserExtension] });
		harnesses.push(harness);
		return harness;
	}

	async function startRpc(): Promise<Harness> {
		const harness = await createQuestionnaireHarness();
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return harness;
	}

	function clarifyTool(harness: Harness) {
		const tool = harness.session.extensionRunner
			.getAllRegisteredTools()
			.find(({ definition }) => definition.name === "clarify_user");
		if (!tool) throw new Error("clarify_user is not registered");
		return tool.definition;
	}

	async function waitForDialog(index: number): Promise<DialogRequest> {
		await vi.waitFor(() => expect(dialogRequests().length).toBeGreaterThan(index));
		const request = dialogRequests()[index];
		if (!request) throw new Error(`Missing dialog request ${index}`);
		return request;
	}

	function respond(request: DialogRequest, response: { value?: string; cancelled?: boolean }): void {
		rpcIo.lineHandler?.(JSON.stringify({ type: "extension_ui_response", id: request.id, ...response }));
	}

	test("collects option and freeform answers through the RPC dialog protocol", async () => {
		const harness = await startRpc();
		const execution = clarifyTool(harness).execute(
			"clarify-253",
			{
				questions: [
					{
						id: "deployment",
						question: "Deploy the fix?",
						options: [
							{ label: "Yes", value: "yes" },
							{ label: "No", value: "no" },
						],
						allow_freeform: false,
					},
					{
						id: "reason",
						question: "Which kind of change is it?",
						options: [{ label: "Bug fix", value: "bug" }],
					},
				],
			},
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);

		const deployRequest = await waitForDialog(0);
		expect(deployRequest).toMatchObject({ method: "select", title: "Deploy the fix?", options: ["Yes", "No"] });
		respond(deployRequest, { value: "Yes" });

		const reasonRequest = await waitForDialog(1);
		expect(reasonRequest).toMatchObject({
			method: "select",
			title: "Which kind of change is it?",
			options: ["Bug fix", "Type a custom answer"],
		});
		respond(reasonRequest, { value: "Type a custom answer" });

		const customRequest = await waitForDialog(2);
		expect(customRequest).toMatchObject({ method: "input", title: "Which kind of change is it?" });
		respond(customRequest, { value: "  Production is broken  " });

		const result = (await execution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details).toMatchObject({
			cancelled: false,
			answers: [
				{ id: "deployment", value: "yes", label: "Yes", wasCustom: false, index: 1 },
				{ id: "reason", value: "Production is broken", label: "Production is broken", wasCustom: true },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("matched_option: Yes"),
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("source: freeform") });
		expect(dialogRequests()).toHaveLength(3);
	});

	test("returns cancellation from an RPC dialog without issuing another question", async () => {
		const harness = await startRpc();
		const execution = clarifyTool(harness).execute(
			"clarify-cancel",
			{
				questions: [
					{ id: "first", question: "First question", options: [{ label: "One", value: "one" }] },
					{ id: "second", question: "Second question" },
				],
			},
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);

		respond(await waitForDialog(0), { cancelled: true });
		const result = (await execution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content[0]).toMatchObject({ type: "text", text: "User clarification cancelled" });
		expect(dialogRequests()).toHaveLength(1);
	});

	test("cancels a pending RPC dialog when tool execution is aborted", async () => {
		const harness = await startRpc();
		const controller = new AbortController();
		const context = {
			...harness.session.extensionRunner.createContext(),
			signal: controller.signal,
		} as ExtensionContext;
		const execution = clarifyTool(harness).execute(
			"clarify-abort",
			{ question: "Wait for an answer", options: [{ label: "One", value: "one" }] },
			controller.signal,
			undefined,
			context,
		);
		let settled = false;
		const trackedExecution = execution.finally(() => {
			settled = true;
		});
		const request = await waitForDialog(0);

		controller.abort();
		const result = (await trackedExecution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(settled).toBe(true);
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content[0]).toMatchObject({ type: "text", text: "User clarification cancelled" });
		expect(dialogRequests()).toHaveLength(1);
		const outputCount = rpcIo.outputLines.length;
		respond(request, { value: "One" });
		expect(rpcIo.outputLines).toHaveLength(outputCount);
	});

	test("validates questionnaire arguments before emitting an RPC dialog", async () => {
		const harness = await startRpc();
		const result = (await clarifyTool(harness).execute(
			"clarify-invalid",
			{ question: "Choose one", options: [], allow_freeform: false },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		)) as AgentToolResult<StepQuestionnaireDetails>;

		expect(result.details?.cancelled).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: allow_freeform=false requires at least one option",
		});
		expect(dialogRequests()).toHaveLength(0);
	});

	test("rejects an empty freeform answer without reporting user cancellation", async () => {
		const harness = await startRpc();
		const execution = clarifyTool(harness).execute(
			"clarify-empty",
			{ question: "Any notes?" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);

		respond(await waitForDialog(0), { value: "" });
		const result = (await execution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: clarify_user requires a non-empty freeform answer",
		});
		expect(dialogRequests()).toHaveLength(1);
		const renderResult = clarifyTool(harness).renderResult;
		expect(renderResult).toBeDefined();
		const rendered = renderResult?.(
			result,
			{} as never,
			{ fg: (_color: string, text: string) => text } as unknown as never,
			{} as never,
		);
		expect(rendered?.render(80).join("\n")).toContain("Error: clarify_user requires a non-empty freeform answer");
	});

	test("rejects whitespace after the custom option without reporting user cancellation", async () => {
		const harness = await startRpc();
		const execution = clarifyTool(harness).execute(
			"clarify-whitespace",
			{ question: "Choose one", options: [{ label: "One", value: "one" }] },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);

		respond(await waitForDialog(0), { value: "Type a custom answer" });
		respond(await waitForDialog(1), { value: "   " });
		const result = (await execution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: clarify_user requires a non-empty freeform answer",
		});
		expect(dialogRequests()).toHaveLength(2);
	});

	test("rejects an unoffered option without reporting user cancellation", async () => {
		const harness = await startRpc();
		const execution = clarifyTool(harness).execute(
			"clarify-unoffered",
			{
				questions: [
					{ id: "first", question: "First question", options: [{ label: "One", value: "one" }] },
					{ id: "second", question: "Second question" },
				],
			},
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);

		respond(await waitForDialog(0), { value: "Not offered" });
		const result = (await execution) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: clarify_user received an option that was not offered",
		});
		expect(dialogRequests()).toHaveLength(1);
	});

	test("rejects duplicate question ids and option labels before any dialog", async () => {
		const harness = await createQuestionnaireHarness();
		const baseContext = harness.session.extensionRunner.createContext();
		const context = {
			...baseContext,
			mode: "rpc",
			hasUI: true,
			ui: {
				...baseContext.ui,
				select: async () => {
					throw new Error("duplicate labels must be rejected before select");
				},
				input: async () => {
					throw new Error("duplicate ids must be rejected before input");
				},
			},
		} as ExtensionContext;
		const tool = clarifyTool(harness);

		const duplicateIds = (await tool.execute(
			"clarify-duplicate-ids",
			{
				questions: [
					{ id: "same", question: "First question" },
					{ id: "same", question: "Second question" },
				],
			},
			undefined,
			undefined,
			context,
		)) as AgentToolResult<StepQuestionnaireDetails>;
		expect(duplicateIds.details).toMatchObject({ cancelled: true, answers: [] });
		expect(duplicateIds.content[0]).toMatchObject({
			type: "text",
			text: "Error: question ids must be unique",
		});

		const duplicateLabels = (await tool.execute(
			"clarify-duplicate-labels",
			{
				question: "Choose one",
				options: [
					{ label: "Same", value: "one" },
					{ label: "Same", value: "two" },
				],
			},
			undefined,
			undefined,
			context,
		)) as AgentToolResult<StepQuestionnaireDetails>;
		expect(duplicateLabels.details).toMatchObject({ cancelled: true, answers: [] });
		expect(duplicateLabels.content[0]).toMatchObject({
			type: "text",
			text: "Error: option labels must be unique within each question",
		});
	});

	test("keeps the native TUI dialog when custom UI is available", async () => {
		const harness = await createQuestionnaireHarness();
		const baseContext = harness.session.extensionRunner.createContext();
		let customCalls = 0;
		const context = {
			...baseContext,
			mode: "tui",
			hasUI: true,
			ui: {
				...baseContext.ui,
				select: async () => {
					throw new Error("RPC fallback must not replace the native TUI dialog");
				},
				custom: async () => {
					customCalls += 1;
					return {
						questions: [
							{
								id: "answer",
								label: "Question",
								question: "Choose one",
								options: [{ label: "Native", value: "native" }],
								allowFreeform: false,
							},
						],
						answers: [{ id: "answer", value: "native", label: "Native", wasCustom: false, index: 1 }],
						cancelled: false,
					} satisfies StepQuestionnaireDetails;
				},
			},
		} as ExtensionContext;

		const result = (await clarifyTool(harness).execute(
			"clarify-tui",
			{ question: "Choose one", options: [{ label: "Native", value: "native" }], allow_freeform: false },
			undefined,
			undefined,
			context,
		)) as AgentToolResult<StepQuestionnaireDetails>;
		expect(customCalls).toBe(1);
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ value: "native", label: "Native" }] });
	});

	test("keeps rejecting clarification in non-interactive mode", async () => {
		const harness = await createQuestionnaireHarness();
		const context = harness.session.extensionRunner.createContext();
		expect(context).toMatchObject({ mode: "print", hasUI: false });

		const result = (await clarifyTool(harness).execute(
			"clarify-print",
			{ question: "Choose one", options: [{ label: "One", value: "one" }] },
			undefined,
			undefined,
			context,
		)) as AgentToolResult<StepQuestionnaireDetails>;
		expect(result.details?.cancelled).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Error: clarify_user requires an interactive UI",
		});
	});
});
