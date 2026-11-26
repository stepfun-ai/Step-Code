import { existsSync, readFileSync } from "node:fs";
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

describe("runStepConfigCommand schema files", () => {
	test("`config init` writes the editor directive and both schemas beside the file", async () => {
		const { env, root, configPath } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "init"], { stdout: io.stdout, homeEnv: env });

		const template = readFileSync(configPath, "utf8");
		expect(template.split("\n")[0]).toBe("#:schema ./config.schema.json");
		expect(existsSync(join(root, "config.schema.json"))).toBe(true);
		expect(existsSync(join(root, "models.schema.json"))).toBe(true);
		expect(io.text()).toContain("config.schema.json");
	});

	// The schema lives beside the global file only. A project or explicitly
	// placed file belongs to a directory StepCode does not own, and two ~80 KB
	// files in every checkout would show up in `git status`.
	test("`config init --path <file>` writes no schema beside that file", async () => {
		const { env, root } = await makeEnv();
		const target = join(root, "elsewhere", "config.toml");

		await runStepConfigCommand(["config", "init", "--path", target], {
			stdout: capture().stdout,
			homeEnv: env,
		});

		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(root, "elsewhere", "config.schema.json"))).toBe(false);
		expect(readFileSync(target, "utf8").split("\n")[0]).toBe("# StepCode configuration");
	});

	test("`config init --scope workspace` writes no schema into the project", async () => {
		const { env, root } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "init", "--scope", "workspace"], {
			stdout: io.stdout,
			homeEnv: env,
			cwd: root,
		});

		expect(existsSync(join(root, ".stepcode", "config.toml"))).toBe(true);
		expect(existsSync(join(root, ".stepcode", "config.schema.json"))).toBe(false);
	});

	test("the written template is a valid document", async () => {
		const { env, configPath } = await makeEnv();
		await runStepConfigCommand(["config", "init"], { stdout: capture().stdout, homeEnv: env });

		// The template is the first thing a new user edits, so it must satisfy
		// the schema shipped next to it.
		const { Compile } = await import("typebox/compile");
		const { parse } = await import("smol-toml");
		const { ConfigTomlSchema } = await import("../src/step/config-schema.ts");
		expect(Compile(ConfigTomlSchema).Check(parse(readFileSync(configPath, "utf8")))).toBe(true);
	});

	test("`config schema` prints the settings schema as JSON", async () => {
		const { env } = await makeEnv();
		const io = capture();

		await runStepConfigCommand(["config", "schema"], { stdout: io.stdout, homeEnv: env });

		const schema = JSON.parse(io.text());
		expect(schema.title).toContain("config.toml");
		expect(schema.properties.compaction).toBeDefined();
	});

	test("`config schema models --out <file>` writes the models schema", async () => {
		const { env, root } = await makeEnv();
		const target = join(root, "models.schema.json");

		await runStepConfigCommand(["config", "schema", "models", "--out", target], {
			stdout: capture().stdout,
			homeEnv: env,
		});

		const schema = JSON.parse(readFileSync(target, "utf8"));
		expect(schema.title).toContain("models.json");
		expect(schema.properties.providers).toBeDefined();
	});

	test("`config schema` rejects an unknown target", async () => {
		const { env } = await makeEnv();
		await expect(
			runStepConfigCommand(["config", "schema", "bogus"], { stdout: capture().stdout, homeEnv: env }),
		).rejects.toThrow(/Unknown schema "bogus"/);
	});
});

describe("runStepConfigCommand on a file a launch already created", () => {
	// A launch creates an empty config.toml before the user asks for a template.
	// Refusing to fill it forced `--force`, which also overwrites real settings.
	test("`config init` fills an empty file without --force", async () => {
		const { env, configPath } = await makeEnv();
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(configPath, "#:schema ./config.schema.json\n# StepCode configuration\n");

		const io = capture();
		await runStepConfigCommand(["config", "init"], { stdout: io.stdout, homeEnv: env });

		expect(io.text()).toContain("Wrote Step config template");
		expect(readFileSync(configPath, "utf8")).toContain("defaultModel");
	});

	test("`config init` still refuses a file that holds a setting", async () => {
		const { env, configPath } = await makeEnv();
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(configPath, 'theme = "dark"\n');

		await expect(
			runStepConfigCommand(["config", "init"], { stdout: capture().stdout, homeEnv: env }),
		).rejects.toThrow(/already exists/);
		expect(readFileSync(configPath, "utf8")).toBe('theme = "dark"\n');
	});
});

describe("config show redaction", () => {
	// `show` is the discovery entry, so its output lands in transcripts and
	// issues. Field names are useful; key material is not.
	test("redacts credentials in config.toml as well as models.json", async () => {
		const { env, root, configPath } = await makeEnv();
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(
			configPath,
			[
				"[mcp_servers.remote]",
				'url = "https://example.test"',
				'bearer_token_env_var = "MY_TOKEN_VAR"',
				'env = { GITHUB_TOKEN = "ENV_TOKEN_VALUE", PATH = "/usr/bin" }',
				'http_headers = { Authorization = "Bearer HEADER_SECRET" }',
				"[mcp_servers.remote.oauth]",
				'client_secret = "TOML_SECRET"',
				'client_id = "public-id"',
				"",
			].join("\n"),
		);
		writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { p: { apiKey: "SK_SECRET" } } }));
		const io = capture();

		await runStepConfigCommand(["config", "show"], { stdout: io.stdout, homeEnv: env });
		const text = io.text();

		for (const secret of ["ENV_TOKEN_VALUE", "HEADER_SECRET", "TOML_SECRET", "SK_SECRET"]) {
			expect(text).not.toContain(secret);
		}
		// A non-secret value and a reference by name stay readable.
		expect(text).toContain("/usr/bin");
		expect(text).toContain("MY_TOKEN_VAR");
		expect(text).toContain("public-id");
	});
});

describe("config schema --out", () => {
	// `--out` and the target are both bare words; skipping the option value by
	// position keeps `--out models` from selecting the models schema.
	test("writes the config schema when --out is named models", async () => {
		const { env, root } = await makeEnv();
		const target = join(root, "models");

		await runStepConfigCommand(["config", "schema", "--out", target], {
			stdout: capture().stdout,
			homeEnv: env,
		});

		expect(JSON.parse(readFileSync(target, "utf8")).title).toContain("config.toml");
	});

	test("writes the models schema when the target and --out share a name", async () => {
		const { env, root } = await makeEnv();
		const target = join(root, "config");

		await runStepConfigCommand(["config", "schema", "models", "--out", target], {
			stdout: capture().stdout,
			homeEnv: env,
		});

		expect(JSON.parse(readFileSync(target, "utf8")).title).toContain("models.json");
	});

	test("rejects an extra positional argument", async () => {
		const { env } = await makeEnv();
		await expect(
			runStepConfigCommand(["config", "schema", "models", "extra"], {
				stdout: capture().stdout,
				homeEnv: env,
			}),
		).rejects.toThrow(/Unexpected argument "extra"/);
	});
});

describe("a launch never rewrites the config file", () => {
	// The schema copies are refreshed on every launch; the config file is only
	// written when the user changes a setting. Adding the editor directive is
	// part of a write that was going to happen, not a write of its own.
	test("refreshing schema copies leaves an existing config byte-identical", async () => {
		const { env, root, configPath } = await makeEnv();
		const { mkdirSync, statSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(configPath, ".."), { recursive: true });
		const content = '# StepCode configuration\ntheme = "dark"\n';
		writeFileSync(configPath, content);
		const before = statSync(configPath).mtimeMs;

		// `ensureStepGlobalConfig` is what a launch calls.
		const { ensureStepGlobalConfig } = await import("../src/step/config-toml.ts");
		ensureStepGlobalConfig(env);

		expect(readFileSync(configPath, "utf8")).toBe(content);
		expect(statSync(configPath).mtimeMs).toBe(before);
		expect(existsSync(join(root, "config.schema.json"))).toBe(true);
	});
});
