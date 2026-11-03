import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, type TUI, TuiMainScreen } from "@step-harness/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../../packages/coding-agent/src/core/tools/edit.ts";
import { computeEditsDiff, type Edit } from "../../../packages/coding-agent/src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

function createLargeEdits(lines: string[]): Edit[] {
	const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
	return targets.map((lineNumber) => ({
		oldText: `${lines[lineNumber - 1]}\n${lines[lineNumber]}\n${lines[lineNumber + 1]}`,
		newText: `${lines[lineNumber - 1]}\n${lines[lineNumber]} changed\n${lines[lineNumber + 1]}`,
	}));
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"line 50 changed",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 950 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = component.render(80).join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Successfully replaced");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines).slice(0, 2);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			{ path: filePath, edits },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("keeps the applied change on a Step card whose call failed after writing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-failed-"));
		tempDirs.push(dir);
		const filePath = join(dir, "cancelled-check.txt");
		await writeFile(filePath, "before\n", "utf8");

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-failed",
			{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },
			{ presentation: "step" },
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		// The edit landed, then the check the call ran alongside was cancelled: the
		// recorded change is real, the call is not. Recomputed from the args against
		// the file it already changed, the preview finds no match and reports an error
		// of its own, which is not what the call did.
		await writeFile(filePath, "after\n", "utf8");
		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();
		// The args-based preview, computed against the file the call already changed.
		expect(component.render(200).join("\n")).toContain("Could not find");
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 occurrence(s) in cancelled-check.txt.\n\nthen_run: $ check\nCommand aborted" }],
				details: { diff: "-1 before\n+1 after\n", patch: "--- cancelled-check.txt\n+++ cancelled-check.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n", firstChangedLine: 1 },
				isError: true,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = component.render(200).join("\n");
		// The diff comes from the result, so it replaces the stale preview error.
		expect(rendered).toContain("-1 before");
		expect(rendered).toContain("+1 after");
		expect(rendered).not.toContain("Could not find");
		// The call still reads as failed.
		expect(rendered).toContain("Command aborted");
	});

	it("shows a preflight error without rendering a diff when the edits do not apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			{ path: filePath, edits: [{ oldText: "does not exist", newText: "replacement" }] },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"Could not find",
			() => tui.requestRender(true),
		);
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});

	it("shows no diff for a failed call that recorded nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-nodetail-"));
		tempDirs.push(dir);
		const filePath = join(dir, "unchanged.txt");
		await writeFile(filePath, "line 0\n", "utf8");

		const terminal = new FakeTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-nodetail",
			{ path: filePath, edits: [{ oldText: "does not exist", newText: "replacement" }] },
			{ presentation: "step" },
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();
		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();

		// The renderer reads a result's diff whatever the call's own status is, so a
		// failure that carries no change record must not invent one.
		component.updateResult(
			{ content: [{ type: "text", text: "No matches for search string in unchanged.txt" }], details: {}, isError: true },
			false,
		);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("No matches");
		expect(rendered).not.toContain("-1 line 0");
		expect(rendered).not.toContain("+1 ");
	});
});
