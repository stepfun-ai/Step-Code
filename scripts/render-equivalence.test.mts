/**
 * Byte-for-byte render equivalence test for the incremental (dirty-tracked)
 * regular-mode renderer.
 *
 * The optimized path must produce exactly the same terminal byte stream as the
 * unoptimized one, so this test drives the REAL TuiMainScreen render loop through
 * a matrix of scenarios (see render-equivalence-scenarios.mts) and compares the
 * recorded write() sequence against the baseline produced with
 * --disable-incremental, which disables the Container cache, the prefix
 * reuse in applyLineResets, the diff bound and the Kitty-scan skip.
 *
 * Each run happens in its own child process with an explicit rendering mode.
 * The optimized arm runs twice: identical recordings across the two runs
 * are what make the comparison meaningful, since a wall-clock dependent frame (a
 * spinner glyph, say) would otherwise agree with itself and hide the divergence.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.json scripts/render-equivalence.test.mts
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Recording } from "./render-equivalence-scenarios.mts";

const START_MARKER = "<<<EQUIVALENCE-JSON>>>";
const END_MARKER = "<<<EQUIVALENCE-END>>>";

type Payload = {
	recording: Recording;
	diagnostics: Record<string, Diagnostics>;
};

type Diagnostics = {
	dirtyStartAfterTyping: number;
	totalLines: number;
	incremental: boolean;
	frames: number;
	kittyImageFrames: number;
	kittyDeleteSequences: number;
	overlayFrames: number;
	stepMessagesChecked: number;
	dirtyStartViolations: string[];
	spacerCacheStable: boolean;
};

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runChild(disableIncremental = false): Payload {
	const script = fileURLToPath(new URL("./render-equivalence-scenarios.mts", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[
			"node_modules/tsx/dist/cli.mjs",
			"--tsconfig",
			"tsconfig.json",
			script,
			"--child",
			...(disableIncremental ? ["--disable-incremental"] : []),
		],
		{
			encoding: "utf8",
			cwd: repoRoot,
			env: process.env,
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	if (result.status !== 0) {
		throw new Error(`child failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`);
	}
	const start = result.stdout.indexOf(START_MARKER);
	const end = result.stdout.indexOf(END_MARKER);
	assert.ok(start !== -1 && end !== -1 && end > start, "child did not emit a recording");
	return JSON.parse(result.stdout.slice(start + START_MARKER.length, end)) as Payload;
}

/** Byte comparison of two ordered recordings, with a readable first divergence. */
function findDivergence(baseline: Recording, optimized: Recording): string[] {
	const mismatches: string[] = [];
	for (let i = 0; i < Math.max(baseline.length, optimized.length); i++) {
		const base = baseline[i];
		const opt = optimized[i];
		if (base === undefined || opt === undefined) {
			mismatches.push(
				`frame #${i}: recording lengths differ (baseline ${baseline.length}, optimized ${optimized.length})`,
			);
			break;
		}
		if (base.id !== opt.id) {
			mismatches.push(`frame #${i}: step ids differ (${base.id} vs ${opt.id})`);
			continue;
		}
		const same =
			base.writes.length === opt.writes.length && base.writes.every((chunk, j) => chunk === opt.writes[j]);
		if (same) continue;
		const firstDiff = base.writes.findIndex((chunk, j) => chunk !== opt.writes[j]);
		mismatches.push(
			`${base.id}: write #${firstDiff} of ${base.writes.length}/${opt.writes.length} differs\n` +
				`  baseline:  ${JSON.stringify(base.writes[firstDiff])}\n` +
				`  optimized: ${JSON.stringify(opt.writes[firstDiff])}`,
		);
	}
	return mismatches;
}

function bytes(recording: Recording): number {
	return recording.reduce((total, frame) => total + frame.writes.join("").length, 0);
}

test("optimized renderer writes the same bytes as the unoptimized baseline", () => {
	const baseline = runChild(true);
	const optimized = runChild();
	// Same arm, second run: proves the recording does not depend on wall-clock timing.
	const optimizedAgain = runChild();

	assert.ok(baseline.recording.length > 0, "baseline recorded no scenarios");

	// Determinism: an identical environment must produce an identical recording.
	const nondeterminism = findDivergence(optimized.recording, optimizedAgain.recording);
	assert.deepEqual(
		nondeterminism,
		[],
		`recording is not reproducible across runs:\n${nondeterminism.join("\n")}`,
	);

	const mismatches = findDivergence(baseline.recording, optimized.recording);
	assert.deepEqual(mismatches, [], `render output diverged:\n${mismatches.join("\n")}`);

	// Report per scenario label, aggregated over every step that used it.
	const labels = [...new Set(baseline.recording.map((frame) => frame.label))];
	console.log(`${"scenario".padEnd(34)} | steps | bytes | result`);
	console.log("-".repeat(80));
	for (const label of labels) {
		const frames = baseline.recording.filter((frame) => frame.label === label);
		const optFrames = optimized.recording.filter((frame) => frame.label === label);
		const identical =
			frames.length === optFrames.length &&
			frames.every((frame, i) => frame.writes.join("") === optFrames[i]?.writes.join(""));
		console.log(
			`${label.padEnd(34)} | ${String(frames.length).padStart(5)} | ${String(
				frames.reduce((total, frame) => total + frame.writes.join("").length, 0),
			).padStart(9)} | ${identical ? "identical" : "MISMATCH"}`,
		);
	}
	console.log(`\ntotal: ${baseline.recording.length} frames, ${bytes(baseline.recording)} bytes\n`);

	// Guard against a vacuous pass: the optimized run must actually be skipping the
	// stable prefix, and the baseline must not.
	assert.equal(baseline.diagnostics.native.incremental, false);
	assert.equal(optimized.diagnostics.native.incremental, true);
	for (const presentation of ["native", "step"] as const) {
		const base = baseline.diagnostics[presentation];
		const opt = optimized.diagnostics[presentation];
		assert.equal(base.dirtyStartAfterTyping, 0, `${presentation}: baseline must be fully dirty`);
		assert.ok(
			opt.dirtyStartAfterTyping > 0,
			`${presentation}: expected the optimized renderer to report a dirty start above 0, got ${opt.dirtyStartAfterTyping}`,
		);
		assert.equal(opt.totalLines, base.totalLines);
		console.log(
			`\n${presentation}: dirty start after typing - baseline ${base.dirtyStartAfterTyping}, optimized ${opt.dirtyStartAfterTyping} of ${opt.totalLines} lines`,
		);

		// Kill-switch completeness: the baseline arm has to be genuinely cache-free.
		assert.equal(
			opt.spacerCacheStable,
			true,
			`${presentation}: Spacer must hand back a stable array while incremental rendering is on`,
		);
		assert.equal(
			base.spacerCacheStable,
			false,
			`${presentation}: Spacer cache ignored --disable-incremental, so the baseline is not cache-free`,
		);

		// The two delicate guards are only worth having if the scenarios reach them.
		assert.ok(
			opt.kittyImageFrames > 0,
			`${presentation}: the image lifecycle never placed a Kitty image, so the hasImages guard is untested`,
		);
		assert.ok(
			opt.kittyDeleteSequences > 0,
			`${presentation}: the image lifecycle never deleted a Kitty image, so the hasImages guard is untested`,
		);
		assert.ok(
			opt.overlayFrames > 0,
			`${presentation}: the overlay lifecycle never composited an overlay, so the overlay guard is untested`,
		);
		assert.equal(
			opt.kittyImageFrames,
			base.kittyImageFrames,
			`${presentation}: the image lifecycle produced a different number of image frames`,
		);
		assert.equal(
			opt.kittyDeleteSequences,
			base.kittyDeleteSequences,
			`${presentation}: the image lifecycle deleted a different number of images`,
		);
		assert.equal(opt.overlayFrames, base.overlayFrames, `${presentation}: overlay frame count differs`);

		// renderDirtyStart must index the array a component actually returned. Only the
		// Step presentation builds message components that reflow their rows.
		assert.deepEqual(
			opt.dirtyStartViolations,
			[],
			`${presentation}: renderDirtyStart contract violated:\n${opt.dirtyStartViolations.join("\n")}`,
		);
		if (presentation === "step") {
			assert.ok(
				opt.stepMessagesChecked > 0,
				`${presentation}: no Step message was probed for the renderDirtyStart contract`,
			);
		}
	}
});
