import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { newestSourceMtimeMs, staleProbes } from "../src/dist-freshness.ts";

const SECOND = 1000;

async function fixture(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "stepcode-dist-freshness-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function write(path: string, timeMs: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "export {};\n");
	await utimes(path, new Date(timeMs), new Date(timeMs));
}

function probe(directory: string, outputs: string[], sourceRoots: string[]) {
	return { name: "pkg", outputs, sourceRoots };
}

test("a missing build output needs a rebuild", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "src", "index.ts"), SECOND);

	assert.deepEqual(
		staleProbes([probe(directory, [join(directory, "dist", "index.d.ts")], [join(directory, "src")])]),
		["pkg"],
	);
});

test("a build output newer than its sources is fresh", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "src", "index.ts"), SECOND);
	await write(join(directory, "dist", "index.d.ts"), 2 * SECOND);

	assert.deepEqual(
		staleProbes([probe(directory, [join(directory, "dist", "index.d.ts")], [join(directory, "src")])]),
		[],
	);
});

test("a nested source edited after the build marks the package stale", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "src", "index.ts"), SECOND);
	await write(join(directory, "dist", "index.d.ts"), 2 * SECOND);
	await write(join(directory, "src", "core", "settings.ts"), 3 * SECOND);

	assert.deepEqual(
		staleProbes([probe(directory, [join(directory, "dist", "index.d.ts")], [join(directory, "src")])]),
		["pkg"],
	);
});

test("only source extensions count as edits", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "src", "index.ts"), SECOND);
	await write(join(directory, "dist", "index.d.ts"), 2 * SECOND);
	await write(join(directory, "src", "README.md"), 3 * SECOND);

	assert.deepEqual(
		staleProbes([probe(directory, [join(directory, "dist", "index.d.ts")], [join(directory, "src")])]),
		[],
	);
});

test("the oldest of several outputs is the reference", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "src", "index.ts"), 2500);
	const outputs = [join(directory, "dist", "server.js"), join(directory, "dist", "public", "index.html")];
	await write(outputs[0], 3 * SECOND);
	await write(outputs[1], 2 * SECOND);

	assert.deepEqual(staleProbes([probe(directory, outputs, [join(directory, "src")])]), ["pkg"]);
});

test("a missing source root cannot mark a package stale", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "dist", "index.d.ts"), SECOND);

	assert.deepEqual(
		staleProbes([probe(directory, [join(directory, "dist", "index.d.ts")], [join(directory, "src")])]),
		[],
	);
});

test("newestSourceMtimeMs skips build and dependency directories", async (t) => {
	const directory = await fixture(t);
	await write(join(directory, "a.ts"), SECOND);
	await write(join(directory, "nested", "b.json"), 2 * SECOND);
	await write(join(directory, "node_modules", "c.ts"), 3 * SECOND);
	await write(join(directory, "dist", "d.ts"), 4 * SECOND);

	assert.equal(newestSourceMtimeMs(directory), 2 * SECOND);
});
