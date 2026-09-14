/**
 * Headless long-session TUI benchmark.
 *
 * Reproduces the reported Windows "long session -> input freezes" bug WITHOUT
 * needing a real 5-hour interactive session. It drives the REAL regular-mode
 * render loop (TuiMainScreen.doRender — the exact work every keystroke triggers,
 * see tui.ts:900 requestImmediateRender) against a synthetic transcript of
 * increasing size, and measures per-keystroke render latency + bytes written +
 * heap growth as the transcript grows.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.json scripts/long-session-bench.mts
 */
import { performance } from "node:perf_hooks";
import { Text } from "../packages/tui/src/components/text.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { Container } from "../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";

/** Fake terminal: records output volume, feeds injected input, never touches a TTY. */
class FakeTerminal implements Terminal {
	columns = 120;
	rows = 40;
	kittyProtocolActive = false;
	bytesWritten = 0;
	writeCount = 0;
	private onInput?: (data: string) => void;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
		this.writeCount++;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	/** Simulate a keystroke arriving from the OS. */
	feed(data: string): void {
		this.onInput?.(data);
	}
	resetCounters(): void {
		this.bytesWritten = 0;
		this.writeCount = 0;
	}
}

/** One transcript entry ~= a user/assistant message or tool result (multi-line, like real output). */
function makeMessage(i: number): Text {
	const lines = [
		`▌ user #${i}: please refactor the module and explain the change in detail`,
		`assistant #${i}: Here is what I changed and why it matters for correctness:`,
		`  - updated packages/foo/src/bar.ts to guard the null case`,
		`  - added a regression test covering the empty-input path`,
		`  $ pnpm test  ->  ok (${(i * 37) % 900}ms)`,
	];
	// paddingX=1, paddingY=0 keeps it compact but multi-line — realistic transcript block.
	return new Text(lines.join("\n"), 1, 0);
}

function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function tick(): Promise<void> {
	await new Promise<void>((r) => process.nextTick(r));
}

async function main(): Promise<void> {
	// Sweep transcript sizes. A busy multi-hour session easily accretes thousands
	// of transcript components (each user turn + assistant turn + every tool call
	// is its own child; interactive-mode.ts:714 mounts them, never trims).
	const sizes = [200, 500, 1000, 2000, 4000, 8000, 16000];
	const KEYSTROKES = 15; // per size, we measure this many single-key renders

	const term = new FakeTerminal();
	const tui = new TuiMainScreen(term);
	const chat = new Container();
	tui.addChild(chat);
	// Focus nothing special — we measure doRender directly, which is exactly the
	// O(session) work requestImmediateRender() runs synchronously on each key.
	tui.start();

	console.log(
		"messages | totalLines | firstFullRedraw(ms) | perKeystroke p50(ms) | p50 bytes/key | heapUsed(MB)",
	);
	console.log("-".repeat(96));

	let built = 0;
	const baseHeap = process.memoryUsage().heapUsed;
	for (const size of sizes) {
		for (; built < size; built++) chat.addChild(makeMessage(built));

		// First full redraw for this size (force = reset diff state -> full paint).
		const t0 = performance.now();
		tui.renderNow(true);
		await tick();
		const firstFull = performance.now() - t0;

		// Now simulate individual keystrokes. Each key mutates the LAST message a
		// touch (as if a streaming/status line updated) and triggers the same
		// full re-render + full diff the real input path forces on every key.
		const last = chat.children[chat.children.length - 1] as Text;
		const perKey: number[] = [];
		const bytesPerKey: number[] = [];
		for (let k = 0; k < KEYSTROKES; k++) {
			last.setText(`▌ user #${built}: keystroke ${k} typed at ${Date.now()}`);
			term.resetCounters();
			const s = performance.now();
			tui.renderNow(false); // === the synchronous work of one keypress
			await tick();
			perKey.push(performance.now() - s);
			bytesPerKey.push(term.bytesWritten);
		}

		const totalLines = tui.render(term.columns).length;
		const heapMB = (process.memoryUsage().heapUsed - baseHeap) / (1024 * 1024);
		console.log(
			`${String(size).padStart(8)} | ${String(totalLines).padStart(10)} | ${firstFull
				.toFixed(1)
				.padStart(19)} | ${median(perKey).toFixed(2).padStart(20)} | ${String(Math.round(median(bytesPerKey))).padStart(13)} | ${heapMB.toFixed(1).padStart(12)}`,
		);
	}

	tui.stop();
	console.log("\nEach 'perKeystroke' figure is the synchronous cost of ONE key in regular mode.");
	console.log("On Windows this runs inline in the stdin handler with blocking stdout writes.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
