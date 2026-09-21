import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines = ["short"];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function renderCrash(logDirectory?: string): string {
	const terminal = new VirtualTerminal(20, 5);
	const tui = new TuiMainScreen(terminal, undefined, logDirectory);
	const component = new TestComponent();
	tui.addChild(component);
	try {
		// The overwidth guard runs on differential frames, after a valid first render.
		tui.renderNow();
		component.lines = ["x".repeat(terminal.columns + 1)];
		let crashLogPath: string | undefined;
		assert.throws(
			() => tui.renderNow(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Rendered line 0 exceeds terminal width \(21 > 20\)/);
				crashLogPath = error.message.match(/Debug log written to: (.+)/)?.[1];
				return true;
			},
		);
		assert.ok(crashLogPath, "the crash error must identify the retained log");
		const log = readFileSync(crashLogPath, "utf8");
		assert.match(log, /Terminal width: 20/);
		assert.match(log, /Line 0 visible width: 21/);
		assert.ok(log.includes(component.lines[0]), "the crash log must contain the rendered line");
		return crashLogPath;
	} finally {
		tui.stop();
	}
}

describe("TUI crash logs", () => {
	let testRoot: string;
	let previous: Map<string, string | undefined>;
	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "tui-crash-test-"));
		previous = new Map(["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]));
		for (const key of previous.keys()) process.env[key] = testRoot;
	});
	afterEach(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(testRoot, { recursive: true, force: true });
	});

	// MR !93: never reuse a shared temporary path that another user can preoccupy.
	for (const entry of ["file", "directory"] as const) {
		it(`does not follow a preplaced shared ${entry} symlink`, { skip: process.platform === "win32" }, () => {
			const markerPath = join(testRoot, "marker.txt");
			const marker = "must remain unchanged";
			writeFileSync(markerPath, marker);
			const sharedPath = join(testRoot, "tui");
			if (entry === "directory") {
				const attackerDirectory = join(testRoot, "attacker");
				mkdirSync(attackerDirectory);
				symlinkSync(attackerDirectory, sharedPath, "dir");
			} else {
				mkdirSync(sharedPath);
			}
			symlinkSync(markerPath, join(sharedPath, "tui-crash.log"));

			const crashLogPath = renderCrash();

			assert.equal(readFileSync(markerPath, "utf8"), marker, "shared-path symlink must not overwrite its target");
			assert.notEqual(dirname(crashLogPath), sharedPath);
			assert.equal(dirname(dirname(crashLogPath)), testRoot);
			assert.equal(statSync(dirname(crashLogPath)).mode & 0o777, 0o700);
		});
	}

	it("retains separate default crash logs in private directories", () => {
		const first = renderCrash();
		const second = renderCrash();
		assert.notEqual(dirname(first), dirname(second));
		for (const crashLogPath of [first, second]) {
			assert.equal(basename(crashLogPath), "tui-crash.log");
			assert.equal(dirname(dirname(crashLogPath)), testRoot);
			assert.ok(statSync(crashLogPath).isFile());
			if (process.platform !== "win32") {
				assert.equal(statSync(dirname(crashLogPath)).mode & 0o777, 0o700);
			}
		}
	});

	it("writes crash logs to an explicitly supplied directory", () => {
		const logDirectory = join(testRoot, "custom", "logs");
		assert.equal(renderCrash(logDirectory), join(logDirectory, "tui-crash.log"));
		assert.deepEqual(readdirSync(testRoot), ["custom"]);
	});

	it("does not create a default log directory during normal rendering", () => {
		const tui = new TuiMainScreen(new VirtualTerminal(20, 5));
		tui.addChild(new TestComponent());
		try {
			tui.renderNow();
			assert.deepEqual(readdirSync(testRoot), []);
		} finally {
			tui.stop();
		}
	});
});
