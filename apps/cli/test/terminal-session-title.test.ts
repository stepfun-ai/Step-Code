import { describe, expect, it, vi } from "vitest";
import { APP_TITLE, SessionManager } from "@step-harness/coding-agent";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

describe("terminal session title", () => {
	it.each(["Login timeout investigation", "\u767b\u5f55\u63a5\u53e3\u8d85\u65f6\u6392\u67e5"])(
		"shows only the session name: %s",
		(name) => {
			const sessionManager = SessionManager.inMemory("/workspace/project");
			sessionManager.appendSessionInfo(name);
			const setTitle = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
			Object.assign(mode, {
				runtimeHost: { session: { sessionManager } },
				ui: { terminal: { setTitle } },
			});
			mode.updateTerminalTitle();
			expect(setTitle).toHaveBeenCalledExactlyOnceWith(name);
		},
	);

	it("keeps the product and directory fallback when the session name is absent or cleared", () => {
		const sessionManager = SessionManager.inMemory("/workspace/project");
		const setTitle = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			runtimeHost: { session: { sessionManager } },
			ui: { terminal: { setTitle } },
		});
		mode.updateTerminalTitle();
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - project`);
		sessionManager.appendSessionInfo("Manual title");
		mode.updateTerminalTitle();
		expect(setTitle).toHaveBeenLastCalledWith("Manual title");
		sessionManager.appendSessionInfo("");
		mode.updateTerminalTitle();
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - project`);
	});
});

describe("/name without an argument", () => {
	function nameMode(reply: string | undefined) {
		const sessionManager = SessionManager.inMemory("/workspace/project");
		const completeSimple = vi.fn(async () => ({
			role: "assistant" as const,
			content: reply === undefined ? [] : [{ type: "text" as const, text: reply }],
			stopReason: "stop" as const,
		}));
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			runtimeHost: {
				session: {
					sessionManager,
					model: { id: "test-model", provider: "test" },
					modelRuntime: { completeSimple },
					setSessionName: (name: string) => sessionManager.appendSessionInfo(name),
				},
			},
			showStatus,
			showWarning,
		});
		return { mode, sessionManager, completeSimple, showStatus, showWarning };
	}

	it("regenerates the name from the conversation", async () => {
		const h = nameMode("登录接口超时修复");
		h.sessionManager.appendMessage({ role: "user", content: "修复登录接口超时", timestamp: 0 });
		h.sessionManager.appendSessionInfo("修复登录接口超时");
		h.mode.handleNameCommand("/name");
		await vi.waitFor(() => expect(h.showStatus).toHaveBeenLastCalledWith("Session name set: 登录接口超时修复"));
		expect(h.showStatus).toHaveBeenCalledWith("Generating session name (current: 修复登录接口超时)...");
		expect(h.sessionManager.getSessionName()).toBe("登录接口超时修复");
	});

	it("explains when there is nothing to summarize yet", async () => {
		const h = nameMode("unused");
		h.mode.handleNameCommand("/name   ");
		await vi.waitFor(() =>
			expect(h.showWarning).toHaveBeenCalledWith("Nothing to name yet. Send a message first, or use /name <name>"),
		);
		expect(h.completeSimple).not.toHaveBeenCalled();
	});

	it("keeps the current name when generation fails", async () => {
		const h = nameMode(undefined);
		h.sessionManager.appendMessage({ role: "user", content: "修复登录接口超时", timestamp: 0 });
		h.sessionManager.appendSessionInfo("人工标题");
		h.mode.handleNameCommand("/name");
		await vi.waitFor(() =>
			expect(h.showWarning).toHaveBeenCalledWith(
				"Could not generate a session name. Use /name <name> to set one manually",
			),
		);
		expect(h.sessionManager.getSessionName()).toBe("人工标题");
	});
});
