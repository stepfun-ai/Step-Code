import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createStepCode } from "../src/stepcode-runtime.ts";

interface SessionStub {
	session: AgentSession;
	emit(event: AgentSessionEvent): void;
}

function createSessionStub(sessionId: string): SessionStub {
	const listeners = new Set<AgentSessionEventListener>();
	const session = {
		sessionId,
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		sendUserMessage: vi.fn(async () => {}),
		clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
		abort: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(),
	} as unknown as AgentSession;

	return {
		session,
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
	};
}

describe("StepCode", () => {
	test("rebinds event subscriptions when pi replaces the session", async () => {
		const first = createSessionStub("session-1");
		const second = createSessionStub("session-2");
		let current = first.session;
		const sessionChangeListeners = new Set<(session: AgentSession) => void>();
		const removeSessionChange = vi.fn();
		const runtime = {
			get session() {
				return current;
			},
			onSessionChange(listener: (session: AgentSession) => void) {
				sessionChangeListeners.add(listener);
				return () => {
					if (sessionChangeListeners.delete(listener)) removeSessionChange();
				};
			},
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;

		const events: AgentSessionEvent[] = [];
		const cli = createStepCode(runtime);
		cli.subscribe((event) => events.push(event));
		const externalSessionChange = vi.fn();
		cli.onSessionChange(externalSessionChange);

		first.emit({ type: "session_info_changed", name: "first" });
		current = second.session;
		for (const listener of [...sessionChangeListeners]) listener(second.session);
		expect(externalSessionChange).toHaveBeenCalledWith(second.session);
		first.emit({ type: "session_info_changed", name: "stale" });
		second.emit({ type: "session_info_changed", name: "second" });

		expect(events.map((event) => event.type)).toEqual(["session_info_changed", "session_info_changed"]);
		expect(cli.sessionId).toBe("session-2");

		await cli.input("hello");
		expect(second.session.prompt).toHaveBeenCalledWith("hello", {
			images: undefined,
			streamingBehavior: undefined,
			source: "rpc",
		});
		expect(first.session.prompt).not.toHaveBeenCalled();
		await cli.inputContent(
			[
				{ type: "text", text: "with" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "content" },
			],
			{ deliverAs: "followUp" },
		);
		expect(second.session.sendUserMessage).toHaveBeenCalledWith(
			[
				{ type: "text", text: "with" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "content" },
			],
			{ deliverAs: "followUp", source: "rpc" },
		);
		await cli.steer("urgent");
		await cli.followUp("later");
		expect(second.session.steer).toHaveBeenCalledWith("urgent", undefined);
		expect(second.session.followUp).toHaveBeenCalledWith("later", undefined);
		const queued = cli.clearQueue();
		expect(second.session.clearQueue).toHaveBeenCalledTimes(1);
		expect(queued).toEqual({ steering: [], followUp: [] });

		await cli.dispose();
		expect(removeSessionChange).toHaveBeenCalledTimes(2);
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		second.emit({ type: "session_info_changed", name: "after dispose" });
		expect(events).toHaveLength(2);
		expect(() => cli.clearQueue()).toThrow("disposed");
	});

	test("forwards runtime lifecycle operations without owning them", async () => {
		const session = createSessionStub("session-1");
		const runtime = {
			get session() {
				return session.session;
			},
			services: { cwd: "/workspace", agentDir: "/agent" },
			cwd: "/workspace",
			diagnostics: [],
			modelFallbackMessage: undefined,
			onSessionChange: vi.fn(() => () => {}),
			setRebindSession: vi.fn(),
			setBeforeSessionInvalidate: vi.fn(),
			newSession: vi.fn(async () => ({ cancelled: false })),
			switchSession: vi.fn(async () => ({ cancelled: false })),
			fork: vi.fn(async () => ({ cancelled: false, selectedText: "picked" })),
			importFromJsonl: vi.fn(async () => ({ cancelled: false })),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;

		const cli = createStepCode(runtime);
		const rebind = vi.fn(async () => {});
		const invalidate = vi.fn();
		cli.setRebindSession(rebind);
		cli.setBeforeSessionInvalidate(invalidate);
		expect(cli.cwd).toBe("/workspace");
		expect(cli.services.agentDir).toBe("/agent");
		expect(await cli.newSession()).toEqual({ cancelled: false });
		expect(await cli.switchSession("session.jsonl")).toEqual({ cancelled: false });
		expect(await cli.fork("entry-1")).toEqual({ cancelled: false, selectedText: "picked" });
		expect(await cli.importFromJsonl("import.jsonl", "/workspace")).toEqual({ cancelled: false });
		expect(runtime.setRebindSession).toHaveBeenCalledWith(rebind);
		expect(runtime.setBeforeSessionInvalidate).toHaveBeenCalledWith(invalidate);
		expect(runtime.newSession).toHaveBeenCalledTimes(1);
		expect(runtime.switchSession).toHaveBeenCalledWith("session.jsonl", undefined);
		expect(runtime.fork).toHaveBeenCalledWith("entry-1", undefined);
		expect(runtime.importFromJsonl).toHaveBeenCalledWith("import.jsonl", "/workspace");

		await cli.dispose();
	});

	test("shares the in-flight disposal promise across concurrent callers", async () => {
		let resolveDispose!: () => void;
		const pendingDispose = new Promise<void>((resolve) => {
			resolveDispose = resolve;
		});
		const session = createSessionStub("session-1");
		const runtime = {
			get session() {
				return session.session;
			},
			onSessionChange: vi.fn(() => () => {}),
			dispose: vi.fn(() => pendingDispose),
		} as unknown as AgentSessionRuntime;
		const cli = createStepCode(runtime);

		const first = cli.dispose();
		const second = cli.dispose();
		expect(second).toBe(first);
		expect(runtime.dispose).toHaveBeenCalledTimes(1);

		let settled = false;
		void second.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveDispose();
		await Promise.all([first, second]);
		expect(settled).toBe(true);
	});
});
