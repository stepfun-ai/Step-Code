import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntimeHost } from "../src/core/agent-session-runtime.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../src/core/extensions/index.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";
import { getClientFileSystemBridge, setClientFileSystemBridge } from "../src/core/tools/client-fs.ts";
import { runAcpMode } from "../src/modes/acp/acp-mode.ts";
import { getHostMcpServerOverlay, setHostMcpServerOverlay } from "../src/step/mcp.ts";

type FakeSession = {
	sessionId: string;
	agent: { subscribe: () => () => void };
	subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
	bindExtensions: (bindings: { uiContext?: ExtensionUIContext }) => Promise<void>;
	prompt: Mock<(text: string, options?: { source?: string }) => Promise<void>>;
	abort: Mock<() => Promise<void>>;
	waitForIdle: Mock<() => Promise<void>>;
	navigateTree: Mock<() => Promise<{ cancelled: boolean }>>;
	reload: Mock<() => Promise<void>>;
};

type PermissionParams = {
	sessionId: string;
	toolCall: { title: string };
};

// `session/delete` must answer exactly once when the file cannot be removed,
// which on Windows is the ordinary case of a session file still being held
// open. The spy delegates to the real unlink, so only the test that needs a
// failure replaces it and the rest of the suite is untouched.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, unlink: vi.fn(actual.unlink) };
});

let stdin: PassThrough;
let captured: string[];
let stdoutSpy: Mock<(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => boolean>;
let originalStdoutWrite: typeof process.stdout.write;
let originalStdin: typeof process.stdin;
let originalStepApiKey: string | undefined;
let originalAuthPath: string | undefined;
let originalAgentDir: string | undefined;
let originalMcpServers: ReturnType<typeof getHostMcpServerOverlay>;
let initialSigtermListeners: NodeJS.SignalsListener[];
let initialSigintListeners: NodeJS.SignalsListener[];
let initialSighupListeners: NodeJS.SignalsListener[];
let agentDir: string;
let authDir: string;

function createSession() {
	let uiContext: ExtensionUIContext | undefined;
	let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
	const session: FakeSession = {
		sessionId: "session-1",
		agent: { subscribe: vi.fn(() => () => {}) },
		subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
			sessionListener = listener;
			return () => {
				sessionListener = undefined;
			};
		}),
		bindExtensions: vi.fn(async (bindings) => {
			uiContext = bindings.uiContext;
		}),
		prompt: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		reload: vi.fn(async () => {}),
	};
	return {
		session,
		getUIContext: () => uiContext,
		/** Emit an engine event the way a real turn would. */
		emitSessionEvent: (event: AgentSessionEvent) => sessionListener?.(event),
	};
}

function createHost(session: FakeSession): AgentSessionRuntimeHost {
	return {
		session,
		cwd: process.cwd(),
		setRebindSession: vi.fn(),
		onSessionChange: vi.fn(() => () => {}),
		setBeforeSessionInvalidate: vi.fn(),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		importFromJsonl: vi.fn(async () => ({ cancelled: false })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntimeHost;
}

function send(value: unknown): void {
	stdin.write(`${JSON.stringify(value)}\n`);
}

function parsedLines(): Record<string, unknown>[] {
	const buffer = captured.join("");
	return buffer
		.split("\n")
		.slice(0, -1)
		.filter((line) => line.length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return {};
			}
		});
}

async function waitForLine(predicate: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
	return vi.waitFor(
		() => {
			const line = parsedLines().find(predicate);
			if (!line) {
				throw new Error("expected JSON-RPC line not found");
			}
			return line;
		},
		{ timeout: 5000, interval: 5 },
	);
}

async function waitForResponse(id: string | number): Promise<Record<string, unknown>> {
	const line = await waitForLine(
		(candidate) => candidate.id === id && ("result" in candidate || "error" in candidate),
	);
	if (line.error) {
		throw new Error(`JSON-RPC error for ${String(id)}: ${JSON.stringify(line.error)}`);
	}
	return line.result as Record<string, unknown>;
}

beforeEach(() => {
	originalMcpServers = getHostMcpServerOverlay();
	initialSigtermListeners = process.listeners("SIGTERM");
	initialSigintListeners = process.listeners("SIGINT");
	initialSighupListeners = process.listeners("SIGHUP");
	// The auth gate reads two credential sources. Point the file one at a
	// directory that does not exist and hand out a key through the environment,
	// so a credential left on the developer machine cannot decide whether a
	// session is allowed to start. Tests that exercise the gate override this.
	originalStepApiKey = process.env.STEP_API_KEY;
	originalAuthPath = process.env.STEPCODE_AUTH_PATH;
	authDir = join(tmpdir(), `step-code-acp-${process.pid}-${Math.random().toString(36).slice(2)}`);
	process.env.STEPCODE_AUTH_PATH = join(authDir, "auth.json");
	process.env.STEP_API_KEY = "test-step-key";
	// session/fork resolves an id against every stored session, which means
	// reading the whole agent directory. A real one holds hundreds of sessions,
	// so point the tests at an empty one: "unknown session" has to be an
	// assertion about the code path, never a race against the developer's data.
	originalAgentDir = process.env.STEP_CODING_AGENT_DIR;
	agentDir = join(authDir, "agent");
	process.env.STEP_CODING_AGENT_DIR = agentDir;
	stdin = new PassThrough();
	captured = [];
	originalStdin = process.stdin;
	Object.defineProperty(process, "stdin", {
		value: stdin,
		configurable: true,
	});
	originalStdoutWrite = process.stdout.write;
	stdoutSpy = vi.fn((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
		captured.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (typeof done === "function") {
			(done as (error?: Error | null) => void)(null);
		}
		return true;
	});
	process.stdout.write = stdoutSpy as unknown as typeof process.stdout.write;
});

afterEach(() => {
	setHostMcpServerOverlay(originalMcpServers);
	setClientFileSystemBridge(undefined);
	for (const listener of process.listeners("SIGTERM")) {
		if (!initialSigtermListeners.includes(listener)) process.off("SIGTERM", listener);
	}
	for (const listener of process.listeners("SIGINT")) {
		if (!initialSigintListeners.includes(listener)) process.off("SIGINT", listener);
	}
	for (const listener of process.listeners("SIGHUP")) {
		if (!initialSighupListeners.includes(listener)) process.off("SIGHUP", listener);
	}
	restoreStdout();
	rmSync(authDir, { recursive: true, force: true });
	if (originalStepApiKey === undefined) delete process.env.STEP_API_KEY;
	else process.env.STEP_API_KEY = originalStepApiKey;
	if (originalAuthPath === undefined) delete process.env.STEPCODE_AUTH_PATH;
	else process.env.STEPCODE_AUTH_PATH = originalAuthPath;
	if (originalAgentDir === undefined) delete process.env.STEP_CODING_AGENT_DIR;
	else process.env.STEP_CODING_AGENT_DIR = originalAgentDir;
	process.stdout.write = originalStdoutWrite;
	stdin.destroy();
	Object.defineProperty(process, "stdin", {
		value: originalStdin,
		configurable: true,
	});
});

type FakeSessionWithControls = FakeSession & {
	extensionRunner: {
		getCommand: Mock<
			(name: string) => { handler: Mock<(args: string, ctx: ExtensionCommandContext) => Promise<void>> } | undefined
		>;
		createCommandContext: Mock<() => unknown>;
	};
	modelRuntime: {
		getAvailableSnapshot: Mock<() => Array<{ provider: string; id: string; name: string }>>;
		/** Refreshed after a credential is written or cleared. */
		getAvailable: Mock<() => Promise<unknown[]>>;
	};
	model: { provider: string; id: string; name: string } | undefined;
	setModel: Mock<(model: unknown) => Promise<void>>;
	supportsThinking: Mock<() => boolean>;
	getAvailableThinkingLevels: Mock<() => string[]>;
	thinkingLevel: string;
	setThinkingLevel: Mock<(level: string) => void>;
	/** The UI context the mode handed to `bindExtensions`, once it has. */
	getUIContext: () => ExtensionUIContext | undefined;
};

function createControlledSession(): FakeSessionWithControls {
	const created = createSession();
	const base = created.session as unknown as FakeSessionWithControls;
	// The step extension publishes the tier it just applied through the status
	// channel, so the fake command does the same. Without it the mode has nothing
	// to report and answers with the preset that was active before the call.
	const labels: Record<string, string> = {
		ask: "Ask",
		"approve-for-me": "Approve for Me",
		"full-access": "Full Access",
	};
	const permissionCommand = {
		handler: vi.fn(async (args: string, ctx: { ui: ExtensionUIContext }) => {
			const preset = labels[args.trim()];
			if (preset) ctx.ui.setStatus("step-permission", `Mode: ${preset}`);
		}),
	};
	base.extensionRunner = {
		getCommand: vi.fn((name: string) => (name === "permissions" ? permissionCommand : undefined)),
		createCommandContext: vi.fn(() => ({ ui: created.getUIContext() })),
	};
	base.modelRuntime = {
		getAvailableSnapshot: vi.fn(() => [
			{ provider: "step", id: "step-3", name: "Step 3" },
			{ provider: "step", id: "step-3-mini", name: "Step 3 Mini" },
		]),
		// authenticate and logout refresh the model list so the config-option
		// selector reflects a credential that was just written or removed.
		getAvailable: vi.fn(async () => []),
	};
	base.model = { provider: "step", id: "step-3", name: "Step 3" };
	base.setModel = vi.fn(async () => {});
	base.supportsThinking = vi.fn(() => true);
	base.getAvailableThinkingLevels = vi.fn(() => ["off", "low", "high"]);
	base.thinkingLevel = "low";
	base.setThinkingLevel = vi.fn(() => {});
	// A controlled session still has to let a test reach the UI context the mode
	// bound, which is how a permission prompt is driven.
	base.getUIContext = created.getUIContext;
	return base;
}

type InitializeResult = {
	protocolVersion: number;
	agentCapabilities: {
		promptCapabilities: { image: boolean; embeddedContext: boolean };
		mcpCapabilities?: { http?: boolean; sse?: boolean };
		sessionCapabilities: Record<string, unknown>;
		auth: Record<string, unknown>;
	};
	authMethods: Array<{ id: string; type?: string }>;
};

describe("acp initialization", () => {
	test("advertises the session methods it implements and gates terminal auth on the client", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		const initialized = (await waitForResponse(1)) as unknown as InitializeResult;

		expect(initialized.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
		// Both remote MCP transports the protocol defines are advertised, SSE included.
		expect(initialized.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: true });
		expect(Object.keys(initialized.agentCapabilities.sessionCapabilities).sort()).toEqual([
			"close",
			"delete",
			"list",
			"resume",
		]);
		expect(initialized.agentCapabilities.auth).toEqual({ logout: {} });
		// Neither advertised method can work without its client capability.
		expect(initialized.authMethods).toEqual([]);
	});

	test("offers the terminal login method when the client can run it", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } },
		});
		const initialized = (await waitForResponse(1)) as unknown as InitializeResult;
		expect(initialized.authMethods.map((method) => method.id)).toEqual(["step_login"]);
		expect(initialized.authMethods[0]?.type).toBe("terminal");
	});

	test("rejects a second initialize without replacing the negotiated capabilities", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { terminal: true } },
		});
		const duplicate = await waitForLine((line) => line.id === 2 && "error" in line);
		expect(duplicate.error).toMatchObject({ code: -32600 });
		expect(getClientFileSystemBridge()).toBeUndefined();
	});

	test("offers API-key authentication only when the client can render the form", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		const initialized = (await waitForResponse(1)) as unknown as InitializeResult;
		expect(initialized.authMethods.map((method) => method.id)).toEqual(["step_api_key"]);
	});
});

describe("acp client filesystem", () => {
	test("falls back to disk only when the client explicitly does not implement reads", async () => {
		const filePath = join(authDir, "buffer.txt");
		mkdirSync(authDir, { recursive: true });
		writeFileSync(filePath, "disk contents", "utf-8");
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } },
		});
		await waitForResponse(1);

		const pending = getClientFileSystemBridge()?.readTextFile?.(filePath);
		const request = await waitForLine((line) => line.method === "fs/read_text_file");
		send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not implemented" } });

		await expect(pending).resolves.toBe("disk contents");
	});

	test("does not replace the editor buffer with disk content after a client failure", async () => {
		const filePath = join(authDir, "buffer.txt");
		mkdirSync(authDir, { recursive: true });
		writeFileSync(filePath, "stale disk contents", "utf-8");
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } },
		});
		await waitForResponse(1);

		const pending = getClientFileSystemBridge()?.readTextFile?.(filePath);
		const request = await waitForLine((line) => line.method === "fs/read_text_file");
		send({ jsonrpc: "2.0", id: request.id, error: { code: -32003, message: "editor unavailable" } });

		await expect(pending).rejects.toMatchObject({ code: -32003, message: "editor unavailable" });
	});
});

describe("acp elicitation", () => {
	test("bridges an extension input dialog and returns what the user typed", async () => {
		const { session, getUIContext } = createSession();
		let typed: string | undefined;
		session.prompt.mockImplementation(async () => {
			typed = await getUIContext()?.input("Branch name?");
		});

		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "rename" }] },
		});
		const elicitation = await waitForLine((line) => line.method === "elicitation/create");
		expect(elicitation.params).toMatchObject({ mode: "form", prompt: "Branch name?" });
		send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "accept", content: { value: "feature/x" } } });

		await vi.waitFor(() => {
			expect(typed).toBe("feature/x");
		});
	});

	test("resolves input as dismissed when the client declines", async () => {
		const { session, getUIContext } = createSession();
		let answered = "unset";
		session.prompt.mockImplementation(async () => {
			answered = String(await getUIContext()?.input("Branch name?"));
		});

		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "rename" }] },
		});
		const elicitation = await waitForLine((line) => line.method === "elicitation/create");
		send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "decline" } });

		await vi.waitFor(() => {
			expect(answered).toBe("undefined");
		});
	});

	test("maps a failed elicitation request to a dismissed dialog", async () => {
		const { session, getUIContext } = createSession();
		let answered = "unset";
		session.prompt.mockImplementation(async () => {
			answered = String(await getUIContext()?.input("Branch name?"));
		});
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "rename" }] },
		});
		const elicitation = await waitForLine((line) => line.method === "elicitation/create");
		send({ jsonrpc: "2.0", id: elicitation.id, error: { code: -32603, message: "client failed" } });

		expect(await waitForResponse(2)).toEqual({ stopReason: "end_turn" });
		expect(answered).toBe("undefined");
	});

	test("cancel_request dismisses only the targeted elicitation request", async () => {
		const { session, getUIContext } = createSession();
		let answered = "unset";
		session.prompt.mockImplementation(async () => {
			answered = String(await getUIContext()?.input("Branch name?"));
		});
		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "rename" }] },
		});
		const elicitation = await waitForLine((line) => line.method === "elicitation/create");
		send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: elicitation.id } });

		expect(await waitForResponse(2)).toEqual({ stopReason: "end_turn" });
		expect(answered).toBe("undefined");
		expect(session.abort).not.toHaveBeenCalled();
	});

	test("returns the option the user picked from a select dialog", async () => {
		const { session, getUIContext } = createSession();
		let picked: string | undefined;
		session.prompt.mockImplementation(async () => {
			picked = await getUIContext()?.select("Pick one", ["alpha", "beta"]);
		});

		void runAcpMode(createHost(session));
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
		});
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "choose" }] },
		});
		const elicitation = await waitForLine((line) => line.method === "elicitation/create");
		expect(elicitation.params).toMatchObject({ prompt: "Pick one" });
		send({ jsonrpc: "2.0", id: elicitation.id, result: { action: "accept", content: { choice: "beta" } } });

		await vi.waitFor(() => {
			expect(picked).toBe("beta");
		});
	});

	test("passes an embedded binary resource to the engine without rejecting it", async () => {
		const { session } = createSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: {
				sessionId: "session-1",
				prompt: [
					{
						type: "resource",
						resource: { uri: "file:///inline.bin", blob: "YmluYXJ5" },
					},
				],
			},
		});
		expect(await waitForResponse(2)).toEqual({ stopReason: "end_turn" });
		const [text, options] = session.prompt.mock.calls[0]!;
		expect(text).toContain('mimeType="application/octet-stream"');
		expect(text).toContain(">YmluYXJ5</resource>");
		expect(options).toMatchObject({ source: "acp" });
	});
});

describe("acp mode", () => {
	test("streams a prompt turn and resolves a permission request without blocking stdin", async () => {
		const { session, getUIContext } = createSession();
		const host = createHost(session);
		let releasePrompt = () => {};
		const promptDone = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		session.prompt.mockImplementation(async () => {
			const approved = await getUIContext()?.confirm("Approve?", "run bash");
			if (!approved) {
				throw new Error("permission rejected");
			}
			await promptDone;
		});

		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		const initialized = (await waitForResponse(1)) as unknown as InitializeResult;
		expect(initialized.protocolVersion).toBe(1);
		expect(initialized.agentCapabilities.promptCapabilities.image).toBe(true);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		const permission = await waitForLine((line) => line.method === "session/request_permission");
		const permissionId = permission.id;
		expect(permissionId).toBeTypeOf("string");
		expect((permission.params as PermissionParams).toolCall.title).toBe("Approve?");
		send({
			jsonrpc: "2.0",
			id: permissionId,
			result: { outcome: { outcome: "selected", optionId: "allow_once" } },
		});
		releasePrompt();
		const result = await waitForResponse(2);
		expect(result.stopReason).toBe("end_turn");
	});

	test("reports a failed turn as a JSON-RPC error instead of end_turn", async () => {
		const { session, emitSessionEvent } = createSession();
		const host = createHost(session);
		session.prompt.mockImplementation(async () => {
			// A failed model call does not reject prompt(); the engine records it on
			// the assistant message and emits agent_end.
			emitSessionEvent({
				type: "agent_end",
				willRetry: false,
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
					{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "404: model unavailable",
					},
				],
			} as unknown as AgentSessionEvent);
		});

		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 4,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		const line = await waitForLine((candidate) => candidate.id === 4);
		expect(line.result).toBeUndefined();
		expect(line.error).toMatchObject({ code: -32603, message: expect.stringContaining("404") });
	});

	test("maps a truncated final response to max_tokens", async () => {
		const { session, emitSessionEvent } = createSession();
		void runAcpMode(createHost(session));
		session.prompt.mockImplementation(async () => {
			emitSessionEvent({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "length" }],
			} as unknown as AgentSessionEvent);
		});
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 4,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		expect(await waitForResponse(4)).toEqual({ stopReason: "max_tokens" });
	});

	test("does not replay an earlier failed turn onto a later successful one", async () => {
		const { session, emitSessionEvent } = createSession();
		const host = createHost(session);
		let turn = 0;
		session.prompt.mockImplementation(async () => {
			turn += 1;
			emitSessionEvent({
				type: "agent_end",
				willRetry: false,
				messages:
					turn === 1
						? [
								{ role: "user", content: [{ type: "text", text: "hello" }] },
								{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
							]
						: [
								{ role: "user", content: [{ type: "text", text: "again" }] },
								{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
							],
			} as unknown as AgentSessionEvent);
		});

		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 5,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		const failed = await waitForLine((candidate) => candidate.id === 5);
		expect(failed.error).toBeDefined();

		send({
			jsonrpc: "2.0",
			id: 6,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "again" }] },
		});
		const recovered = await waitForResponse(6);
		expect(recovered.stopReason).toBe("end_turn");
	});

	test("rejects a concurrent prompt without disturbing the active turn", async () => {
		const { session } = createSession();
		const host = createHost(session);
		let finishPrompt = () => {};
		session.prompt.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishPrompt = resolve;
				}),
		);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "first" }] },
		});
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

		send({
			jsonrpc: "2.0",
			id: 3,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "second" }] },
		});
		const rejected = await waitForLine((line) => line.id === 3 && "error" in line);
		expect(rejected.error).toMatchObject({ code: -32003 });
		finishPrompt();
		expect(await waitForResponse(2)).toEqual({ stopReason: "end_turn" });
		expect(session.prompt).toHaveBeenCalledTimes(1);
	});

	test("cancels an active prompt turn", async () => {
		const { session } = createSession();
		const host = createHost(session);
		let rejectPrompt: (error: Error) => void = () => {};
		session.prompt.mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
				}),
		);
		session.abort.mockImplementation(async () => {
			rejectPrompt(new Error("aborted"));
		});

		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 3,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		await vi.waitFor(() => {
			expect(session.prompt).toHaveBeenCalledTimes(1);
		});
		send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "session-1" } });
		const result = await waitForResponse(3);
		expect(result.stopReason).toBe("cancelled");
		expect(session.abort).toHaveBeenCalledTimes(1);
	});

	test("cancel_request does not replace session cancel for a prompt turn", async () => {
		const { session } = createSession();
		const host = createHost(session);
		let resolvePrompt: () => void = () => {};
		session.prompt.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 3,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
		});
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

		send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 3 } });
		send({ jsonrpc: "2.0", id: 4, method: "session/list", params: { cwd: process.cwd() } });
		await waitForResponse(4);
		expect(session.abort).not.toHaveBeenCalled();

		resolvePrompt();
		expect(await waitForResponse(3)).toEqual({ stopReason: "end_turn" });
	});

	test("ignores cancellation for a foreign session without aborting the active turn", async () => {
		const { session } = createSession();
		const host = createHost(session);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			void runAcpMode(host);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);
			send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "some-other-session" } });
			send({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: process.cwd() } });
			await waitForResponse(2);
			expect(session.abort).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("unknown sessionId");
		} finally {
			stderr.mockRestore();
		}
	});

	describe("acp session modes and config options", () => {
		test("session/new reports the modes and selectors the session can change", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			const created = (await waitForResponse(2)) as {
				modes: { currentModeId: string; availableModes: Array<{ id: string }> };
				configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>;
			};

			expect(created.modes.availableModes.map((mode) => mode.id)).toEqual(["ask", "approve-for-me", "full-access"]);
			// Nothing has published a tier yet, so the first preset is reported.
			expect(created.modes.currentModeId).toBe("ask");
			expect(created.configOptions.map((option) => option.id)).toEqual(["model", "thinking"]);
			expect(created.configOptions[0]?.currentValue).toBe("step/step-3");
			expect(created.configOptions[0]?.options.map((option) => option.value)).toContain("step/step-3-mini");
		});

		test("session/set_mode runs the permissions command and answers with the new state", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_mode",
				params: { sessionId: "session-1", modeId: "approve-for-me" },
			});
			const result = (await waitForResponse(2)) as { currentModeId: string };
			expect(session.extensionRunner.getCommand).toHaveBeenCalledWith("permissions");
			expect(result.currentModeId).toBe("approve-for-me");

			const modeUpdate = await waitForLine(
				(line) =>
					line.method === "session/update" &&
					JSON.stringify(line.params).includes('"sessionUpdate":"current_mode_update"'),
			);
			expect(JSON.stringify(modeUpdate.params)).toContain('"currentModeId":"approve-for-me"');
		});

		test("session/set_mode rejects an unknown mode without touching the policy", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_mode",
				params: { sessionId: "session-1", modeId: "turbo" },
			});
			const error = await waitForLine((line) => line.id === 2 && "error" in line);
			expect(error.error).toMatchObject({ code: -32602 });
			expect(session.extensionRunner.getCommand).not.toHaveBeenCalled();
		});

		test("session/set_config_option switches the model and returns the selectors", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_config_option",
				params: { sessionId: "session-1", optionId: "model", value: "step/step-3-mini" },
			});
			const result = (await waitForResponse(2)) as unknown as {
				configOptions: Array<{ id: string; currentValue: string }>;
			};
			expect(session.setModel).toHaveBeenCalledWith({ provider: "step", id: "step-3-mini", name: "Step 3 Mini" });
			// The fake does not mutate its active model, but the wire envelope still
			// has to match SetSessionConfigOptionResponse.
			expect(result.configOptions[0]?.currentValue).toBe("step/step-3");
		});

		test("session/set_config_option sets the reasoning level", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_config_option",
				params: { sessionId: "session-1", optionId: "thinking", value: "high" },
			});
			await waitForResponse(2);
			expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
		});

		test("session/set_config_option rejects an unknown option and an unknown model", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_config_option",
				params: { sessionId: "session-1", optionId: "theme", value: "dark" },
			});
			expect(await waitForLine((line) => line.id === 2 && "error" in line)).toBeTruthy();

			send({
				jsonrpc: "2.0",
				id: 3,
				method: "session/set_config_option",
				params: { sessionId: "session-1", optionId: "model", value: "step/nope" },
			});
			expect(await waitForLine((line) => line.id === 3 && "error" in line)).toBeTruthy();
			expect(session.setModel).not.toHaveBeenCalled();
		});
	});

	describe("acp methods outside the v1 schema", () => {
		// Both are extensions the v1 schema does not define. They are accepted
		// because clients that talk to agents which implement them will send them,
		// and each is an alias over a method that is in the schema.

		test("session/set_model is the model half of session/set_config_option", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_model",
				params: { sessionId: "session-1", modelId: "step/step-3-mini" },
			});
			const result = (await waitForResponse(2)) as unknown as {
				configOptions: Array<{ id: string; currentValue: string }>;
			};
			expect(session.setModel).toHaveBeenCalledWith({ provider: "step", id: "step-3-mini", name: "Step 3 Mini" });
			// Same response shape as the method it aliases.
			expect(result.configOptions[0]?.id).toBe("model");
		});

		test("session/set_model rejects an unknown model and a foreign session", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/set_model",
				params: { sessionId: "session-1", modelId: "step/nope" },
			});
			expect(await waitForLine((line) => line.id === 2 && "error" in line)).toBeTruthy();

			send({
				jsonrpc: "2.0",
				id: 3,
				method: "session/set_model",
				params: { sessionId: "someone-else", modelId: "step/step-3-mini" },
			});
			expect(await waitForLine((line) => line.id === 3 && "error" in line)).toBeTruthy();
			expect(session.setModel).not.toHaveBeenCalled();
		});

		test("session/fork reports an unknown session instead of forking nothing", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/fork",
				params: { sessionId: "no-such-session", cwd: process.cwd() },
			});
			// The source must resolve to a real session file before anything is
			// written, so a bad id fails rather than creating an empty fork.
			expect(await waitForLine((line) => line.id === 2 && "error" in line)).toBeTruthy();
		});
		test("session/fork removes the unused fork when switching is cancelled", async () => {
			const stored = await writeStoredSession(process.cwd());
			const session = createControlledSession();
			const host = createHost(session);
			vi.mocked(host.switchSession).mockResolvedValueOnce({ cancelled: true });
			void runAcpMode(host);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);
			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/fork",
				params: { sessionId: stored.sessionId, cwd: process.cwd(), mcpServers: [] },
			});
			const error = await waitForLine((line) => line.id === 2 && "error" in line);
			expect(error.error).toMatchObject({ code: -32800 });
			expect(existsSync(stored.path)).toBe(true);
			expect(
				readdirSync(getDefaultSessionDir(process.cwd())).filter((name) => name.endsWith(".jsonl")),
			).toHaveLength(1);
		});
	});

	describe("acp session authentication gate", () => {
		// Every session here uses the controlled factory, whose active model is a
		// Step model. That is the shape of a default install, which is the only
		// case the gate covers.

		test("refuses session/new with auth_required when nothing can authenticate it", async () => {
			delete process.env.STEP_API_KEY;
			const session = createControlledSession();
			setHostMcpServerOverlay({ existing: { command: "existing-command" } });
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/new",
				params: { cwd: process.cwd(), mcpServers: [{ name: "replacement", command: "replacement-command" }] },
			});
			const error = await waitForLine((line) => line.id === 2 && "error" in line);
			expect(error.error).toMatchObject({ code: -32000 });
			expect(getHostMcpServerOverlay()).toEqual({ existing: { command: "existing-command" } });
			// The message has to name the fix, because that is the whole point of
			// answering with auth_required instead of letting the turn fail.
			expect((error.error as { message?: string }).message).toContain("STEP_API_KEY");
		});

		test("starts the session when a key is in the environment", async () => {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			const created = await waitForResponse(2);
			expect(created.sessionId).toBe("session-1");
		});

		test("starts the session when step login left a credential on disk", async () => {
			delete process.env.STEP_API_KEY;
			mkdirSync(authDir, { recursive: true });
			writeFileSync(join(authDir, "auth.json"), JSON.stringify({ step: { type: "api_key", key: "stored-key" } }));

			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			const created = await waitForResponse(2);
			expect(created.sessionId).toBe("session-1");
		});

		test("does not gate a session whose active model is not a Step model", async () => {
			delete process.env.STEP_API_KEY;
			const session = createControlledSession();
			session.model = { provider: "openai", id: "gpt-4o", name: "GPT-4o" };

			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			const created = await waitForResponse(2);
			expect(created.sessionId).toBe("session-1");
		});
	});
});

describe("acp session-scoped permission answers", () => {
	/**
	 * Every `session/request_permission` line the mode has emitted so far, in
	 * order. Indexing by position is required: an "always" answer stops further
	 * requests, so a plain `find` would keep matching the request that was
	 * already answered and the test would silently answer a stale id.
	 */
	function permissionRequests(): Array<{ id: unknown; options: Array<{ optionId: string; kind: string }> }> {
		return parsedLines()
			.filter((line) => line.method === "session/request_permission")
			.map((line) => ({
				id: line.id,
				options: (line.params as { options: Array<{ optionId: string; kind: string }> }).options,
			}));
	}

	async function answer(index: number, optionId: string): Promise<void> {
		const request = permissionRequests()[index];
		if (!request) throw new Error(`no permission request #${index + 1} was raised`);
		send({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "selected", optionId } } });
	}

	const prompt = (id: number, text = "hello") =>
		send({
			jsonrpc: "2.0",
			id,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text }] },
		});

	test("offers both the one-shot and the session-wide answer on every request", async () => {
		const { session, getUIContext } = createSession();
		session.prompt.mockImplementation(async () => {
			await getUIContext()?.confirm("Approve?", "run bash");
		});

		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		prompt(2);
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
		// The kinds are what a spec-following client renders, so they matter as
		// much as the ids: `allow_always` is the one the protocol reserves for
		// "stop asking for the rest of this session".
		expect(permissionRequests()[0]?.options).toEqual([
			{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
			{ optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
			{ optionId: "reject_once", name: "Reject once", kind: "reject_once" },
			{ optionId: "reject_always", name: "Reject for this session", kind: "reject_always" },
		]);
	});

	test("settles later requests without a round-trip once the user answered always", async () => {
		const { session, getUIContext } = createSession();
		const answers: boolean[] = [];
		session.prompt.mockImplementation(async () => {
			answers.push((await getUIContext()?.confirm("Approve?", "run bash")) ?? false);
		});

		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		prompt(2);
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
		await answer(0, "allow_always");
		await waitForResponse(2);

		prompt(3, "hello again");
		await waitForResponse(3);

		expect(answers).toEqual([true, true]);
		// Counting the requests catches a flag that is recorded but never read.
		expect(permissionRequests()).toHaveLength(1);
	});

	test("stops asking after a reject-always answer", async () => {
		const { session, getUIContext } = createSession();
		const answers: boolean[] = [];
		session.prompt.mockImplementation(async () => {
			answers.push((await getUIContext()?.confirm("Approve?", "run bash")) ?? false);
		});

		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		prompt(2);
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
		await answer(0, "reject_always");
		await waitForResponse(2);

		prompt(3, "hello again");
		await waitForResponse(3);

		expect(answers).toEqual([false, false]);
		expect(permissionRequests()).toHaveLength(1);
	});

	test("reads a reject-always answer as consent withheld when both flags are set", async () => {
		const { session, getUIContext } = createSession();
		const answers: boolean[] = [];
		// Two tool calls in one turn ask at the same time. The client answers
		// them out of order, which is the only way both flags can end up set:
		// once either one lands the mode stops asking, so the client cannot
		// reach the other through a later turn.
		let releaseBoth = () => {};
		const bothAsked = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});
		session.prompt.mockImplementation(async () => {
			const first = getUIContext()?.confirm("Approve?", "run bash");
			const second = getUIContext()?.confirm("Approve?", "run bash");
			releaseBoth();
			answers.push((await first) ?? false);
			answers.push((await second) ?? false);
		});

		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		prompt(2);
		await bothAsked;
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(2));
		await answer(0, "reject_always");
		await answer(1, "allow_always");
		await waitForResponse(2);

		// The first answer is a rejection. The second was already in flight when
		// the flag landed, so it keeps whatever the client said for it.
		expect(answers).toEqual([false, true]);

		// Back to one guarded call: the concurrency above was only a way to get
		// both flags set, and this turn is what actually settles the precedence.
		session.prompt.mockImplementation(async () => {
			answers.push((await getUIContext()?.confirm("Approve?", "run bash")) ?? false);
		});
		prompt(3, "hello again");
		await waitForResponse(3);
		// A client that somehow selected both must not be read as consent.
		expect(answers.slice(2)).toEqual([false]);
		expect(permissionRequests()).toHaveLength(2);
	});

	test("settles a pending permission and cancels its prompt before switching sessions", async () => {
		const session = createControlledSession();
		const getUIContext = session.getUIContext;
		const host = createHost(session);
		session.prompt.mockImplementation(async () => {
			await getUIContext()?.confirm("Approve?", "run bash");
		});
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		prompt(2);
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));

		send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
		await waitForResponse(3);
		expect(await waitForResponse(2)).toEqual({ stopReason: "cancelled" });
	});

	test("asks again after the active session changes", async () => {
		const session = createControlledSession();
		const answers: boolean[] = [];
		session.prompt.mockImplementation(async () => {
			answers.push((await session.getUIContext()?.confirm("Approve?", "run bash")) ?? false);
		});

		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		prompt(2);
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
		await answer(0, "allow_always");
		await waitForResponse(2);

		// A new session is a new consent scope, and the agent's session id is
		// unchanged here, so only the switch can clear the answer.
		send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
		await waitForResponse(3);

		prompt(4, "hello again");
		await vi.waitFor(() => expect(permissionRequests()).toHaveLength(2));
		await answer(1, "allow_once");
		await waitForResponse(4);

		expect(answers).toEqual([true, true]);
	});
});

describe("acp additionalDirectories reporting", () => {
	test("reports workspace roots it cannot honour and still starts the session", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({
				jsonrpc: "2.0",
				id: 2,
				method: "session/new",
				params: { cwd: process.cwd(), mcpServers: [], additionalDirectories: ["/repo/packages", "/repo/apps"] },
			});
			// Refusing would strand the client, so the session starts and the gap
			// is reported instead.
			const created = await waitForResponse(2);
			expect(created.sessionId).toBe("session-1");

			const written = stderr.mock.calls.map((call) => String(call[0])).join("");
			expect(written).toContain("[acp] additionalDirectories is not honored");
			expect(written).toContain("/repo/packages");
			expect(written).toContain("/repo/apps");
		} finally {
			stderr.mockRestore();
		}
	});

	test("stays silent when the client grants no extra roots", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const session = createControlledSession();
			void runAcpMode(createHost(session));
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);

			send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			await waitForResponse(2);
			send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
			await waitForResponse(3);

			const written = stderr.mock.calls.map((call) => String(call[0])).join("");
			// A warning on every session switch would be noise that trains the
			// user to ignore stderr.
			expect(written).not.toContain("additionalDirectories");
		} finally {
			stderr.mockRestore();
		}
	});

	test("rejects a malformed additionalDirectories list instead of starting blind", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/new",
			params: { cwd: process.cwd(), mcpServers: [], additionalDirectories: [42] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { code?: number }).code).toBe(-32602);
	});

	test("contains a session/new runtime failure and keeps serving later requests", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		setHostMcpServerOverlay({ existing: { command: "existing-command" } });
		vi.mocked(host.newSession).mockRejectedValueOnce(new Error("disk full"));
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/new",
			params: { cwd: process.cwd(), mcpServers: [{ name: "replacement", command: "replacement-command" }] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect(error.error).toMatchObject({ code: -32603, message: "disk full" });
		expect(getHostMcpServerOverlay()).toEqual({ existing: { command: "existing-command" } });

		send({ jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: process.cwd() } });
		expect(await waitForResponse(3)).toHaveProperty("sessions");
	});

	test("restores the previous MCP servers when session/new is cancelled", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		setHostMcpServerOverlay({ existing: { command: "existing-command" } });
		vi.mocked(host.newSession).mockResolvedValueOnce({ cancelled: true });
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/new",
			params: { cwd: process.cwd(), mcpServers: [{ name: "replacement", command: "replacement-command" }] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect(error.error).toMatchObject({ code: -32003 });
		expect(getHostMcpServerOverlay()).toEqual({ existing: { command: "existing-command" } });
	});
});

/**
 * Write a session file where the manager looks for one.
 *
 * The lifecycle handlers resolve an id against what is on disk, so these tests
 * need a real file rather than a stubbed manager: the point is that a stored
 * session is genuinely found, switched to, replayed and deleted.
 */
async function writeStoredSession(
	cwd: string,
	entries: ReadonlyArray<Record<string, unknown>> = [],
): Promise<{ sessionId: string; path: string }> {
	const sessionId = randomUUID();
	const dir = getDefaultSessionDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		...entries,
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { sessionId, path };
}

function storedMessage(
	role: "user" | "assistant",
	content: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		type: "message",
		id: randomUUID(),
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role, content, timestamp: 1767225601000 },
	};
}

function sessionUpdates(): Array<Record<string, unknown>> {
	return parsedLines()
		.filter((line) => line.method === "session/update")
		.map((line) => (line.params as { update?: Record<string, unknown> }).update ?? {});
}

describe("acp session lifecycle methods", () => {
	// Every method here resolves a session id against the store, so they share
	// one fixture: a real session file under the isolated agent directory.

	test("session/list reports the stored sessions of one project", async () => {
		const stored = await writeStoredSession(process.cwd(), [
			storedMessage("user", [{ type: "text", text: "hello there" }]),
		]);
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: process.cwd() } });
		const result = await waitForResponse(2);
		const sessions = result.sessions as Array<Record<string, unknown>>;
		const listed = sessions.find((entry) => entry.sessionId === stored.sessionId);
		expect(listed).toBeDefined();
		expect(listed?.cwd).toBe(process.cwd());
		// The count travels in _meta because v1 has no field for it.
		expect((listed?._meta as { messageCount?: number }).messageCount).toBe(1);
	});

	test("session/list rejects a cursor it did not issue instead of replaying page one", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: process.cwd(), cursor: "not-a-cursor" } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { code?: number }).code).toBe(-32602);
		// Restarting from the first page would hand back sessions the client
		// already has, so the malformed cursor has to fail loudly.
	});

	test("session/list pages through a store larger than one page", async () => {
		// One more than a page, so the boundary is actually crossed rather than
		// assumed.
		const stored = [];
		for (let i = 0; i < 101; i++) {
			stored.push(await writeStoredSession(process.cwd()));
		}
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: process.cwd() } });
		const first = await waitForResponse(2);
		const firstPage = first.sessions as Array<Record<string, unknown>>;
		expect(firstPage).toHaveLength(100);
		// The cursor is what lets a client keep going; without it the last
		// session is unreachable.
		const cursor = first.nextCursor as string;
		expect(cursor).toMatch(/^\d+$/);

		send({ jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: process.cwd(), cursor } });
		const second = await waitForResponse(3);
		const secondPage = second.sessions as Array<Record<string, unknown>>;
		expect(secondPage).toHaveLength(1);
		// No cursor on the last page is how the protocol says "no more".
		expect(second.nextCursor).toBeUndefined();
		// The two pages must not overlap, or paging replays sessions.
		const seen = new Set(firstPage.map((entry) => entry.sessionId));
		expect(secondPage.every((entry) => !seen.has(entry.sessionId))).toBe(true);
	});

	test("session/list answers an empty list for a project with no sessions", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/list", params: { cwd: process.cwd() } });
		const result = await waitForResponse(2);
		expect(result.sessions).toEqual([]);
	});

	test("session/load reports an unknown session instead of switching", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/load",
			params: { sessionId: "no-such-session", cwd: process.cwd(), mcpServers: [] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Session not found");
		// Switching to nothing would silently drop the caller's session.
		expect(host.switchSession).not.toHaveBeenCalled();
	});

	test("session/load switches to a stored session and answers with its selectors", async () => {
		const stored = await writeStoredSession(process.cwd());
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/load",
			params: { sessionId: stored.sessionId, cwd: process.cwd(), mcpServers: [] },
		});
		const result = await waitForResponse(2);
		expect(host.switchSession).toHaveBeenCalledWith(stored.path, { cwdOverride: process.cwd() });
		// The client needs the selectors to render the session it just loaded.
		expect(result.modes).toBeDefined();
		expect(Array.isArray(result.configOptions)).toBe(true);
	});

	test.each(["session/load", "session/resume"])(
		"%s reports cancellation without replaying or changing sessions",
		async (method) => {
			const stored = await writeStoredSession(process.cwd(), [
				storedMessage("user", [{ type: "text", text: "do not replay" }]),
			]);
			const session = createControlledSession();
			const host = createHost(session);
			setHostMcpServerOverlay({ existing: { command: "existing-command" } });
			vi.mocked(host.switchSession).mockResolvedValueOnce({ cancelled: true });
			void runAcpMode(host);
			send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
			await waitForResponse(1);
			send({
				jsonrpc: "2.0",
				id: 2,
				method,
				params: {
					sessionId: stored.sessionId,
					cwd: process.cwd(),
					mcpServers: [{ name: "replacement", command: "replacement-command" }],
				},
			});
			const error = await waitForLine((line) => line.id === 2 && "error" in line);
			expect(error.error).toMatchObject({ code: -32800 });
			expect(getHostMcpServerOverlay()).toEqual({ existing: { command: "existing-command" } });
			expect(sessionUpdates()).toEqual([]);
			expect(host.session.sessionId).toBe("session-1");
		},
	);

	test("session/load refuses a session stored under another working directory", async () => {
		const otherCwd = join(process.cwd(), "src");
		const stored = await writeStoredSession(otherCwd);
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/load",
			params: { sessionId: stored.sessionId, cwd: process.cwd(), mcpServers: [] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("cwd does not match");
		expect(host.switchSession).not.toHaveBeenCalled();
	});

	test("session/resume reports an unknown session instead of resuming", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/resume",
			params: { sessionId: "no-such-session", cwd: process.cwd(), mcpServers: [] },
		});
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Session not found");
		expect(host.switchSession).not.toHaveBeenCalled();
	});

	test("session/resume never replays the stored transcript", async () => {
		const stored = await writeStoredSession(process.cwd(), [
			storedMessage("user", [{ type: "text", text: "what changed?" }]),
			storedMessage("assistant", [
				{ type: "thinking", thinking: "checking the diff" },
				{ type: "text", text: "Two files changed." },
			]),
		]);
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/resume",
			params: {
				sessionId: stored.sessionId,
				cwd: process.cwd(),
				mcpServers: [],
				// A client that asks anyway gets the spec answer, not the transcript:
				// resume reattaches to a session the client is already showing.
				replayFrom: { type: "start" },
			},
		});
		await waitForResponse(2);
		expect(sessionUpdates()).toEqual([]);
		expect(host.switchSession).toHaveBeenCalledWith(stored.path, { cwdOverride: process.cwd() });
	});

	test("session/load replays the stored transcript before it answers", async () => {
		const stored = await writeStoredSession(process.cwd(), [
			storedMessage("user", [{ type: "text", text: "what changed?" }]),
			storedMessage("assistant", [
				{ type: "thinking", thinking: "checking the diff" },
				{ type: "text", text: "Two files changed." },
			]),
		]);
		const session = createControlledSession();
		const host = createHost(session);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/load",
			params: { sessionId: stored.sessionId, cwd: process.cwd(), mcpServers: [] },
		});
		await waitForResponse(2);
		// v1 has no image chunk kind, so an image part would arrive as a text
		// placeholder; text and thinking parts must arrive verbatim.
		expect(sessionUpdates()).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "what changed?" } },
			{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking the diff" } },
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two files changed." } },
		]);
		expect(host.switchSession).toHaveBeenCalledWith(stored.path, { cwdOverride: process.cwd() });
	});

	test("session/delete refuses to delete the active session", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/delete", params: { sessionId: "session-1" } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Cannot delete the active session");
	});

	test("session/delete reports an unknown session", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/delete", params: { sessionId: "no-such-session" } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Session not found");
	});

	test("session/delete removes a stored session file and answers once", async () => {
		const stored = await writeStoredSession(process.cwd());
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/delete", params: { sessionId: stored.sessionId } });
		await waitForResponse(2);
		expect(existsSync(stored.path)).toBe(false);
		// One request must get exactly one reply. The failure path used to answer
		// twice: the error and then the success.
		const replies = parsedLines().filter((line) => line.id === 2);
		expect(replies).toHaveLength(1);
	});

	test("session/delete answers once with an error when the file cannot be removed", async () => {
		const stored = await writeStoredSession(process.cwd());
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		// A locked or permission-denied file is the realistic failure, and
		// it used to produce two replies: the error, then the success.
		vi.mocked(unlink).mockRejectedValueOnce(new Error("EBUSY: resource busy or locked"));

		send({ jsonrpc: "2.0", id: 2, method: "session/delete", params: { sessionId: stored.sessionId } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Failed to delete session");
		// The file is still there, so the client is told it failed rather than
		// left believing a session it can still load was gone.
		expect(existsSync(stored.path)).toBe(true);
		const replies = parsedLines().filter((line) => line.id === 2);
		expect(replies).toHaveLength(1);
		expect("error" in replies[0]).toBe(true);
	});

	test("session/close refuses a sessionId that is not the active one", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "some-other-session" } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect((error.error as { message?: string }).message).toContain("Unknown sessionId");
		expect(session.abort).not.toHaveBeenCalled();
	});

	test("session/close rebinds the replacement session and keeps the old file", async () => {
		const stored = await writeStoredSession(process.cwd());
		const session = createControlledSession();
		const replacement = createControlledSession();
		replacement.sessionId = "session-2";
		const host = createHost(session);
		let rebind: ((session: AgentSession) => Promise<void>) | undefined;
		vi.mocked(host.setRebindSession).mockImplementation((callback) => {
			rebind = callback;
		});
		vi.mocked(host.newSession).mockImplementation(async () => {
			Object.assign(host, { session: replacement });
			await rebind?.(replacement as unknown as AgentSession);
			return { cancelled: false };
		});
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "session-1" } });
		await waitForResponse(2);
		expect(session.abort).toHaveBeenCalled();
		expect(existsSync(stored.path)).toBe(true);

		send({
			jsonrpc: "2.0",
			id: 3,
			method: "session/prompt",
			params: { sessionId: "session-2", prompt: [{ type: "text", text: "after close" }] },
		});
		expect(await waitForResponse(3)).toEqual({ stopReason: "end_turn" });
		expect(replacement.prompt).toHaveBeenCalledWith("after close", { images: [], source: "acp" });
	});

	test("session/close rejects new prompts until the replacement has settled", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		let finishClose = () => {};
		vi.mocked(host.newSession).mockImplementation(
			() =>
				new Promise<{ cancelled: boolean }>((resolve) => {
					finishClose = () => resolve({ cancelled: false });
				}),
		);
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "session-1" } });
		await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1));

		send({
			jsonrpc: "2.0",
			id: 3,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "during close" }] },
		});
		const rejected = await waitForLine((line) => line.id === 3 && "error" in line);
		expect(rejected.error).toMatchObject({ code: -32003, message: "Session close is in progress" });
		expect(session.prompt).not.toHaveBeenCalled();
		finishClose();
		await waitForResponse(2);
	});

	test("session/close restores MCP servers when replacement creation fails", async () => {
		const session = createControlledSession();
		const host = createHost(session);
		setHostMcpServerOverlay({ existing: { command: "existing-command" } });
		vi.mocked(host.newSession).mockRejectedValueOnce(new Error("teardown failed"));
		void runAcpMode(host);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);
		send({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "session-1" } });
		const error = await waitForLine((line) => line.id === 2 && "error" in line);
		expect(error.error).toMatchObject({ code: -32603, message: "teardown failed" });
		expect(getHostMcpServerOverlay()).toEqual({ existing: { command: "existing-command" } });
	});

	test("logout clears the stored credential and answers", async () => {
		const session = createControlledSession();
		void runAcpMode(createHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
		await waitForResponse(1);

		send({ jsonrpc: "2.0", id: 2, method: "logout", params: {} });
		await waitForResponse(2);
		// The selector has to drop the credential that is no longer there.
		expect(session.modelRuntime.getAvailable).toHaveBeenCalled();
	});
});
