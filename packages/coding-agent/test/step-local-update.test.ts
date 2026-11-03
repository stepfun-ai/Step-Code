import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { StepUpdateInstallInput } from "../src/step/local-update.ts";
import {
	compareStepReleaseVersions,
	maybeUpdateStep,
	readStepSkippedUpdateVersion,
	resolveStepUpdateInstallerSpec,
	writeStepSkippedUpdateVersion,
} from "../src/step/local-update.ts";

const embeddedVersion = { value: "0.1.0", source: "embedded" as const };

describe("Step binary updater", () => {
	test("compares numeric versions and prereleases", () => {
		expect(compareStepReleaseVersions("v0.3.10", "v0.3.9")).toBeGreaterThan(0);
		expect(compareStepReleaseVersions("v0.4.0-beta.1", "v0.4.0")).toBeLessThan(0);
	});

	test("persists a deferred version in the Step storage root", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "step-update-state-"));
		try {
			await writeStepSkippedUpdateVersion(root, "v9.9.9");
			expect(await readStepSkippedUpdateVersion(root)).toBe("v9.9.9");
			expect(await readFile(path.join(root, "tui-update-state.json"), "utf8")).toContain("v9.9.9");
			await writeStepSkippedUpdateVersion(root, null);
			expect(await readStepSkippedUpdateVersion(root)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses Pi UI selection and defers without installing", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "step-update-defer-"));
		try {
			const select = vi.fn(async () => "Skip until next version");
			const install = vi.fn();
			const outcome = await maybeUpdateStep({
				version: embeddedVersion,
				storageRootDir: root,
				executablePath: path.join(root, "bin", "step"),
				interactive: true,
				ui: { select, notify: vi.fn() },
				fetchLatestVersion: vi.fn(async () => "v0.4.0"),
				installUpdate: install,
			});
			expect(outcome).toBe("deferred");
			expect(select).toHaveBeenCalledWith(
				"Update available\nv0.1.0 -> v0.4.0",
				expect.arrayContaining(["Skip until next version"]),
			);
			expect(install).not.toHaveBeenCalled();
			expect(await readStepSkippedUpdateVersion(root)).toBe("v0.4.0");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("installs in the running binary directory and relaunches after cleanup", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "step-update-install-"));
		try {
			const executablePath = path.join(root, "bin", "step");
			const select = vi.fn(async (_title: string, options: string[]) => options[0]);
			const install = vi.fn(async (input: StepUpdateInstallInput) => ({
				ok: true,
				message: "updated",
				relaunchedBinaryPath: path.join(input.installDir, "step"),
			}));
			const relaunch = vi.fn(async () => undefined);
			const beforeRelaunch = vi.fn(async () => undefined);
			const outcome = await maybeUpdateStep({
				version: embeddedVersion,
				storageRootDir: root,
				executablePath,
				interactive: true,
				ui: { select, notify: vi.fn() },
				fetchLatestVersion: vi.fn(async () => "v0.4.0"),
				installUpdate: install,
				beforeRelaunch,
				relaunchBinary: relaunch,
				argv: ["--no-update-check"],
				cwd: root,
			});
			expect(outcome).toBe("restarted");
			expect(install).toHaveBeenCalledWith(expect.objectContaining({ installDir: path.join(root, "bin") }));
			expect(beforeRelaunch).toHaveBeenCalledOnce();
			expect(relaunch).toHaveBeenCalledWith(
				expect.objectContaining({ binaryPath: path.join(root, "bin", "step"), argv: ["--no-update-check"] }),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not check fallback builds unless explicitly forced", async () => {
		const fetchLatest = vi.fn(async () => "v9.9.9");
		const root = await mkdtemp(path.join(os.tmpdir(), "step-update-fallback-"));
		try {
			const fallback = await maybeUpdateStep({
				version: { value: "0.1.0", source: "fallback" },
				storageRootDir: root,
				executablePath: path.join(root, "step"),
				interactive: true,
				ui: { select: vi.fn(), notify: vi.fn() },
				fetchLatestVersion: fetchLatest,
			});
			expect(fallback).toBe("disabled");
			expect(fetchLatest).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("selects the platform installer", () => {
		expect(resolveStepUpdateInstallerSpec("darwin").scriptName).toBe("install.sh");
		expect(resolveStepUpdateInstallerSpec("win32").scriptName).toBe("install.ps1");
	});
});
