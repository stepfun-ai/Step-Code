import { APP_TITLE, initTheme, SessionManager } from "@step-harness/coding-agent";
import { Container } from "@step-harness/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

function createMode() {
	initTheme("dark", false);
	const sessionManager = SessionManager.inMemory("/workspace/project");
	const setTitle = vi.fn();
	const showWarning = vi.fn();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		runtimeHost: { session: { sessionManager, setSessionName: (name: string) => sessionManager.appendSessionInfo(name) } },
		ui: { terminal: { setTitle } },
		chatContainer: new Container(),
		_redraw: { requestRender: vi.fn() },
		showWarning,
	});
	return { mode, sessionManager, setTitle, showWarning };
}

describe("terminal session title", () => {
	it.each(["Login timeout investigation", "登录接口超时排查"])("shows only the session name: %s", (name) => {
		const h = createMode();
		h.sessionManager.appendSessionInfo(name);
		h.mode.updateTerminalTitle();
		expect(h.setTitle).toHaveBeenCalledExactlyOnceWith(name);
	});

	it("keeps the product and directory fallback when the name is absent or cleared", () => {
		const h = createMode();
		h.mode.updateTerminalTitle();
		expect(h.setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - project`);
		h.sessionManager.appendSessionInfo("Manual title");
		h.mode.updateTerminalTitle();
		expect(h.setTitle).toHaveBeenLastCalledWith("Manual title");
		h.sessionManager.appendSessionInfo("");
		h.mode.updateTerminalTitle();
		expect(h.setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - project`);
	});

	it("shows the current name without changing metadata or requiring a model", () => {
		const h = createMode();
		h.sessionManager.appendSessionInfo("人工名称");
		h.mode.handleNameCommand("/name");
		expect(h.mode.chatContainer.render(80).join("\n")).toContain("Session name: 人工名称");
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "session_info")).toHaveLength(1);
	});

	it("shows usage when unnamed and persists explicit names synchronously", () => {
		const h = createMode();
		h.mode.handleNameCommand("/name");
		expect(h.showWarning).toHaveBeenCalledWith("Usage: /name <name>");
		h.mode.handleNameCommand("/name 人工名称");
		expect(h.sessionManager.getSessionName()).toBe("人工名称");
		expect(h.mode.chatContainer.render(80).join("\n")).toContain("Session name set: 人工名称");
	});
});
