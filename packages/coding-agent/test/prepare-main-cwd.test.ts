import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { prepareMain } from "../src/main.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "step-cwd-"));
	tempDirs.push(dir);
	return dir;
}

/** A --cwd path that does not exist. The temp prefix keeps it unique per run. */
function missingCwdPath(): string {
	return join(makeTempDir(), "missing-target");
}

describe("prepareMain --cwd wiring", () => {
	test("settings manager is built against the --cwd directory at every entrypoint", async () => {
		const dir = makeTempDir();
		const seenCwds: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// --version is handled after the settings manager is built, so the factory
		// observes the cwd the run actually resolved.
		const result = await prepareMain(["--cwd", dir, "--version"], {
			settingsManagerFactory: (cwd) => {
				seenCwds.push(cwd);
				return SettingsManager.inMemory();
			},
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 0 });
		expect(seenCwds).toEqual([resolve(dir)]);
		expect(logSpy).toHaveBeenCalled();
	});

	test("an options.cwd passed by a product shell still wins over the flag", async () => {
		const flagDir = makeTempDir();
		const optionDir = makeTempDir();
		const seenCwds: string[] = [];
		vi.spyOn(console, "log").mockImplementation(() => {});

		await prepareMain(["--cwd", flagDir, "--version"], {
			cwd: optionDir,
			settingsManagerFactory: (cwd) => {
				seenCwds.push(cwd);
				return SettingsManager.inMemory();
			},
			disableBackgroundServices: true,
		});

		expect(seenCwds).toEqual([resolve(optionDir)]);
	});

	test("omitting the flag keeps the process cwd", async () => {
		const seenCwds: string[] = [];
		vi.spyOn(console, "log").mockImplementation(() => {});

		await prepareMain(["--version"], {
			settingsManagerFactory: (cwd) => {
				seenCwds.push(cwd);
				return SettingsManager.inMemory();
			},
			disableBackgroundServices: true,
		});

		expect(seenCwds).toEqual([resolve(process.cwd())]);
	});

	test("a nonexistent --cwd fails fast instead of reaching the session layer", async () => {
		const missing = missingCwdPath();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const factory = vi.fn(() => SettingsManager.inMemory());

		const result = await prepareMain(["--cwd", missing], {
			settingsManagerFactory: factory,
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 1 });
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("--cwd path does not exist");
		expect(stderr).toContain(resolve(missing));
		// The failure happens before any settings or session work.
		expect(factory).not.toHaveBeenCalled();
	});

	test("a --cwd pointing at a file fails fast", async () => {
		const dir = makeTempDir();
		const filePath = join(dir, "not-a-directory.txt");
		writeFileSync(filePath, "x", "utf-8");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await prepareMain(["--cwd", filePath], {
			settingsManagerFactory: () => SettingsManager.inMemory(),
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 1 });
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("--cwd path is not a directory");
	});

	test("--no-session does not skip the existence check", async () => {
		const missing = missingCwdPath();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await prepareMain(["--cwd", missing, "--no-session"], {
			settingsManagerFactory: () => SettingsManager.inMemory(),
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 1 });
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("--cwd path does not exist");
	});

	test("an empty --cwd is rejected instead of falling back to the process cwd", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const factory = vi.fn(() => SettingsManager.inMemory());

		const result = await prepareMain(["--cwd", ""], {
			settingsManagerFactory: factory,
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 1 });
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("--cwd requires a non-empty path");
		expect(factory).not.toHaveBeenCalled();
	});

	test("a whitespace-only --cwd is rejected too", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await prepareMain(["--cwd", "   "], {
			settingsManagerFactory: () => SettingsManager.inMemory(),
			disableBackgroundServices: true,
		});

		expect(result).toEqual({ kind: "completed", exitCode: 1 });
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain("--cwd requires a non-empty path");
	});
});
