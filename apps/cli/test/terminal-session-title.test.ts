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
