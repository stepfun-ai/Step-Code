import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findArchiveRoot, formatInstallerFailure, installLatestStepRelease } from "./local-update.ts";

let extractDir: string;

beforeEach(async () => {
	extractDir = await mkdtemp(path.join(os.tmpdir(), "step-update-archive-root-"));
});

afterEach(async () => {
	await rm(extractDir, { recursive: true, force: true });
});

test("a flat Windows zip keeps the extract dir as archive root", async () => {
	await writeFile(path.join(extractDir, "step.exe"), "binary");
	await mkdir(path.join(extractDir, "docs"));
	await mkdir(path.join(extractDir, "node_modules"));

	expect(await findArchiveRoot(extractDir, "step.exe")).toBe(extractDir);
});

test("a wrapped Unix archive descends into the single top-level directory", async () => {
	const wrapper = path.join(extractDir, "step");
	await mkdir(wrapper);
	await writeFile(path.join(wrapper, "step"), "binary");
	await mkdir(path.join(wrapper, "docs"));

	expect(await findArchiveRoot(extractDir, "step")).toBe(wrapper);
});

test("a wrapper directory wins over loose files at the extract root", async () => {
	const wrapper = path.join(extractDir, "step");
	await mkdir(wrapper);
	await writeFile(path.join(wrapper, "step"), "binary");
	await writeFile(path.join(extractDir, "README.md"), "notes");

	expect(await findArchiveRoot(extractDir, "step")).toBe(wrapper);
});

test("ambiguous layouts fall back to the extract dir for recursive search", async () => {
	await mkdir(path.join(extractDir, "bin"));
	await mkdir(path.join(extractDir, "lib"));

	expect(await findArchiveRoot(extractDir, "step")).toBe(extractDir);
});

test("installer failure message stays bare when the installer produced no output", () => {
	expect(formatInstallerFailure("install.ps1", 1, "  \n \n ")).toBe("install.ps1 exited with code 1");
});

test("installer failure message includes the captured installer output", () => {
	const message = formatInstallerFailure("install.ps1", 1, "downloading release…\nfatal: checksum mismatch");

	expect(message).toContain("install.ps1 exited with code 1");
	expect(message).toContain("downloading release…");
	expect(message).toContain("fatal: checksum mismatch");
});

test("installer failure message keeps only the tail of long output", () => {
	const lines = Array.from({ length: 50 }, (_, index) => `installer line ${index + 1}`);
	const message = formatInstallerFailure("install.sh", 2, lines.join("\n"));

	expect(message).toContain("install.sh exited with code 2");
	expect(message).toContain("installer line 50");
	expect(message).toContain("installer line 31");
	expect(message).not.toContain("installer line 30\n");
	expect(message).toContain("last 20 of 50 lines");
});

test("installLatestStepRelease surfaces installer output when the installer exits non-zero", async () => {
	const isWindows = process.platform === "win32";
	const scriptName = isWindows ? "install.ps1" : "install.sh";
	const scriptBody = isWindows
		? 'Write-Output "installer-output-marker"\nexit 1'
		: 'echo "installer-output-marker"\nexit 1';
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		text: async () => scriptBody,
	})) as unknown as typeof fetch;
	try {
		const result = await installLatestStepRelease({
			executablePath: path.join(extractDir, isWindows ? "step.exe" : "step"),
			installDir: extractDir,
			releaseBaseUrl: "https://example.invalid",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain(`${scriptName} exited with code 1`);
		expect(result.message).toContain("installer-output-marker");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
