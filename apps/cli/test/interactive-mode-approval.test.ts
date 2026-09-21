import { Container, Input, setKeybindings, stripTerminalSequences, Text } from "@step-harness/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { ExtensionContext, ExtensionUIContext } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import type { ExtensionInputComponent } from "../src/ui/view/dialogs/extension-input.ts";
import type { ExtensionSelectorComponent } from "../src/ui/view/dialogs/extension-selector.ts";
import {
	WorkingOutputTracker,
	type WorkingStatusIndicator,
} from "../src/ui/view/chrome/status-indicator.ts";
import { StepToolSpinnerClock } from "../src/ui/view/transcript/step-spinner.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { StepPermissionController } from "../../../packages/coding-agent/src/step/permissions.ts";

// Run real dialog/status/TUI methods without loading user configuration or a
// runtime session. Only unrelated extension reset services are stubbed.
interface ApprovalTestMode {
	activeStatusIndicator?: WorkingStatusIndicator;
	extensionSelector?: ExtensionSelectorComponent;
	extensionInput?: ExtensionInputComponent;
	footerContainer: Container;
	createExtensionUIContext(): ExtensionUIContext;
	showWorkingStatusIndicator(): void;
	clearStatusIndicator(): void;
	hideExtensionSelector(): void;
	hideExtensionInput(): void;
	resetExtensionUI(): void;
	stop(): void;
}
const cleanups: Array<() => void> = [];

function createHarness(columns = 80, rows = 24, render = false) {
	initTheme("step-blue");
	setKeybindings(new KeybindingsManager());
	const terminal = new VirtualTerminal(columns, rows);
	const ui = new TuiMainScreen(terminal);
	const requestRender = vi.spyOn(ui, "requestRender");
	// Fake-time tests observe component timers, not renderer scheduling. The
	// viewport tests use the unmodified rendering pipeline.
	if (!render) requestRender.mockImplementation(() => {});
	const editor = Object.assign(new Input(), {
		// showExtensionCustom saves and restores the editor text; Input spells that
		// pair getValue/setValue.
		getText(): string {
			return editor.getValue();
		},
		setText(text: string): void {
			editor.setValue(text);
		},
	});
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const statusContainer = new Container();
	const chatContainer = new Container();
	chatContainer.addChild(new Text(Array.from({ length: 60 }, (_, i) => `Transcript ${i}`).join("\n"), 0, 0));
	const footer = Object.assign(new Text("FOOTER", 0, 0), { dispose: vi.fn() });
	const footerContainer = new Container();
	footerContainer.addChild(footer);
	const spinner = new StepToolSpinnerClock(() => ui.requestRender());
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as ApprovalTestMode, {
		runtimeHost: {
			session: {
				isStreaming: true,
				settingsManager: {
					getShowTerminalProgress: () => false,
					getFullscreenExitOutput: () => "none",
				},
			},
		},
		ui,
		options: { tuiStyle: "step", tuiMode: "regular" },
		editor,
		defaultEditor: editor,
		editorContainer,
		statusContainer,
		chatContainer,
		footer,
		footerContainer,
		footerDataProvider: { clearExtensionStatuses: vi.fn(), dispose: vi.fn() },
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		extensionTerminalInputSubscriptions: new Set(),
		signalCleanupHandlers: [],
		themeController: { disableAutoSync: vi.fn() },
		stepSpinner: spinner,
		workingOutputTracker: new WorkingOutputTracker(),
		workingVisible: true,
		waitingForApproval: false,
		workingMessage: "Custom work",
		defaultWorkingMessage: "Working...",
		defaultHiddenThinkingLabel: "Thinking...",
		workingIndicatorOptions: { frames: ["A", "B"], intervalMs: 500 },
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		updateTerminalTitle: vi.fn(),
	});
	ui.addChild(chatContainer);
	ui.addChild(statusContainer);
	ui.addChild(editorContainer);
	ui.addChild(footerContainer);
	ui.setFocus(editor);
	mode.showWorkingStatusIndicator();
	spinner.start("call-1", "run_command");
	cleanups.push(() => {
		mode.hideExtensionSelector();
		mode.hideExtensionInput();
		mode.clearStatusIndicator();
		spinner.dispose();
		ui.stop();
	});
	return {
		mode,
		api: mode.createExtensionUIContext(),
		ui,
		terminal,
		spinner,
		requestRender,
		editor,
		statusText: () => stripTerminalSequences(statusContainer.render(columns).join("\n")),
	};
}

function onNextEditorRefocus(editor: Input, callback: () => void): void {
	let focused = editor.focused;
	let onRefocus: (() => void) | undefined = callback;
	Object.defineProperty(editor, "focused", {
		configurable: true,
		get: () => focused,
		set: (value: boolean) => {
			focused = value;
			if (value) {
				const next = onRefocus;
				onRefocus = undefined;
				next?.();
			}
		},
	});
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	initTheme("dark");
});

describe("interactive approval lifecycle", () => {
	beforeEach(() => vi.useFakeTimers());

	it.each(["approve", "deny", "escape", "abort", "timeout"] as const)(
		"pauses running UI until %s",
		async (outcome) => {
			const { mode, api, spinner, requestRender, statusText, ui, editor } = createHarness();
			const abort = new AbortController();
			const result = api.confirm("Approve run_command [12345678]", "A command", {
				signal: abort.signal,
				timeout: outcome === "timeout" ? 1000 : undefined,
			});
			expect(statusText()).toContain("Waiting for approval");
			expect(statusText()).not.toContain("tokens");
			if (outcome !== "timeout") {
				const renders = requestRender.mock.calls.length;
				vi.advanceTimersByTime(30_000);
				expect(requestRender).toHaveBeenCalledTimes(renders);
				expect(spinner.elapsedSeconds("call-1")).toBe(0);
			}
			if (outcome === "abort") abort.abort();
			else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(1000);
			else {
				if (outcome === "deny") mode.extensionSelector?.handleInput("\x1b[B");
				mode.extensionSelector?.handleInput(outcome === "escape" ? "\x1b" : "\r");
			}
			expect(await result).toBe(outcome === "approve");
			expect(mode.extensionSelector?.constructor.name).toBeUndefined();
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(statusText()).toContain("A Custom work");
			expect(statusText()).not.toContain("Waiting for approval");
			vi.advanceTimersByTime(1000);
			expect(spinner.elapsedSeconds("call-1")).toBe(1);
		},
	);

	it("lets a custom dialog take the approval hold and hide the footer", async () => {
		const { mode, api, spinner, requestRender, statusText, ui, editor } = createHarness();
		let close: ((value: string) => void) | undefined;
		const dialogComponent = Object.assign(new Text("PLAN REVIEW", 0, 0), {
			focused: false,
			handleInput: () => {},
		});
		const result = api.custom<string>(
			(_tui, _theme, _keybindings, done) => {
				close = done;
				return dialogComponent;
			},
			{ hideFooter: true, waitingForApproval: true },
		);
		await flushMicrotasks();

		expect(mode.footerContainer.children).toHaveLength(0);
		expect(statusText()).toContain("Waiting for approval");
		const renders = requestRender.mock.calls.length;
		vi.advanceTimersByTime(30_000);
		expect(requestRender).toHaveBeenCalledTimes(renders);
		expect(spinner.elapsedSeconds("call-1")).toBe(0);

		close?.("done");
		expect(await result).toBe("done");
		await flushMicrotasks();
		expect(mode.footerContainer.children).toHaveLength(1);
		expect(statusText()).not.toContain("Waiting for approval");
		expect(ui.getFocusedComponent()).toBe(editor);
		vi.advanceTimersByTime(1000);
		expect(spinner.elapsedSeconds("call-1")).toBe(1);
	});

	it("leaves the footer and the animations alone for a plain custom dialog", async () => {
		const { mode, api, statusText } = createHarness();
		let close: ((value: string) => void) | undefined;
		const result = api.custom<string>((_tui, _theme, _keybindings, done) => {
			close = done;
			return Object.assign(new Text("WIDGET", 0, 0), { focused: false, handleInput: () => {} });
		});
		await flushMicrotasks();

		expect(mode.footerContainer.children).toHaveLength(1);
		expect(statusText()).not.toContain("Waiting for approval");

		close?.("done");
		expect(await result).toBe("done");
	});

	it("preserves preferences and waiting when the working indicator is recreated", async () => {
		const { mode, api, statusText, spinner } = createHarness();
		const result = api.confirm("Approve", "Command");
		const previous = mode.activeStatusIndicator;
		api.setWorkingVisible(false);
		api.setWorkingMessage("Updated work");
		api.setWorkingIndicator({ frames: ["X", "Y"], intervalMs: 1000 });
		api.setWorkingVisible(true);
		expect(mode.activeStatusIndicator).not.toBe(previous);
		expect(statusText()).toContain("Waiting for approval");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(spinner.elapsedSeconds("call-1")).toBe(0);
		mode.extensionSelector?.handleInput("\r");
		expect(await result).toBe(true);
		expect(statusText()).toContain("X Updated work");
		vi.advanceTimersByTime(1000);
		expect(statusText()).toContain("Y Updated work");
	});

	it.each(["select", "input"] as const)("does not label a normal %s as approval", async (kind) => {
		const { mode, api, statusText, requestRender } = createHarness();
		const result = kind === "select" ? api.select("Choose", ["one", "two"]) : api.input("Name");
		expect(statusText()).not.toContain("Waiting for approval");
		const renders = requestRender.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(requestRender.mock.calls.length).toBeGreaterThan(renders);
		(mode.extensionSelector ?? mode.extensionInput)?.handleInput("\x1b");
		expect(await result).toBeUndefined();
	});

	it("leaves the current approval intact if a replacement is already aborted", async () => {
		const { mode, api, statusText } = createHarness();
		const result = api.confirm("First", "Command");
		const first = mode.extensionSelector;
		const abort = new AbortController();
		abort.abort();
		expect(await api.confirm("Aborted", "Command", { signal: abort.signal })).toBe(false);
		expect(mode.extensionSelector).toBe(first);
		expect(statusText()).toContain("Waiting for approval");
		first?.handleInput("\x1b");
		expect(await result).toBe(false);
	});

	it.each([false, true])("settles replacement and ignores stale callbacks (overlay=%s)", async (overlay) => {
		const { mode, api, ui, statusText } = createHarness();
		const abort = new AbortController();
		const settled = vi.fn();
		void api.confirm("First", "Command", { signal: abort.signal, timeout: 1000, overlay }).then(settled);
		const first = mode.extensionSelector;
		const result = api.confirm("Second", "Command", { overlay });
		const second = mode.extensionSelector;
		await flushMicrotasks();
		expect(settled).toHaveBeenCalledExactlyOnceWith(false);
		abort.abort();
		first?.handleInput("\r");
		await vi.advanceTimersByTimeAsync(1000);
		expect(mode.extensionSelector).toBe(second);
		expect(ui.getFocusedComponent()).toBe(second);
		expect(statusText()).toContain("Waiting for approval");
		second?.handleInput("\x1b");
		expect(await result).toBe(false);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"keeps a confirmation opened during focus restoration paused (overlay=%s)",
		async (overlay) => {
			const { mode, api, editor, ui, spinner, requestRender, statusText } = createHarness();
			const firstResult = api.confirm("First", "Command", { overlay });
			const first = mode.extensionSelector;
			let secondResult: Promise<boolean> | undefined;
			onNextEditorRefocus(editor, () => {
				secondResult = api.confirm("Second", "Command", { overlay });
			});
			first?.handleInput("\x1b");
			expect(await firstResult).toBe(false);
			expect(secondResult).toBeDefined();
			expect(mode.extensionSelector === first).toBe(false);
			expect(ui.getFocusedComponent() === mode.extensionSelector).toBe(true);
			expect(statusText()).toContain("Waiting for approval");
			const renders = requestRender.mock.calls.length;
			vi.advanceTimersByTime(5000);
			expect(requestRender).toHaveBeenCalledTimes(renders);
			expect(spinner.elapsedSeconds("call-1")).toBe(0);
			mode.extensionSelector?.handleInput("\x1b");
			expect(await secondResult).toBe(false);
		},
	);

	it.each(["confirm-to-input", "input-to-confirm"] as const)(
		"settles cross-kind replacement: %s",
		async (direction) => {
			const { mode, api, ui, statusText } = createHarness();
			const abort = new AbortController();
			const settled = vi.fn();
			const opts = { signal: abort.signal, timeout: 1000, overlay: true };
			const firstResult =
				direction === "confirm-to-input" ? api.confirm("First", "Command", opts) : api.input("First", "", opts);
			void firstResult.then(settled);
			const first = mode.extensionSelector ?? mode.extensionInput;
			const result =
				direction === "confirm-to-input"
					? api.input("Second", "", { overlay: true })
					: api.confirm("Second", "Command", { overlay: true });
			const second = ui.getFocusedComponent();
			await flushMicrotasks();
			expect(settled).toHaveBeenCalledExactlyOnceWith(direction === "confirm-to-input" ? false : undefined);
			abort.abort();
			first?.handleInput("\r");
			await vi.advanceTimersByTimeAsync(1000);
			expect(ui.getFocusedComponent()).toBe(second);
			if (direction === "confirm-to-input") {
				expect(mode.extensionSelector?.constructor.name).toBeUndefined();
				expect(statusText()).not.toContain("Waiting for approval");
				mode.extensionInput?.handleInput("answer");
				mode.extensionInput?.handleInput("\r");
				expect(await result).toBe("answer");
			} else {
				expect(mode.extensionInput?.constructor.name).toBeUndefined();
				expect(statusText()).toContain("Waiting for approval");
				mode.extensionSelector?.handleInput("\r");
				expect(await result).toBe(true);
			}
		},
	);

	it.each([
		["reset", "confirm"],
		["reset", "input"],
		["stop", "confirm"],
		["stop", "input"],
	] as const)("settles %s cancellation of %s", async (action, kind) => {
		const { mode, api } = createHarness();
		const abort = new AbortController();
		const settled = vi.fn();
		const opts = { signal: abort.signal, timeout: 1000, overlay: true };
		const result = kind === "confirm" ? api.confirm("Approve", "Command", opts) : api.input("Name", "", opts);
		void result.then(settled);
		const previous = mode.extensionSelector ?? mode.extensionInput;
		if (action === "reset") mode.resetExtensionUI();
		else mode.stop();
		await flushMicrotasks();
		expect(settled).toHaveBeenCalledExactlyOnceWith(kind === "confirm" ? false : undefined);
		expect(mode.extensionSelector?.constructor.name).toBeUndefined();
		expect(mode.extensionInput?.constructor.name).toBeUndefined();
		abort.abort();
		previous?.handleInput("\r");
		await vi.advanceTimersByTimeAsync(1000);
		expect(settled).toHaveBeenCalledTimes(1);
		if (action === "stop") expect(vi.getTimerCount()).toBe(0);
	});

	describe.each([false, true])("reentrant cleanup (overlay=%s)", (overlay) => {
		it.each([
			["confirm", "confirm", "confirm"],
			["confirm", "confirm", "input"],
			["confirm", "input", "confirm"],
			["confirm", "input", "input"],
			["input", "confirm", "confirm"],
			["input", "confirm", "input"],
			["input", "input", "confirm"],
			["input", "input", "input"],
		] as const)(
			"replaces %s with %s without orphaning a refocus-created %s",
			async (firstKind, nextKind, nestedKind) => {
				const { mode, api, ui, editor, spinner, statusText } = createHarness();
				const firstAbort = new AbortController();
				const nestedAbort = new AbortController();
				const firstSettled = vi.fn();
				const nestedSettled = vi.fn();
				const opts = { overlay, timeout: 1000, signal: firstAbort.signal };
				const firstResult =
					firstKind === "confirm" ? api.confirm("First", "Command", opts) : api.input("First", "", opts);
				void firstResult.then(firstSettled);
				const first = mode.extensionSelector ?? mode.extensionInput;
				onNextEditorRefocus(editor, () => {
					const nestedOpts = { overlay, timeout: 1000, signal: nestedAbort.signal };
					const result =
						nestedKind === "confirm"
							? api.confirm("Refocus", "Command", nestedOpts)
							: api.input("Refocus", "", nestedOpts);
					void result.then(nestedSettled);
				});
				const nextResult =
					nextKind === "confirm"
						? api.confirm("Replacement", "Command", { overlay })
						: api.input("Replacement", "", { overlay });
				const current = mode.extensionSelector ?? mode.extensionInput;
				await flushMicrotasks();
				expect(firstSettled).toHaveBeenCalledExactlyOnceWith(firstKind === "confirm" ? false : undefined);
				expect(nestedSettled).toHaveBeenCalledExactlyOnceWith(nestedKind === "confirm" ? false : undefined);
				expect(ui.getFocusedComponent()).toBe(current);
				expect(ui.hasOverlay()).toBe(overlay);
				expect(statusText().includes("Waiting for approval")).toBe(nextKind === "confirm");
				firstAbort.abort();
				nestedAbort.abort();
				first?.handleInput("\r");
				await vi.advanceTimersByTimeAsync(1000);
				expect(ui.getFocusedComponent()).toBe(current);
				current?.handleInput("\x1b");
				expect(await nextResult).toBe(nextKind === "confirm" ? false : undefined);
				expect(mode.extensionSelector).toBeUndefined();
				expect(mode.extensionInput).toBeUndefined();
				expect(ui.hasOverlay()).toBe(false);
				expect(ui.getFocusedComponent()).toBe(editor);
				expect(statusText()).not.toContain("Waiting for approval");
				mode.clearStatusIndicator();
				spinner.dispose();
				// Overlay cursor writes enqueue xterm's zero-delay parser task. Flush
				// only that task; a leaked 1000ms dialog countdown must remain visible.
				await vi.advanceTimersByTimeAsync(0);
				expect(vi.getTimerCount()).toBe(0);
				expect(firstSettled).toHaveBeenCalledTimes(1);
				expect(nestedSettled).toHaveBeenCalledTimes(1);
			},
		);

		it.each([
			["reset", "confirm", "confirm"],
			["reset", "confirm", "input"],
			["reset", "input", "confirm"],
			["reset", "input", "input"],
			["stop", "confirm", "confirm"],
			["stop", "confirm", "input"],
			["stop", "input", "confirm"],
			["stop", "input", "input"],
		] as const)("%s of %s cancels a refocus-created %s", async (action, firstKind, nestedKind) => {
			const { mode, api, ui, editor, spinner, statusText } = createHarness();
			const firstSettled = vi.fn();
			const nestedSettled = vi.fn();
			const abort = new AbortController();
			const opts = { overlay, timeout: 1000, signal: abort.signal };
			const firstResult =
				firstKind === "confirm" ? api.confirm("First", "Command", opts) : api.input("First", "", opts);
			void firstResult.then(firstSettled);
			const first = mode.extensionSelector ?? mode.extensionInput;
			onNextEditorRefocus(editor, () => {
				const result =
					nestedKind === "confirm" ? api.confirm("Refocus", "Command", opts) : api.input("Refocus", "", opts);
				void result.then(nestedSettled);
			});
			if (action === "reset") mode.resetExtensionUI();
			else mode.stop();
			await flushMicrotasks();
			expect(firstSettled).toHaveBeenCalledExactlyOnceWith(firstKind === "confirm" ? false : undefined);
			expect(nestedSettled).toHaveBeenCalledExactlyOnceWith(nestedKind === "confirm" ? false : undefined);
			expect(mode.extensionSelector).toBeUndefined();
			expect(mode.extensionInput).toBeUndefined();
			expect(ui.hasOverlay()).toBe(false);
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(statusText()).not.toContain("Waiting for approval");
			mode.clearStatusIndicator();
			spinner.dispose();
			// Overlay cursor writes enqueue xterm's zero-delay parser task. Flush
			// only that task; a leaked 1000ms dialog countdown must remain visible.
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
			abort.abort();
			first?.handleInput("\r");
			await vi.advanceTimersByTimeAsync(1000);
			expect(firstSettled).toHaveBeenCalledTimes(1);
			expect(nestedSettled).toHaveBeenCalledTimes(1);
			if (action === "reset") {
				const result = api.confirm("After reset", "Command", { overlay });
				expect(mode.extensionSelector).toBeDefined();
				mode.extensionSelector?.handleInput("\r");
				expect(await result).toBe(true);
			}
		});
	});

	it.each(["confirm", "input"] as const)("cleans up a %s mount failure and rejects its promise", async (kind) => {
		const { mode, api, ui, statusText } = createHarness();
		const abort = new AbortController();
		vi.spyOn(ui, "showOverlay").mockImplementationOnce(() => {
			throw new Error("overlay failed");
		});
		const opts = { signal: abort.signal, timeout: 1000, overlay: true };
		const result = kind === "confirm" ? api.confirm("Broken", "Command", opts) : api.input("Broken", "", opts);
		await expect(result).rejects.toThrow("overlay failed");
		expect(mode.extensionSelector?.constructor.name).toBeUndefined();
		expect(mode.extensionInput?.constructor.name).toBeUndefined();
		expect(statusText()).not.toContain("Waiting for approval");
		const replacement = api.confirm("Replacement", "Command", { overlay: true });
		const current = mode.extensionSelector;
		abort.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mode.extensionSelector).toBe(current);
		current?.handleInput("\x1b");
		expect(await replacement).toBe(false);
	});
});

describe("approval viewport", () => {
	it.each([
		[122, 44],
		[80, 24],
		[40, 16],
	])("keeps identity and controls visible at %s x %s", async (columns, rows) => {
		const { api, terminal, ui } = createHarness(columns, rows, true);
		ui.start();
		const controller = new StepPermissionController({ env: {}, initialPreset: "ask" });
		const callId = `chatcmpl-tool-${"long-id-".repeat(20)}12345678`;
		const result = controller.handleToolCall(
			{
				type: "tool_call",
				toolName: "run_command",
				toolCallId: callId,
				input: { command: `printf ${"x".repeat(500)}` },
			},
			{ hasUI: true, ui: api } as unknown as ExtensionContext,
		);
		ui.renderNow();
		const viewport = (await terminal.flushAndGetViewport()).join("\n");
		expect(viewport).toContain("run_command");
		expect(viewport).toContain("12345678");
		expect(viewport).toContain("Yes");
		expect(viewport).toContain("No");
		expect(viewport).toContain("select");
		expect(viewport).toContain("cancel");
		expect(viewport).toContain("FOOTER");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		expect(await result).toEqual({ block: true, reason: "Tool call denied: run_command" });
	});
});
