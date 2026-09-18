import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runStepConfigCommand } from "../src/step/command-compat.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// STEP_CODING_AGENT_DIR steers the config root to its parent, so the global
// config.toml the `init` subcommand targets lands inside the temp root.
async function makeEnv(): Promise<{ root: string; env: Record<string, string | undefined>; configPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "step-config-cmd-"));
	roots.push(root);
	return {
		root,
		env: { STEP_CODING_AGENT_DIR: join(root, "agent"), HOME: join(root, "home") },
		configPath: join(root, "config.toml"),
	};
}

function capture(): { stdout: { write: (chunk: string) => boolean }; text: () => string } {
	let text = "";
	return {
		stdout: {
			write: (chunk: string) => {
				text += chunk;
				return true;
			},
		},
		text: () => text,
	};
}

describe("runStepConfigCommand argument handling", () => {
	// Regression: `step config init --help` used to write the config template
	// (and exit 0) instead of printing help, because the init branch only read
	// --scope/--path/--force and never handled --help.
	test("`config init --help` prints usage and writes nothing", async () => {
		const { env, configPath } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "init", "--help"], { stdout: io.stdout, homeEnv: env });

		expect(io.text()).toContain("Usage: step config init");
		expect(io.text()).not.toContain("Wrote Step config template");
		expect(existsSync(configPath)).toBe(false);
	});

	test("`config init -h` prints usage and writes nothing", async () => {
		const { env, configPath } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "init", "-h"], { stdout: io.stdout, homeEnv: env });

		expect(io.text()).toContain("Usage: step config init");
		expect(existsSync(configPath)).toBe(false);
	});

	// Regression: an unknown flag was silently ignored and the template written.
	test("`config init --bogus` errors and writes nothing", async () => {
		const { env, configPath } = await makeEnv();
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "init", "--bogus"], { stdout: io.stdout, homeEnv: env }),
		).rejects.toThrow(/Unknown option "--bogus"/);
		expect(existsSync(configPath)).toBe(false);
	});

	test("`config init` still writes the template (happy path preserved)", async () => {
		const { env, configPath } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "init"], { stdout: io.stdout, homeEnv: env });

		expect(io.text()).toContain("Wrote Step config template");
		expect(existsSync(configPath)).toBe(true);
	});

	test("`config init --force` and `--scope`/`--path` remain accepted", async () => {
		const { env, root } = await makeEnv();
		const io = capture();
		const target = join(root, "explicit.toml");

		await runStepConfigCommand(["config", "init", "--path", target, "--force"], {
			stdout: io.stdout,
			homeEnv: env,
		});

		expect(existsSync(target)).toBe(true);
	});

	test("read-only subcommands honor --help and reject unknown flags", async () => {
		const { env } = await makeEnv();

		const help = capture();
		await runStepConfigCommand(["config", "path", "--help"], { stdout: help.stdout, homeEnv: env });
		expect(help.text()).toContain("Usage: step config path");

		await expect(
			runStepConfigCommand(["config", "show", "--bogus"], { stdout: capture().stdout, homeEnv: env }),
		).rejects.toThrow(/Unknown option "--bogus"/);
	});

	// User feedback: `step config init --path --force` consumed --force as the
	// --path value, writing a config file literally named "--force" and exiting 0.
	// A value-taking option must reject a missing or flag-like value.
	test("`config init --path --force` errors and writes no '--force' file", async () => {
		const { env, root, configPath } = await makeEnv();
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "init", "--path", "--force"], {
				stdout: io.stdout,
				homeEnv: env,
				cwd: root,
			}),
		).rejects.toThrow(/Option "--path" requires a value/);

		expect(io.text()).not.toContain("Wrote Step config template");
		expect(existsSync(join(process.cwd(), "--force"))).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	test("`config init --path` with no value errors and writes nothing", async () => {
		const { env, root, configPath } = await makeEnv();
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "init", "--path"], { stdout: io.stdout, homeEnv: env, cwd: root }),
		).rejects.toThrow(/Option "--path" requires a value/);
		expect(existsSync(configPath)).toBe(false);
	});

	test("`config init --scope --path <file>` errors on the missing --scope value", async () => {
		const { env, root } = await makeEnv();
		const io = capture();
		const target = join(root, "scoped.toml");

		await expect(
			runStepConfigCommand(["config", "init", "--scope", "--path", target], {
				stdout: io.stdout,
				homeEnv: env,
				cwd: root,
			}),
		).rejects.toThrow(/Option "--scope" requires a value/);
		expect(existsSync(target)).toBe(false);
	});

	test("`config init --path=<file>` inline form still writes the template", async () => {
		const { env, root } = await makeEnv();
		const io = capture();
		const target = join(root, "inline.toml");

		await runStepConfigCommand(["config", "init", `--path=${target}`], {
			stdout: io.stdout,
			homeEnv: env,
			cwd: root,
		});

		expect(existsSync(target)).toBe(true);
	});

	// An unset shell variable (`--path "$MISSING"`) used to resolve to the cwd and
	// fail later with a raw EISDIR instead of reporting the missing value.
	test("`config init --path ''` reports the missing value", async () => {
		const { env, root } = await makeEnv();
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "init", "--path", "", "--force"], {
				stdout: io.stdout,
				homeEnv: env,
				cwd: root,
			}),
		).rejects.toThrow(/Option "--path" requires a value/);
	});

	test("`config init --path=` reports the missing value", async () => {
		const { env, root } = await makeEnv();
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "init", "--path="], { stdout: io.stdout, homeEnv: env, cwd: root }),
		).rejects.toThrow(/Option "--path" requires a value/);
	});
});
