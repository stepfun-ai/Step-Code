import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@step-harness/pi-tui";
import { type ExtensionCommandContext, initTheme, type UsagePresentation } from "@step-harness/coding-agent";
import { Container } from "../../../packages/tui/src/tui.ts";
import { Text } from "../../../packages/tui/src/components/text.ts";
import { TuiMainScreen } from "../../../packages/tui/src/tui-main-screen.ts";
import { TuiAltScreen } from "../../../packages/tui/src/tui-alt-screen.ts";
import { ScrollView } from "../../../packages/tui/src/components/scroll-view.ts";
import { VStack } from "../../../packages/tui/src/components/v-stack.ts";
import { VirtualTerminal } from "../../../packages/tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";
import { showUsagePanel, UsagePanel, usagePresentationRows } from "../src/ui/view/dialogs/usage-panel.ts";

function model(view: UsagePresentation["view"] = "account"): UsagePresentation {
	const account = { status: "ready" as const, account: { presence: "present" as const, eligible: true, source: "plan", accountId: "123" }, receivedAt: Date.now(), snapshot: { schema_version: 1 as const, observed_at_ms: Date.now(), scope: "personal_account" as const, account: { id: "123" }, plan: { state: "known" as const, family: "coding" as const, name: "Pro", subscription: null }, quota: { state: "known" as const, allowed: true, reason: null, windows: [{ id: "weekly" as const, limited: true, used_percent: 13, resets_at_ms: Date.now() + 100000 }, { id: "five_hour" as const, limited: false, used_percent: null, resets_at_ms: null }], credit_buckets: [] } } };
	return { view, account, status: { version: "1.0", model: "step-model", provider: "step", reasoning: "high", directory: "/work", permissions: "Ask", trusted: true, agents: ["/work/AGENTS.md"], collaboration: "Default", session: "session", state: "idle", context: "10/100", cached: account, account: account.account }, session: { input: 20, output: 2, total: 22, cacheRead: 3, cacheWrite: 0, cacheHit: .15, invalid: 0, missing: 0 }, scope: "all", selectedDate: "2026-10-13", select: vi.fn(), refresh: vi.fn(), selectScope: vi.fn() };
}
afterEach(() => initTheme("dark"));

describe.each(["regular", "fullscreen"] as const)("Usage panel mounting in %s mode", (mode) => {
	it.each(["overview", "account", "status"] as const)("places %s in the editor area and restores the draft on close", async (view) => {
		initTheme("step-blue");
		const terminal = new VirtualTerminal(80, 24);
		const ui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
		const draft = "unfinished draft";
		const editor = Object.assign(new Text("EDITOR", 0, 0), {
			getText: () => draft,
			setText: vi.fn(),
			handleInput: vi.fn(),
		});
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const transcript = new Text("CONVERSATION", 0, 0);
		const footer = new Text("FOOTER", 0, 0);
		if (mode === "fullscreen") {
			(ui as TuiAltScreen).setLayoutRoot(new VStack([
				{ component: new ScrollView(transcript, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 },
				{ component: new VStack([
					{ component: editorContainer, shrink: 1, minSize: 3 },
					{ component: footer, shrink: 1, minSize: 1 },
				]), basis: "auto", minSize: 1 },
			]));
		} else {
			ui.addChild(transcript);
			ui.addChild(editorContainer);
			ui.addChild(footer);
		}
		const host = {
			editor, editorContainer, ui, keybindings: {}, disposeActiveSelector: vi.fn(),
			redraw: { requestRender: () => ui.requestRender() },
		};
		// Exercise the real extension mount; only unrelated host dependencies are stubbed.
		const mount = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as ExtensionCommandContext["ui"]["custom"];
		const ctx = { ui: { custom: mount.bind(host) } } as unknown as ExtensionCommandContext;
		const m = model(view);
		let shown: Promise<void> | undefined;
		const flush = async (): Promise<void> => {
			await Promise.resolve();
			ui.requestRender(true);
			await terminal.waitForRender();
		};
		ui.setFocus(editor);
		ui.start();
		try {
			shown = showUsagePanel(ctx, m);
			for (const [width, height] of [[80, 24], [40, 18], [120, 32]]) {
				terminal.resize(width, height);
				await flush();
				const lines = terminal.getViewport();
				expect(ui.hasOverlay()).toBe(false);
				expect(editorContainer.children).toHaveLength(1);
				expect(editorContainer.children[0]).toBeInstanceOf(UsagePanel);
				expect(lines.join("\n")).not.toContain("EDITOR");
				expect(lines.join("\n")).toContain("CONVERSATION");
				const top = lines.find((line) => line.startsWith("╭"));
				expect(top?.length).toBe(width);
				const bottom = lines.findIndex((line) => line.startsWith("╰"));
				expect(bottom).toBeGreaterThanOrEqual(0);
				expect(lines.findIndex((line) => line.trimEnd() === "FOOTER"), lines.join("\n")).toBeGreaterThan(bottom);
				if (width === 40 && view !== "overview") {
					terminal.sendInput("\u001b[B");
					await flush();
					expect(terminal.getViewport()).not.toEqual(lines);
					expect(terminal.getViewport().some((line) => line.trimEnd() === "FOOTER")).toBe(true);
					terminal.sendInput("\u001b[A");
					await flush();
				}
			}
			if (view === "status") {
				m.status.model = "updated-model";
				m.onChange?.();
				await flush();
				expect(terminal.getViewport().join("\n")).toContain("updated-model");
			}
			terminal.sendInput("\u001b");
			await shown;
			await flush();
			expect(editorContainer.children).toEqual([editor]);
			expect(editor.setText).toHaveBeenCalledWith(draft);
			expect(m.onChange).toBeUndefined();
			expect(m.onClose).toBeUndefined();
			terminal.sendInput("x");
			expect(editor.handleInput).toHaveBeenCalledWith("x");
		} finally {
			m.onClose?.();
			await shown;
			ui.stop();
		}
	});
});
describe("Usage and Status presentation", () => {
	it("shows only Overview/Account tabs and consistent remaining quota wording", () => {
		const account = usagePresentationRows(model()).join("\n"), status = usagePresentationRows(model("status")).join("\n");
		expect(account).toContain("1 Overview   [2 Account]"); expect(account).not.toMatch(/3 Session|4 History/u); expect(account).toContain("87.0% left"); expect(account).not.toContain("% used"); expect(status).toContain("87.0% left"); expect(status).toContain("Permissions:"); expect(status).toContain("Session:"); expect(status).toContain("no network request");
	});
	it.each([
		{ used: 0, total: "100", remaining: "100", expected: `[${"▆".repeat(12)}] 100.0% left` },
		{ used: 25, total: "100", remaining: "75", expected: `[${"▆".repeat(9)}${"▁".repeat(3)}] 75.0% left` },
		{ used: 100, total: "100", remaining: "0", expected: `[${"▁".repeat(12)}] 0.0% left` },
		{ used: null, total: "0", remaining: "0", expected: "Remaining percentage unavailable" },
	])("shows Credit percentages without confusing full, empty and unknown balances: $used", ({ used, total, remaining, expected }) => {
		for (const view of ["account", "status"] as const) {
			const m = model(view);
			m.account.snapshot!.plan.family = "token";
			m.account.snapshot!.quota.windows = [];
			m.account.snapshot!.quota.credit_buckets = [{ type: "subscription", total, remaining, used_percent: used, resets_at_ms: null, expires_at_ms: null }];
			const rows = usagePresentationRows(m).map(stripTerminalSequences);
			const index = rows.findIndex((row) => row.startsWith("Subscription Credits:"));
			expect(rows[index]).toContain(expected);
			expect(rows.join("\n")).not.toContain(`${remaining} / ${total} Credits left`);
			if (used === null) expect(rows.join("\n")).not.toMatch(/\d+(?:\.\d+)?% left/u);
		}
	});
	it("shows percentages instead of raw Credit amounts and hides unknown buckets", () => {
		const m = model(); m.account.snapshot!.plan.family = "token"; m.account.snapshot!.quota.windows = [];
		m.account.snapshot!.quota.credit_buckets = [{ type: "topup", total: "9007199254740993", remaining: "9007199254740992", used_percent: 0, resets_at_ms: null, expires_at_ms: null }, { type: "future", unsupported: true, total: "0", remaining: "0", used_percent: null, resets_at_ms: null, expires_at_ms: null }];
		const rendered = usagePresentationRows(m).join("\n"); expect(rendered).toContain("100.0% left"); expect(rendered).not.toContain("9,007,199,254,740,993"); expect(rendered).not.toContain("9,007,199,254,740,992"); expect(rendered).toContain("Unsupported bucket type: future");
	});
	it("reuses ANSI stripping for historical plugin and skill names", () => {
		const m = model("overview");
		m.overview = { days: [{ date: "2026-10-13", tokens: 1, chats: 1 }], tokens: 1, chats: 1, activeDays: 1,
			reasoning: [], discoveredSkills: 1, usedSkills: 1, topResources: [["\x1b[31m$example\x1b[0m", 1]], limited: [], scope: "all" };
		const rows = usagePresentationRows(m).map(stripTerminalSequences).join("\n");
		expect(rows).toContain("$example");
		expect(rows).not.toContain("[31m");
	});

	it("fits narrow terminals, keeps only the documented tab shortcuts and scrolls", () => {
		initTheme("step-blue"); const m = model(), close = vi.fn(), panel = new UsagePanel(m, vi.fn(), close, () => 18);
		for (const width of [24, 60, 120]) for (const row of panel.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		panel.handleInput("3"); expect(m.select).not.toHaveBeenCalled(); panel.handleInput("1"); expect(m.select).toHaveBeenCalledWith("overview"); panel.handleInput("r"); expect(m.refresh).toHaveBeenCalledOnce(); panel.handleInput("\u001b"); expect(close).toHaveBeenCalledOnce();
		m.view = "status"; expect(panel.render(60).map(stripTerminalSequences).join("\n")).toContain("Model:"); panel.handleInput("\u001b[6~"); expect(panel.render(60).map(stripTerminalSequences).join("\n")).toContain("Weekly");
	});
});
