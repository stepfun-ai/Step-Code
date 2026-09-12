import { setKeybindings, stripTerminalSequences, type TUI, visibleWidth } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import type { ExtensionCommandContext } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { createInteractiveTui } from "../src/ui/interactive-mode.ts";
import {
	confirmFeedbackSubmission,
	formatFeedbackConsentPreview,
	neutralizeFeedbackConsentText,
	ScrollableConsentComponent,
} from "../../../packages/coding-agent/src/step/feedback/consent.ts";
import type { FeedbackBundle, FeedbackSubmission } from "../../../packages/coding-agent/src/step/feedback/types.ts";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";

class RecordingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

type TuiMode = "regular" | "fullscreen";

type MountedConsent = {
	tui: TUI;
	terminal: RecordingVirtualTerminal;
	result: Promise<boolean>;
};

function submission(comment: string, diagnosticsLines: readonly string[] = []): FeedbackSubmission {
	return {
		feedbackId: "00000000-0000-4000-8000-000000000001",
		category: "bug",
		comment,
		at: "2026-09-01T00:00:00.000Z",
		context: {
			channel: "dev",
			version: "0.0.0",
			platform: "test",
		},
		...(diagnosticsLines.length > 0
			? {
					diagnostics: {
						source: "stderr_dev_log" as const,
						lines: diagnosticsLines,
						truncated: false,
					},
				}
			: {}),
	};
}

function sessionBundle(): FeedbackBundle {
	return {
		data: new Uint8Array(321),
		files: [
			{ name: "events.jsonl", bytes: 2048 },
			{ name: "dev.log", bytes: 128, note: "context lines around 2 errors" },
		],
		sessionId: "session-1",
		lastActivityAt: new Date("2026-09-01T00:01:02.000Z"),
	};
}

async function mountConsent(
	mode: TuiMode,
	preview: string,
	keybindings = new KeybindingsManager(),
): Promise<MountedConsent> {
	const terminal = new RecordingVirtualTerminal(80, 24);
	const tui = createInteractiveTui({
		tuiMode: mode,
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
	});
	setKeybindings(keybindings);
	let resolveResult: (confirmed: boolean) => void = () => {
		throw new Error("consent result resolver was not initialized");
	};
	const result = new Promise<boolean>((resolve) => {
		resolveResult = resolve;
	});
	const component = new ScrollableConsentComponent(tui, theme, keybindings, preview, (confirmed) => {
		tui.hideOverlay();
		resolveResult(confirmed);
	});
	tui.addChild({
		render: () => ["underlying transcript"],
		invalidate: () => undefined,
	});
	tui.start();
	tui.showOverlay(component, {
		anchor: "center",
		width: "100%",
		maxHeight: "100%",
	});
	await terminal.waitForRender();
	return { tui, terminal, result };
}

async function viewport(terminal: VirtualTerminal): Promise<string[]> {
	await terminal.waitForRender();
	return terminal.getViewport();
}

function plainFrame(lines: readonly string[]): string {
	return lines.map(stripTerminalSequences).join("\n");
}

beforeAll(() => {
	initTheme("dark");
});

describe("feedback consent preview", () => {
	test("neutralizes C0, C1, DEL, CSI, and OSC only in the display copy", () => {
		const comment = "before\x1b[2Jafter\x1b]0;owned\x07tail\rreturn\bback\x7fdel\u009b2Jc1";
		const input = submission(comment, ["diagnostic\x1b[31mred\x1b[0m"]);
		const bundle: FeedbackBundle = {
			...sessionBundle(),
			files: [{ name: "events\x1b[2J.jsonl", bytes: 1, note: "line\nbreak\x1b]0;owned\x07" }],
		};
		const preview = formatFeedbackConsentPreview({
			submission: input,
			diagnosticsDisplayPath: "logs/line\nbreak-trace\x1b[2J.jsonl",
			bundle,
		});

		expect(preview).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/u);
		expect(preview).toContain("before\\x1b[2Jafter\\x1b]0;owned\\x07tail\\rreturn\\bback\\x7fdel\\x9b2Jc1");
		expect(preview).toContain("Diagnostics: logs/line\\nbreak-trace\\x1b[2J.jsonl");
		expect(preview).toContain("events\\x1b[2J.jsonl");
		expect(preview).toContain("line\\nbreak\\x1b]0;owned\\x07");
		expect(input.comment).toBe(comment);
		expect(input.diagnostics?.lines[0]).toBe("diagnostic\x1b[31mred\x1b[0m");
	});

	test("preserves ordinary Unicode and line breaks while making controls visible", () => {
		expect(neutralizeFeedbackConsentText("第一行\n第二行\t值\r尾")).toBe("第一行\n第二行\\t值\\r尾");
	});

	test("uses custom overlay only for TUI mode and confirm for RPC mode", async () => {
		const tuiCustom = vi.fn().mockResolvedValue(false);
		const tuiConfirm = vi.fn();
		const tuiResult = await confirmFeedbackSubmission(
			{
				mode: "tui",
				ui: { custom: tuiCustom, confirm: tuiConfirm } as unknown as ExtensionCommandContext["ui"],
			},
			{ submission: submission("preview") },
		);

		expect(tuiResult).toBe(false);
		expect(tuiConfirm).not.toHaveBeenCalled();
		expect(tuiCustom).toHaveBeenCalledOnce();
		expect(tuiCustom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		});

		const rpcCustom = vi.fn();
		const rpcConfirm = vi.fn().mockResolvedValue(true);
		const rpcResult = await confirmFeedbackSubmission(
			{
				mode: "rpc",
				ui: { custom: rpcCustom, confirm: rpcConfirm } as unknown as ExtensionCommandContext["ui"],
			},
			{ submission: submission("preview") },
		);

		expect(rpcResult).toBe(true);
		expect(rpcCustom).not.toHaveBeenCalled();
		expect(rpcConfirm).toHaveBeenCalledWith("Submit feedback?", expect.stringContaining("Comment:\npreview"));
	});

	test.each(["regular", "fullscreen"] as const)(
		"renders and scrolls every preview section in an 80x24 %s overlay",
		async (mode) => {
			const diagnostics = Array.from({ length: 40 }, (_, index) => `diag-${String(index + 1).padStart(2, "0")}`);
			const maliciousComment = "terminal attack \x1b[2JATTACK_MARKER \x1b]0;OWNED_TITLE\x07";
			const previewText = formatFeedbackConsentPreview({
				submission: submission(maliciousComment, diagnostics),
				diagnosticsDisplayPath: "logs/dev.log",
				bundle: sessionBundle(),
			});
			const mounted = await mountConsent(mode, previewText);
			try {
				const seenDiagnostics = new Set<string>();
				let sawBundle = false;
				let sawConversationWarning = false;
				let previousFrame = "";
				for (let page = 0; page < 8; page += 1) {
					const rows = await viewport(mounted.terminal);
					const frame = plainFrame(rows);
					expect(rows).toHaveLength(24);
					for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(80);
					expect(frame).toContain("Yes");
					expect(frame).toContain("No");
					for (const match of frame.matchAll(/diag-\d{2}/gu)) seenDiagnostics.add(match[0]);
					sawBundle ||= frame.includes("Session bundle (321 compressed bytes)");
					sawConversationWarning ||= frame.includes("It contains the conversation itself");
					if (seenDiagnostics.size === 40 && sawBundle && sawConversationWarning) break;
					previousFrame = frame;
					mounted.terminal.sendInput("\x1b[6~");
					const nextFrame = plainFrame(await viewport(mounted.terminal));
					expect(nextFrame).not.toBe(previousFrame);
				}

				expect(seenDiagnostics.size).toBe(40);
				expect(sawBundle).toBe(true);
				expect(sawConversationWarning).toBe(true);
				const bottomFrame = plainFrame(await viewport(mounted.terminal));
				mounted.terminal.sendInput("\x1b[5~");
				const previousPage = plainFrame(await viewport(mounted.terminal));
				expect(previousPage).not.toBe(bottomFrame);
				expect(previousPage).toContain("Yes");
				expect(previousPage).toContain("No");

				mounted.terminal.sendInput("\x1b[B");
				mounted.terminal.sendInput("\r");
				await expect(mounted.result).resolves.toBe(false);
				expect(mounted.terminal.writes.join("")).not.toContain("\x1b[2JATTACK_MARKER");
				expect(mounted.terminal.writes.join("")).not.toContain("\x1b]0;OWNED_TITLE\x07");
			} finally {
				mounted.tui.stop();
			}
		},
	);

	test("moves one viewport minus one line per page", () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const keybindings = new KeybindingsManager();
		const component = new ScrollableConsentComponent(
			tui,
			theme,
			keybindings,
			Array.from({ length: 15 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n"),
			() => undefined,
		);
		const firstPage = plainFrame(component.render(40));
		component.handleInput("\x1b[6~");
		const secondPage = plainFrame(component.render(40));

		expect(firstPage).toContain("line-06");
		expect(secondPage).toContain("line-06");
		expect(secondPage).toContain("line-11");
	});

	test("uses injected selection bindings for confirm and cancel", () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const confirmed: boolean[] = [];
		const keybindings = new KeybindingsManager({
			"tui.select.confirm": "ctrl+y",
			"tui.select.cancel": "ctrl+x",
		});
		const component = new ScrollableConsentComponent(tui, theme, keybindings, "preview", (value) => {
			confirmed.push(value);
		});
		component.render(40);
		component.handleInput("\r");
		expect(confirmed).toEqual([]);
		component.handleInput("\x19");
		expect(confirmed).toEqual([true]);

		const cancelled: boolean[] = [];
		const cancelComponent = new ScrollableConsentComponent(tui, theme, keybindings, "preview", (value) => {
			cancelled.push(value);
		});
		cancelComponent.handleInput("\x18");
		expect(cancelled).toEqual([false]);
	});

	test.each([
		["six-row", 80, 6],
		["ten-column", 10, 24],
	] as const)(
		"disables confirmation in a real %s terminal without a usable review viewport",
		async (_label, width, height) => {
			const terminal = new RecordingVirtualTerminal(width, height);
			const tui = createInteractiveTui({
				tuiMode: "regular",
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal,
			});
			const outcomes: boolean[] = [];
			const component = new ScrollableConsentComponent(
				tui,
				theme,
				new KeybindingsManager(),
				"actual preview",
				(value) => outcomes.push(value),
			);
			tui.addChild({ render: () => ["underlying transcript"], invalidate: () => undefined });
			tui.start();
			tui.showOverlay(component, { width: "100%", maxHeight: "100%" });
			try {
				const frame = plainFrame(await viewport(terminal));
				expect(frame).toContain("Resize");
				expect(frame).toContain(width < 20 ? "actual" : "actual preview");
				terminal.sendInput("\r");
				await viewport(terminal);
				expect(outcomes).toEqual([]);
				terminal.sendInput("\x1b");
				await viewport(terminal);
				expect(outcomes).toEqual([false]);
			} finally {
				tui.stop();
			}
		},
	);

	test.each([
		["enter", "\r", true],
		["escape", "\x1b", false],
		["ctrl+c", "\x03", false],
	] as const)("resolves %s through the configured default action", (_label, input, expected) => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const outcomes: boolean[] = [];
		const component = new ScrollableConsentComponent(tui, theme, new KeybindingsManager(), "preview", (value) =>
			outcomes.push(value),
		);
		component.handleInput(input);
		expect(outcomes).toEqual([expected]);
	});
});
