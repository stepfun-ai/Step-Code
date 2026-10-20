import { describe, expect, it, vi } from "vitest";
import { APP_TITLE, initTheme, SessionManager } from "@step-harness/coding-agent";
import { Container } from "@step-harness/pi-tui";
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
		initTheme("dark", false);
		const sessionManager = SessionManager.inMemory("/workspace/project");
		const completeSimple = vi.fn(async () => ({
			role: "assistant" as const,
			content: reply === undefined ? [] : [{ type: "text" as const, text: reply }],
			stopReason: "stop" as const,
		}));
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const session = {
			sessionManager,
			model: { id: "test-model", provider: "test" },
			modelRuntime: { completeSimple },
			setSessionName: (name: string) => sessionManager.appendSessionInfo(name),
		};
		const runtimeHost = { session };
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			runtimeHost,
			showStatus,
			showWarning,
			showError: vi.fn(),
			chatContainer: new Container(),
			_redraw: { requestRender: vi.fn() },
			withExtensionDialogsBlocked: vi.fn(),
		});
		return { mode, sessionManager, completeSimple, showStatus, showWarning, runtimeHost };
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

	it.each(["invalidate", "stop"] as const)("discards a late title after %s", async (action) => {
		const h = nameMode("unused");
		let resolve: (value: Awaited<ReturnType<typeof h.completeSimple>>) => void = () => {};
		h.completeSimple.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		h.sessionManager.appendMessage({ role: "user", content: "修复登录接口超时", timestamp: 0 });
		h.sessionManager.appendSessionInfo("原名称");
		h.mode.handleNameCommand("/name");
		const signal = h.mode.nameRequest!.signal;
		if (action === "invalidate") {
			(h.mode as unknown as { resetExtensionUI(): void }).resetExtensionUI();
			h.runtimeHost.session = { ...h.runtimeHost.session, sessionManager: SessionManager.inMemory() };
		} else {
			h.mode.stop("transcript");
		}
		expect(signal.aborted).toBe(true);
		resolve({ role: "assistant", content: [{ type: "text", text: "迟到名称" }], stopReason: "stop" });
		await vi.waitFor(() => expect(h.mode.nameRequest).toBeUndefined());
		expect(h.sessionManager.getSessionName()).toBe("原名称");
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "session_info")).toHaveLength(1);
		expect(h.showStatus).toHaveBeenCalledTimes(1);
		expect(h.showWarning).not.toHaveBeenCalled();
	});

	it("cancels the earlier request when /name is run again", async () => {
		const h = nameMode("新名称");
		let resolve: (value: Awaited<ReturnType<typeof h.completeSimple>>) => void = () => {};
		h.completeSimple.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		h.sessionManager.appendMessage({ role: "user", content: "修复登录接口超时", timestamp: 0 });
		h.mode.handleNameCommand("/name");
		const firstSignal = h.mode.nameRequest!.signal;
		h.mode.handleNameCommand("/name");
		expect(firstSignal.aborted).toBe(true);
		await vi.waitFor(() => expect(h.sessionManager.getSessionName()).toBe("新名称"));
		resolve({ role: "assistant", content: [{ type: "text", text: "旧名称" }], stopReason: "stop" });
		await new Promise((done) => setTimeout(done, 0));
		expect(h.sessionManager.getSessionName()).toBe("新名称");
	});

	it("sets a manual name and cancels pending generation", async () => {
		const h = nameMode("unused");
		let resolve: (value: Awaited<ReturnType<typeof h.completeSimple>>) => void = () => {};
		h.completeSimple.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		h.sessionManager.appendMessage({ role: "user", content: "修复登录接口超时", timestamp: 0 });
		h.mode.handleNameCommand("/name");
		const signal = h.mode.nameRequest!.signal;
		h.mode.handleNameCommand("/name 人工名称");
		expect(signal.aborted).toBe(true);
		expect(h.sessionManager.getSessionName()).toBe("人工名称");
		await vi.waitFor(() => expect(h.mode.nameRequest).toBeUndefined());
		expect(h.mode.chatContainer.render(80).join("\n")).toContain("Session name set: 人工名称");
		resolve({ role: "assistant", content: [{ type: "text", text: "迟到名称" }], stopReason: "stop" });
		await new Promise((done) => setTimeout(done, 0));
		expect(h.sessionManager.getSessionName()).toBe("人工名称");
	});
});
