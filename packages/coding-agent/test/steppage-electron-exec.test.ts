import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";

/**
 * Electron's Node runtime (the Desktop host runs with `ELECTRON_RUN_AS_NODE=1`)
 * ignores `execFile`'s custom-promisify hook, so `promisify(execFile)` resolves
 * with the stdout string instead of `{ stdout, stderr }`. Wrapping `execFile` in
 * a plain function reproduces that shape under ordinary Node.
 */
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	const execFile = (...args: Parameters<typeof original.execFile>) => original.execFile(...args);
	return { ...original, execFile };
});

const { execFile } = await import("node:child_process");
const { ensureStepPageReady } = await import("../src/step/steppage-provision.ts");

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executable(file: string, source: string) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, source);
	await chmod(file, 0o755);
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "steppage-electron-"));
	roots.push(root);
	const bin = join(root, "fixture-bin");
	await executable(join(bin, "node"), '#!/bin/sh\nprintf "v24.0.0\\n"\n');
	const env: NodeJS.ProcessEnv = {
		HOME: root,
		PATH: `${bin}:/usr/bin:/bin`,
		STEPCODE_STEPPAGE_INSTALLER_URL: "file:///missing-installer.sh",
	};
	return { root, bin, env };
}

test.skipIf(process.platform === "win32")("the mocked runtime reproduces Electron's promisify shape", async () => {
	const resolved: unknown = await promisify(execFile)("/bin/echo", ["1.0.0"]);
	expect(resolved).toBe("1.0.0\n");
});

test.skipIf(process.platform === "win32")("a healthy StepPage is found under Electron's promisify shape", async () => {
	const f = await fixture();
	const command = join(f.root, ".local", "bin", "steppage-mcp");
	await executable(command, '#!/bin/sh\nprintf "1.0.0\\n"\n');
	expect(await ensureStepPageReady({ env: f.env })).toEqual({ command, installed: false });
});

test.skipIf(process.platform === "win32")("the Node version is read under Electron's promisify shape", async () => {
	const f = await fixture();
	await executable(join(f.bin, "node"), '#!/bin/sh\nprintf "v18.0.0\\n"\n');
	// Reaching the version comparison proves `node --version` was read; the
	// old code reported Node as missing here.
	expect((await ensureStepPageReady({ env: f.env })).error).toContain("found v18.0.0");
});

test.skipIf(process.platform === "win32")("a missing Node reports that it was not found", async () => {
	const f = await fixture();
	await rm(join(f.bin, "node"));
	f.env.PATH = f.bin;
	expect((await ensureStepPageReady({ env: f.env })).error).toContain("node was not found on PATH");
});
