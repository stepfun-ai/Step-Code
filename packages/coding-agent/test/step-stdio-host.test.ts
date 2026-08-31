import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../src/core/agent-session-runtime.ts";
import { encodeStepStdioFrame, StepStdioFrameDecoder } from "../src/step/stdio.ts";
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
			capabilities: ["streaming-input", "sdk-tools", "permission-callback", "hooks", "sessions"],
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
