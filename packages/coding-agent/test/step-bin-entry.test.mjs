import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveStepEntrypoint } from "../bin/runtime-entry.js";

const tempDirectories = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function createLayout({ source = false, bundle = false, tsconfig = false } = {}) {
	const repoRoot = await mkdtemp(join(tmpdir(), "step-bin-entry-"));
	tempDirectories.push(repoRoot);
	const packageRoot = join(repoRoot, "packages", "coding-agent");
	await mkdir(packageRoot, { recursive: true });
	if (source) {
		await mkdir(join(packageRoot, "src"), { recursive: true });
		await writeFile(join(packageRoot, "src", "step-cli.ts"), "export {};\n");
	}
	if (bundle) {
		await mkdir(join(packageRoot, "dist", "bundle"), { recursive: true });
		await writeFile(join(packageRoot, "dist", "bundle", "step.js"), "export {};\n");
	}
	if (tsconfig) {
		await writeFile(join(repoRoot, "tsconfig.json"), "{}\n");
	}
	return { packageRoot, repoRoot };
}

describe("Step bin entrypoint resolution", () => {
	test("runs source through tsx when linked from a development checkout", async () => {
		const { packageRoot, repoRoot } = await createLayout({ source: true, bundle: true, tsconfig: true });
		const entrypoint = await resolveStepEntrypoint({
			packageRoot,
			repoRoot,
			argv: ["--version"],
			packageResolver: () => "/workspace/node_modules/tsx/dist/loader.mjs",
		});

		expect(entrypoint).toEqual({
			kind: "source",
			command: process.execPath,
			args: [
				"--import",
				"/workspace/node_modules/tsx/dist/loader.mjs",
				join(packageRoot, "src", "step-cli.ts"),
				"--version",
			],
			env: { TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json") },
		});
	});

	test("falls back to the bundle when source execution is unavailable", async () => {
		const { packageRoot, repoRoot } = await createLayout({ source: true, bundle: true, tsconfig: true });
		const entrypoint = await resolveStepEntrypoint({
			packageRoot,
			repoRoot,
			argv: ["--help"],
			packageResolver: () => {
				throw new Error("tsx unavailable");
			},
		});

		expect(entrypoint).toEqual({
			kind: "bundle",
			command: process.execPath,
			args: [join(packageRoot, "dist", "bundle", "step.js"), "--help"],
			env: {},
		});
	});

	test("uses the bundle in a published package without source files", async () => {
		const { packageRoot, repoRoot } = await createLayout({ bundle: true });
		const entrypoint = await resolveStepEntrypoint({ packageRoot, repoRoot, argv: [] });

		expect(entrypoint.kind).toBe("bundle");
		expect(entrypoint.args).toEqual([join(packageRoot, "dist", "bundle", "step.js")]);
	});

	test("reports a clear error when neither entrypoint can run", async () => {
		const { packageRoot, repoRoot } = await createLayout();

		await expect(resolveStepEntrypoint({ packageRoot, repoRoot })).rejects.toThrow(
			"Install workspace dependencies for source mode or build the coding-agent package",
		);
	});
});
