import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { StepFrame } from "../src/step/stdio.ts";
import { encodeStepStdioFrame, STEP_MAX_FRAME_BYTES, StepStdioFrameDecoder } from "../src/step/stdio.ts";
import { StepStdioHost } from "../src/step/stdio-host.ts";

function createFakeRuntime(withAgent = false): {
	runtime: AgentSessionRuntimeHost;
	session: AgentSession;
	emit(event: AgentSessionEvent): void;
} {
	const listeners = new Set<AgentSessionEventListener>();
	const session = {
		sessionId: "session-1",
		model: { provider: "step", id: "step-3.7-flash", name: "Step 3.7 Flash" },
		isIdle: true,
		isStreaming: false,
		messages: [],
		getActiveToolNames: () => ["read"],
		getLastAssistantText: () => "",
		getContextUsage: () => undefined,
		modelRuntime: {
			getAvailableSnapshot: () => [],
			getProviders: () => [],
			getProviderAuthStatus: () => ({ configured: true }),
			getModel: () => undefined,
		},
		sessionManager: {
			getCwd: () => "/workspace",
			getSessionDir: () => "/workspace/.sessions",
		},
		extensionRunner: {
			getRegisteredCommands: () => [],
			getUIContext: () => ({ theme: {} }),
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		bindExtensions: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(),
		compact: vi.fn(async () => ({})),
		setSessionName: vi.fn(),
		reload: vi.fn(async () => {}),
		get sessionName() {
			return undefined;
		},
	} as unknown as AgentSession;
	if (withAgent) {
		(session as unknown as { agent: unknown }).agent = {
			state: { tools: [{ name: "read" }] },
			beforeToolCall: undefined,
			afterToolCall: undefined,
		};
	}
	const runtime = {
		session,
		services: {},
		cwd: "/workspace",
		diagnostics: [],
		modelFallbackMessage: undefined,
		onSessionChange: () => () => {},
		setRebindSession: () => {},
		setBeforeSessionInvalidate: () => {},
		newSession: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		importFromJsonl: vi.fn(async () => ({ cancelled: false })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntimeHost;
	return {
		runtime,
		session,
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("StepStdioHost", () => {
	test("negotiates, starts an empty query, and shuts down through pi runtime", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (count: number): Promise<void> => {
			while (frames.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const { runtime } = createFakeRuntime();
		const host = new StepStdioHost({ runtimeHost: runtime, input, output, onExitRequested: vi.fn() });
		const running = host.run();

		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id: "init",
				method: "initialize",
				payload: { protocolRange: { min: 1, max: 1 } },
			}),
		);
		await waitFor(1);
		expect(frames[0]).toMatchObject({ kind: "response", replyTo: "init", payload: { selectedProtocol: 1 } });
		expect(frames[0].payload).toMatchObject({
			capabilities: ["streaming-input", "sdk-tools", "permission-callback", "hooks", "sessions", "plan-review"],
		});

		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id: "query",
				method: "query.start",
				payload: { streamingInput: false },
			}),
		);
		await waitFor(4);
		expect(frames[1]).toMatchObject({ kind: "response", replyTo: "query" });
		expect(frames[2]).toMatchObject({
			kind: "event",
			method: "query.message",
			payload: { message: { subtype: "init" } },
		});
		expect(frames[3]).toMatchObject({
			kind: "event",
			method: "query.message",
			payload: { message: { type: "result", subtype: "success" } },
		});

		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id: "shutdown",
				method: "runtime.shutdown",
				payload: {},
			}),
		);
		await waitFor(5);
		await host.close();
		await running;
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
	});

	test("accepts the SDK's nested user message shape", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (count: number): Promise<void> => {
			while (frames.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const { runtime, session } = createFakeRuntime();
		const host = new StepStdioHost({ runtimeHost: runtime, input, output });
		const running = host.run();
		const envelope = (id: string, method: string, payload: unknown): Buffer =>
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			});

		input.write(envelope("init", "initialize", { protocolRange: { min: 1, max: 1 } }));
		await waitFor(1);
		input.write(envelope("query", "query.start", { streamingInput: true }));
		await waitFor(3);
		const queryId = (frames[1].payload as { queryId: string }).queryId;
		input.write(
			envelope("input", "query.input", {
				queryId,
				message: {
					type: "user",
					message: { role: "user", content: [{ type: "text", text: "中文输入" }] },
				},
			}),
		);
		await waitFor(4);
		expect(session.prompt).toHaveBeenCalledWith("中文输入", { source: "rpc" });
		await host.close();
		await running;
	});

	test("serializes burst streaming input through pi prompt", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const { runtime, session } = createFakeRuntime();
		const promptMock = vi.mocked(session.prompt);
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const second = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		promptMock.mockImplementationOnce(async () => first).mockImplementationOnce(async () => second);
		const host = new StepStdioHost({ runtimeHost: runtime, input, output });
		const running = host.run();
		const envelope = (id: string, method: string, payload: unknown): Buffer =>
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			});

		input.write(envelope("init", "initialize", { protocolRange: { min: 1, max: 1 } }));
		await waitFor(() => frames.length >= 1);
		input.write(envelope("query", "query.start", { streamingInput: true }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "query"));
		const queryFrame = frames.find((frame) => frame.kind === "response" && frame.replyTo === "query");
		const queryId = (queryFrame?.payload as { queryId: string }).queryId;
		const userPayload = (text: string) => ({
			queryId,
			message: { type: "user", message: { role: "user", content: [{ type: "text", text }] } },
		});
		input.write(envelope("first", "query.input", userPayload("第一轮")));
		input.write(envelope("second", "query.input", userPayload("第二轮")));
		input.write(envelope("end", "query.input_end", { queryId }));
		await waitFor(() => promptMock.mock.calls.length >= 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(promptMock).toHaveBeenCalledTimes(1);
		expect(promptMock).toHaveBeenNthCalledWith(1, "第一轮", { source: "rpc" });

		releaseFirst();
		await waitFor(() => promptMock.mock.calls.length >= 2);
		expect(promptMock).toHaveBeenNthCalledWith(2, "第二轮", { source: "rpc" });
		releaseSecond();
		await waitFor(() =>
			frames.some(
				(frame) =>
					frame.kind === "event" && (frame.payload as { message?: { type?: string } }).message?.type === "result",
			),
		);
		await host.close();
		await running;
	});

	test("bridges SDK tools through the Pi agent and preserves the result", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			const deadline = Date.now() + 1_000;
			while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(predicate()).toBe(true);
		};
		const { runtime, session } = createFakeRuntime(true);
		const host = new StepStdioHost({ runtimeHost: runtime, input, output });
		const running = host.run();
		const envelope = (id: string, method: string, payload: unknown): Buffer =>
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			});

		input.write(envelope("init", "initialize", { protocolRange: { min: 1, max: 1 } }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "init"));
		input.write(
			envelope("query", "query.start", {
				streamingInput: true,
				options: {
					permissionMode: "bypassPermissions",
					sdkTools: [
						{
							serverName: "calc",
							toolName: "add",
							description: "Add two numbers",
							inputSchema: { type: "object" },
						},
					],
				},
			}),
		);
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "query"));
		const agent = (session as unknown as { agent: { state: { tools: Array<Record<string, any>> } } }).agent;
		const tool = agent.state.tools.find((candidate) => candidate.name === "calc__add") as
			| { execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<any> }
			| undefined;
		expect(tool).toBeDefined();
		const resultPromise = tool!.execute("tool-1", { a: 2, b: 40 });
		await waitFor(() => frames.some((frame) => frame.kind === "request" && frame.method === "sdk_tool.invoke"));
		const invoke = frames.find((frame) => frame.kind === "request" && frame.method === "sdk_tool.invoke");
		expect(invoke).toBeDefined();
		expect(invoke?.sessionId).toBe(session.sessionId);
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "invoke-response",
				replyTo: invoke!.id,
				payload: { content: [{ type: "text", text: "42" }] },
			}),
		);
		await expect(resultPromise).resolves.toMatchObject({ content: [{ type: "text", text: "42" }] });
		await host.close();
		await running;
	});

	test("routes permission and hook decisions through reverse RPC", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			const deadline = Date.now() + 1_000;
			while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(predicate()).toBe(true);
		};
		const { runtime, session } = createFakeRuntime(true);
		const host = new StepStdioHost({ runtimeHost: runtime, input, output });
		const running = host.run();
		const envelope = (id: string, method: string, payload: unknown): Buffer =>
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			});
		input.write(envelope("init", "initialize", { protocolRange: { min: 1, max: 1 } }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "init"));
		input.write(
			envelope("query", "query.start", {
				streamingInput: true,
				options: {
					permissionMode: "default",
					hasPermissionCallback: true,
					hooks: [{ event: "PreToolUse", matchers: [{ index: 7, matcher: "bash" }] }],
				},
			}),
		);
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "query"));
		const agent = (
			session as unknown as {
				agent: {
					beforeToolCall?: (context: any) => Promise<unknown>;
					state: { tools: Array<Record<string, any>> };
				};
			}
		).agent;
		const context = {
			toolCall: { id: "tool-2", name: "bash", arguments: { command: "echo hi" } },
			args: { command: "echo hi" },
			assistantMessage: {},
			context: {},
		};
		const approvalPromise = agent.beforeToolCall!(context);
		await waitFor(() => frames.some((frame) => frame.kind === "request" && frame.method === "hook.invoke"));
		const hookRequest = frames.find((frame) => frame.kind === "request" && frame.method === "hook.invoke");
		expect(hookRequest).toBeDefined();
		expect(hookRequest?.sessionId).toBe(session.sessionId);
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "hook-response",
				replyTo: hookRequest!.id,
				payload: {},
			}),
		);
		await waitFor(() => frames.some((frame) => frame.kind === "request" && frame.method === "permission.request"));
		const permissionRequest = frames.find(
			(frame) => frame.kind === "request" && frame.method === "permission.request",
		);
		expect(permissionRequest).toBeDefined();
		expect(permissionRequest?.sessionId).toBe(session.sessionId);
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "permission-response",
				replyTo: permissionRequest!.id,
				payload: { behavior: "allow" },
			}),
		);
		await expect(approvalPromise).resolves.toBeUndefined();
		await host.close();
		await running;
	});

	test("defaults permission mode to dontAsk when no callback is supplied", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: ReturnType<StepStdioFrameDecoder["push"]> = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (predicate: () => boolean): Promise<void> => {
			const deadline = Date.now() + 1_000;
			while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(predicate()).toBe(true);
		};
		const { runtime, session } = createFakeRuntime(true);
		const host = new StepStdioHost({ runtimeHost: runtime, input, output });
		const running = host.run();
		const envelope = (id: string, method: string, payload: unknown): Buffer =>
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "request",
				id,
				method,
				payload,
			});

		input.write(envelope("init", "initialize", { protocolRange: { min: 1, max: 1 } }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "init"));
		input.write(envelope("query", "query.start", { streamingInput: true }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "query"));
		const initMessage = frames.find(
			(frame) =>
				frame.kind === "event" && (frame.payload as { message?: { subtype?: string } }).message?.subtype === "init",
		);
		expect(initMessage).toMatchObject({ payload: { message: { permissionMode: "dontAsk" } } });

		input.write(envelope("bad-mode", "query.set_permission_mode", { mode: "unknown" }));
		await waitFor(() => frames.some((frame) => frame.kind === "response" && frame.replyTo === "bad-mode"));
		const invalidModeResponse = frames.find((frame) => frame.kind === "response" && frame.replyTo === "bad-mode");
		expect(invalidModeResponse).toMatchObject({ error: { code: "CONFIG_INVALID" } });

		const agent = (session as unknown as { agent: { beforeToolCall?: (context: any) => Promise<any> } }).agent;
		const result = await agent.beforeToolCall?.({
			toolCall: { id: "tool-denied", name: "bash", arguments: { command: "echo hi" } },
			args: { command: "echo hi" },
			assistantMessage: {},
			context: {},
		});
		expect(result).toMatchObject({ block: true });
		expect(frames.some((frame) => frame.kind === "request" && frame.method === "permission.request")).toBe(false);
		await host.close();
		await running;
	});

	test("serializes session rebinding and de-duplicates runtime notifications", async () => {
		const first = createFakeRuntime(true);
		const second = createFakeRuntime(true);
		let releaseBind!: () => void;
		const bindGate = new Promise<void>((resolve) => {
			releaseBind = resolve;
		});
		vi.mocked(second.session.bindExtensions).mockImplementation(async () => bindGate);
		let currentSession = first.session;
		let onSessionChange: ((session: AgentSession) => void) | undefined;
		let rebindSession: ((session: AgentSession) => Promise<void>) | undefined;
		const runtime = {
			...first.runtime,
			get session() {
				return currentSession;
			},
			onSessionChange(listener: (session: AgentSession) => void) {
				onSessionChange = listener;
				return () => {
					if (onSessionChange === listener) onSessionChange = undefined;
				};
			},
			setRebindSession(listener?: (session: AgentSession) => Promise<void>) {
				rebindSession = listener;
			},
		} as unknown as AgentSessionRuntimeHost;
		const host = new StepStdioHost({ runtimeHost: runtime, input: new PassThrough(), output: new PassThrough() });
		const running = host.run();
		await vi.waitFor(() => expect(first.session.bindExtensions).toHaveBeenCalledTimes(1));

		currentSession = second.session;
		onSessionChange?.(second.session);
		const replacement = rebindSession?.(second.session);
		expect(replacement).toBeDefined();
		let replacementSettled = false;
		void replacement!.then(
			() => {
				replacementSettled = true;
			},
			() => {
				replacementSettled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(replacementSettled).toBe(false);
		expect(second.session.bindExtensions).toHaveBeenCalledTimes(1);

		releaseBind();
		await replacement;
		expect(replacementSettled).toBe(true);
		expect(second.session.bindExtensions).toHaveBeenCalledTimes(1);
		await host.close();
		await running;
	});
});

describe("StepStdioHost plan review bridge", () => {
	const envelope = (id: string, method: string, payload: unknown): Buffer =>
		encodeStepStdioFrame({
			protocol: "step-agent-sdk",
			version: 1,
			kind: "request",
			id,
			method,
			payload,
		});

	async function setup(
		options: {
			planReviewGraceMs?: number;
			diagnostics?: (line: string) => void;
			planReview?: boolean;
			failDialogWrite?: boolean;
		} = {},
	): Promise<{
		input: PassThrough;
		output: PassThrough;
		frames: StepFrame[];
		host: StepStdioHost;
		running: Promise<void>;
		uiContext: ExtensionUIContext;
		waitFor: (count: number) => Promise<void>;
	}> {
		const input = new PassThrough();
		const output = new PassThrough();
		const decoder = new StepStdioFrameDecoder();
		const frames: StepFrame[] = [];
		output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
		const waitFor = async (count: number): Promise<void> => {
			while (frames.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const { runtime, session } = createFakeRuntime();
		const host = new StepStdioHost({
			runtimeHost: runtime,
			input,
			output,
			...(options.planReviewGraceMs === undefined ? {} : { planReviewGraceMs: options.planReviewGraceMs }),
			...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
			...(options.failDialogWrite
				? {
						writeFrame: (chunk: Buffer) => {
							if (new StepStdioFrameDecoder().push(chunk)[0]?.method === "user_dialog.request")
								throw new Error("write failed");
							return output.write(chunk);
						},
					}
				: {}),
		});
		const running = host.run();
		input.write(
			envelope("init", "initialize", {
				protocolRange: { min: 1, max: 1 },
				capabilities: { planReview: options.planReview ?? true },
			}),
		);
		// The UI context is bound with the session, on the host's bind queue.
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledTimes(1));
		const uiContext = vi.mocked(session.bindExtensions).mock.calls[0]![0].uiContext!;
		return { input, output, frames, host, running, uiContext, waitFor };
	}

	const reviewRequest = {
		planFilePath: "/workspace/.stepcode/plans/session-1.md",
		planContents: "# The plan\n1. Do the thing\n",
		planHash: "a".repeat(64),
		title: "Step has written up a plan and is ready to execute. Would you like to proceed?",
	};

	test("an unsupported peer never gains a blocking plan-review capability", async () => {
		const { uiContext, host, running, waitFor } = await setup({ planReview: false });
		await waitFor(1);
		expect(uiContext.reviewPlan).toBeUndefined();
		await host.close();
		await running;
	});

	test("a failed request write settles the review immediately", async () => {
		const diagnostics: string[] = [];
		const { uiContext, host, running, waitFor } = await setup({
			failDialogWrite: true,
			diagnostics: (line) => diagnostics.push(line),
		});
		await waitFor(1);
		expect(await uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 })).toBeUndefined();
		expect(diagnostics.some((line) => line.includes("write failed"))).toBe(true);
		await host.close();
		await running;
	});

	test("a closed host rejects a new review without creating a pending timeout", async () => {
		const { uiContext, host, running, waitFor, frames } = await setup();
		await waitFor(1);
		await host.close();
		await running;
		expect(await uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 })).toBeUndefined();
		expect(frames).toHaveLength(1);
	});

	test("bridges the plan review with the snapshot and hash over user_dialog.request", async () => {
		const { input, frames, host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 });
		await waitFor(2);
		const request = frames[1]!;
		expect(request).toMatchObject({
			kind: "request",
			method: "user_dialog.request",
			sessionId: "session-1",
			payload: {
				kind: "plan_review",
				planFilePath: reviewRequest.planFilePath,
				planContents: reviewRequest.planContents,
				planHash: reviewRequest.planHash,
				title: reviewRequest.title,
				timeoutMs: 600_000,
			},
		});
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "res-1",
				replyTo: request.id,
				sessionId: "session-1",
				payload: { action: "execute" },
			}),
		);
		expect(await review).toEqual({ action: "execute" });
		await host.close();
		await running;
	});

	test.each([
		{
			name: "feedback",
			payload: { action: "feedback", text: "use canvas" },
			expected: { action: "feedback", text: "use canvas" },
		},
		{ name: "dismissed", payload: { action: "dismissed" }, expected: { action: "dismissed" } },
		{ name: "cancelled", payload: { cancelled: true }, expected: undefined },
		{ name: "an empty note", payload: { action: "feedback", text: "  " }, expected: undefined },
		{ name: "a malformed payload", payload: { action: "launch" }, expected: undefined },
	])("maps a $name answer to its decision", async ({ payload, expected }) => {
		const { input, frames, host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 });
		await waitFor(2);
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "res-1",
				replyTo: frames[1]!.id,
				sessionId: "session-1",
				payload,
			}),
		);
		expect(await review).toEqual(expected);
		await host.close();
		await running;
	});

	test("an error response frame counts as no decision", async () => {
		const { input, frames, host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 });
		await waitFor(2);
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "res-1",
				replyTo: frames[1]!.id,
				sessionId: "session-1",
				error: { code: "DIALOG_FAILED", message: "the peer could not show the review" },
			}),
		);
		expect(await review).toBeUndefined();
		await host.close();
		await running;
	});

	test("an unanswered review times out as no decision, and a late answer is dropped", async () => {
		const { input, frames, host, running, uiContext, waitFor } = await setup({ planReviewGraceMs: 50 });
		await waitFor(1);
		vi.useFakeTimers();
		try {
			const review = uiContext.reviewPlan!(reviewRequest, { timeout: 30 });
			await Promise.resolve();
			expect(frames).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(81);
			expect(await review).toBeUndefined();
			expect(frames[2]).toMatchObject({
				method: "user_dialog.cancelled",
				payload: { requestId: frames[1]!.id, reason: "timeout" },
			});
			input.write(
				encodeStepStdioFrame({
					protocol: "step-agent-sdk",
					version: 1,
					kind: "response",
					id: "late",
					replyTo: frames[1]!.id,
					payload: { action: "execute" },
				}),
			);
			await Promise.resolve();
			expect(await review).toBeUndefined();
		} finally {
			await host.close();
			await running;
			vi.useRealTimers();
		}
	});

	test("the host accepts an answer inside its response grace window", async () => {
		const { input, frames, host, running, uiContext, waitFor } = await setup({ planReviewGraceMs: 50 });
		await waitFor(1);
		vi.useFakeTimers();
		try {
			let settled = false;
			const review = uiContext.reviewPlan!(reviewRequest, { timeout: 30 }).then((result) => {
				settled = true;
				return result;
			});
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(40);
			expect(settled).toBe(false);
			input.write(
				encodeStepStdioFrame({
					protocol: "step-agent-sdk",
					version: 1,
					kind: "response",
					id: "answer",
					replyTo: frames[1]!.id,
					payload: { action: "execute" },
				}),
			);
			expect(await review).toEqual({ action: "execute" });
		} finally {
			await host.close();
			await running;
			vi.useRealTimers();
		}
	});

	test("an aborted run cancels the review immediately", async () => {
		const { host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const controller = new AbortController();
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000, signal: controller.signal });
		controller.abort();
		expect(await review).toBeUndefined();
		await host.close();
		await running;
	});

	test("shutdown settles a pending review as no decision", async () => {
		const { host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000 });
		await host.close();
		expect(await review).toBeUndefined();
		await running;
	});

	test("an answer that arrives after an abort is dropped", async () => {
		const { input, frames, host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const controller = new AbortController();
		const review = uiContext.reviewPlan!(reviewRequest, { timeout: 600_000, signal: controller.signal });
		await waitFor(2);
		controller.abort();
		expect(await review).toBeUndefined();
		// The abort settled and dropped the pending entry, so a late answer cannot
		// overturn a decision the model already received.
		input.write(
			encodeStepStdioFrame({
				protocol: "step-agent-sdk",
				version: 1,
				kind: "response",
				id: "res-late",
				replyTo: frames[1]!.id,
				sessionId: "session-1",
				payload: { action: "execute" },
			}),
		);
		await Promise.resolve();
		expect(await review).toBeUndefined();
		// The host is still healthy: the unknown reply was ignored, nothing was
		// written back, and the run closes cleanly.
		expect(frames).toHaveLength(3);
		expect(frames[2]).toMatchObject({
			method: "user_dialog.cancelled",
			payload: { requestId: frames[1]!.id, reason: "aborted" },
		});
		await host.close();
		await running;
	});

	test("a plan too large for a frame fails fast instead of holding the turn", async () => {
		const diagnostics: string[] = [];
		const { frames, host, running, uiContext, waitFor } = await setup({
			diagnostics: (line) => diagnostics.push(line),
		});
		await waitFor(1);
		const oversized = {
			...reviewRequest,
			planContents: "x".repeat(STEP_MAX_FRAME_BYTES),
		};
		// No request frame is written: the review resolves as no decision at once,
		// and the peer is told why through a warning notification.
		expect(await uiContext.reviewPlan!(oversized, { timeout: 600_000 })).toEqual({
			action: "unavailable",
			reason: "proposal_too_large",
		});
		await waitFor(2);
		expect(frames[1]).toMatchObject({
			kind: "event",
			method: "user_notification",
			payload: { type: "warning" },
		});
		expect(diagnostics.some((line) => line.includes("exceeds the"))).toBe(true);
		await host.close();
		await running;
	});

	test("an already-aborted dialog falls back without writing a request", async () => {
		const { frames, host, running, uiContext, waitFor } = await setup();
		await waitFor(1);
		const controller = new AbortController();
		controller.abort();
		// The abort landed before the dialog opened: answer with the fallback now
		// rather than holding the caller until the timeout.
		expect(await uiContext.select!("Pick one", ["a", "b"], { signal: controller.signal })).toBeUndefined();
		expect(frames).toHaveLength(1);
		await host.close();
		await running;
	});
});
