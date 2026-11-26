import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runStepConfigCommand } from "../src/step/command-compat.ts";
import { checkStepConfigFiles, describePath } from "../src/step/config-check.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<{ root: string; env: Record<string, string | undefined> }> {
	const root = await mkdtemp(join(tmpdir(), "step-config-check-"));
	roots.push(root);
	return { root, env: { STEP_CODING_AGENT_DIR: join(root, "agent"), HOME: join(root, "home") } };
}

function capture() {
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

describe("config check", () => {
	test("accepts the file `config init` writes", async () => {
		const { root, env } = await makeRoot();
		await runStepConfigCommand(["config", "init"], { stdout: capture().stdout, homeEnv: env });

		const result = checkStepConfigFiles({
			globalSettings: join(root, "config.toml"),
			projectSettings: join(root, ".stepcode", "config.toml"),
			models: join(root, "models.json"),
		});
		expect(result.problems).toEqual([]);
		expect(result.checkedFiles).toEqual([join(root, "config.toml")]);
	});

	test("reports a misspelled key as an unknown key", () => {
		const result = checkConfigFilesWith("triggerRation = 0.9\n");
		const unknown = result.problems.filter((problem) => problem.kind === "unknown");
		expect(unknown).toHaveLength(1);
		expect(unknown[0]!.message).toContain("triggerRation");
	});

	test("reports an out-of-range value with its path", () => {
		const result = checkConfigFilesWith("[compaction]\ntriggerRatio = 5\n");
		const invalid = result.problems.filter((problem) => problem.kind === "invalid");
		expect(invalid.map((problem) => describePath(problem.path))).toEqual(["compaction.triggerRatio"]);
		expect(invalid[0]!.message).toContain("0.95");
	});

	test("lists the accepted values of a closed set instead of one error per member", () => {
		const result = checkConfigFilesWith('[search]\nprovider = "nope"\n');
		const invalid = result.problems.filter((problem) => problem.kind === "invalid");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.message).toContain('"auto"');
		expect(invalid[0]!.message).toContain('"tavily"');
	});

	test("reports a parse error without throwing", () => {
		const result = checkConfigFilesWith("this is not toml = = =\n");
		expect(result.problems.map((problem) => problem.kind)).toEqual(["parse"]);
	});

	// An unknown key and a rejected value are the same problem in the end: the
	// setting does not do what it says. Both fail the check.
	test("`config check` fails on an unknown key and on a rejected value alike", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });

		await writeFile(join(root, "config.toml"), "unknownButHarmless = 1\n");
		await expect(
			runStepConfigCommand(["config", "check"], { stdout: capture().stdout, homeEnv: env }),
		).rejects.toThrow(/configuration problem/);

		await writeFile(join(root, "config.toml"), "[compaction]\ntriggerRatio = 5\n");
		await expect(
			runStepConfigCommand(["config", "check"], { stdout: capture().stdout, homeEnv: env }),
		).rejects.toThrow(/configuration problem/);
	});

	test("`config check --json` reports files, problems and kinds", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "config.toml"), "triggerRation = 0.9\n");
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "check", "--json"], { stdout: io.stdout, homeEnv: env }),
		).rejects.toThrow(/configuration problem/);

		const payload = JSON.parse(io.text());
		expect(payload.ok).toBe(false);
		expect(payload.problems[0].kind).toBe("unknown");
	});
});

function checkConfigFilesWith(content: string) {
	// Reuse the exported entry point against a synchronous temp file so the
	// assertions stay about the message, not about setup.
	const root = mkdtempSync(join(tmpdir(), "step-config-check-sync-"));
	roots.push(root);
	writeFileSync(join(root, "config.toml"), content);
	return checkStepConfigFiles({
		globalSettings: join(root, "config.toml"),
		projectSettings: join(root, "missing", "config.toml"),
		models: join(root, "missing.json"),
	});
}

describe("config check reports every problem, not the first few", () => {
	// TypeBox stops collecting after eight errors by default. A file with more
	// problems than that must not look clean, and an unrelated error earlier in
	// the file must not hide a later one.
	// Invalid values, not unknown keys: those come from the schema walk, so they
	// would pass even with TypeBox's default eight-error limit.
	test("a file with more than eight invalid values reports all of them", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });
		const entries = Array.from({ length: 12 }, (_, index) => `{ provider = "p${index}", id = "" }`);
		await writeFile(join(root, "config.toml"), `recentModels = [${entries.join(", ")}]\n`);
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "check", "--json"], { stdout: io.stdout, homeEnv: env }),
		).rejects.toThrow();
		expect(JSON.parse(io.text()).problems.length).toBeGreaterThanOrEqual(12);
	});

	test("a later invalid value is still reported when an unknown key fails first", async () => {
		const result = checkConfigFilesWith('triggerRation = 0.9\n[search]\nprovider = "nope"\n');
		const kinds = result.problems.map((problem) => problem.kind).sort();
		expect(kinds).toEqual(["invalid", "unknown"]);
	});
});

describe("config check paths", () => {
	test("a record key containing a dot is reported unambiguously", () => {
		const result = checkConfigFilesWith('[compaction]\nmodelTriggerRatios = { "vendor/model.3" = "bad" }\n');
		const invalid = result.problems.filter((problem) => problem.kind === "invalid");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.path).toBe("/compaction/modelTriggerRatios/vendor~1model.3");
	});

	test("an unknown key inside an array entry is found once", () => {
		const result = checkConfigFilesWith('packages = [{ source = "x", bogus = 1 }]\n');
		const unknown = result.problems.filter((problem) => problem.kind === "unknown");
		expect(unknown.map((problem) => problem.path)).toEqual(["/packages/0/bogus"]);
		// And it does not also surface as "must be string" from the union member.
		expect(
			result.problems
				.filter((problem) => problem.kind === "invalid")
				.map((problem) => problem.message)
				.filter((message) => message.includes("string")),
		).toEqual([]);
	});

	test("the legacy permission spellings the runtime maps are accepted", () => {
		const result = checkConfigFilesWith('permissionPreset = "yolo"\napprovalMode = "bypass"\n');
		expect(result.problems).toEqual([]);
	});
});

describe("config check matches what the loader accepts", () => {
	// Each case is a value the runtime normalizes or migrates; reporting it as
	// invalid made `check` cry wolf on a file that works.
	test.each([
		["legacy steering key", 'queueMode = "all"\n'],
		["legacy transport key", "websockets = true\n"],
		["legacy retry delay", "[retry]\nmaxDelayMs = 5000\n"],
		["legacy skills object", '[skills]\ncustomDirectories = ["/tmp/x"]\n'],
		["uppercase tier", 'permissionPreset = "Ask"\n'],
		["padded tier", 'permissionPreset = "  full-access  "\n'],
		["uppercase approval mode", 'approvalMode = "Confirm"\n'],
		["legacy flat tier", 'permissionMode = "yolo"\n'],
		["disabled timeout", 'httpIdleTimeoutMs = "disabled"\n'],
		["numeric-string timeout", 'httpIdleTimeoutMs = "60000"\n'],
	])("%s is accepted", (_label, content) => {
		expect(checkConfigFilesWith(content).problems).toEqual([]);
	});

	test.each([
		["ratio out of range", '[compaction]\nmodelTriggerRatios = { "a/b" = 2.0 }\n'],
		["zero token limit", "[compaction]\ntokenLimit = 0\n"],
		["fractional token limit", "[compaction]\ntokenLimit = 1.5\n"],
	])("%s is reported, because the loader drops it", (_label, content) => {
		const problems = checkConfigFilesWith(content).problems;
		expect(problems.filter((problem) => problem.kind === "invalid")).not.toEqual([]);
	});
});

describe("config check and models.json", () => {
	test("reports a misspelled provider field", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({ providers: { local: { baseurl: "http://x", models: [{ id: "m", contextwindow: 1 }] } } }),
		);
		const io = capture();

		await expect(
			runStepConfigCommand(["config", "check", "--json"], { stdout: io.stdout, homeEnv: env }),
		).rejects.toThrow();

		const paths = (JSON.parse(io.text()).problems as Array<{ path: string }>).map((problem) => problem.path);
		expect(paths).toContain("/providers/local/baseurl");
		expect(paths).toContain("/providers/local/models/0/contextwindow");
	});

	test("a record such as samplingParams stays open", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					local: { models: [{ id: "m", samplingParams: { temperature: 0.2, vendorFlag: true } }] },
				},
			}),
		);

		await expect(
			runStepConfigCommand(["config", "check"], { stdout: capture().stdout, homeEnv: env }),
		).resolves.toBeUndefined();
	});
});

describe("config check escape hatch", () => {
	// A config written by a newer release is not something this binary can act
	// on, but failing a build over it is worse than saying so.
	test("--allow-unknown passes with an unknown key and still fails on a bad value", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });

		await writeFile(join(root, "config.toml"), "fromAFutureRelease = 1\n");
		await expect(
			runStepConfigCommand(["config", "check", "--allow-unknown"], {
				stdout: capture().stdout,
				homeEnv: env,
			}),
		).resolves.toBeUndefined();

		await writeFile(join(root, "config.toml"), 'fromAFutureRelease = 1\n[search]\nprovider = "nope"\n');
		await expect(
			runStepConfigCommand(["config", "check", "--allow-unknown"], {
				stdout: capture().stdout,
				homeEnv: env,
			}),
		).rejects.toThrow(/configuration problem/);
	});
});

describe("config check never writes the user's config", () => {
	// The schema copies are refreshed on launch; the config file is not. A check
	// that rewrote it, even to add one comment, would be a surprise.
	test("leaves a config without the editor directive byte-identical", async () => {
		const { root, env } = await makeRoot();
		await mkdir(root, { recursive: true });
		const content = 'theme = "dark"\n';
		await writeFile(join(root, "config.toml"), content);

		const io = capture();
		await runStepConfigCommand(["config", "check"], { stdout: io.stdout, homeEnv: env });

		expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(content);
		expect(io.text()).toContain("#:schema ./config.schema.json");
	});
});

describe("config check unknown-key messages", () => {
	test("names the build and suggests the closest declared key", () => {
		const result = checkConfigFilesWith("[compaction]\ntriggerRation = 0.9\n");
		const unknown = result.problems.filter((problem) => problem.kind === "unknown");
		expect(unknown).toHaveLength(1);
		expect(unknown[0]!.message).toContain("does not read");
		expect(unknown[0]!.message).toContain('did you mean "triggerRatio"');
	});

	test("does not guess when the key is unrelated", () => {
		const result = checkConfigFilesWith("fromAFutureRelease = 1\n");
		const unknown = result.problems.filter((problem) => problem.kind === "unknown");
		expect(unknown[0]!.message).not.toContain("did you mean");
	});
});

describe("config check reports one message per field", () => {
	// A union produces one failure per member. Listing them separately makes one
	// bad value look like several problems, and a summary on a parent contradicts
	// a valid object whose field is wrong.
	test("a bad field inside a package entry does not also condemn the entry", () => {
		const result = checkConfigFilesWith("packages = [{ source = 1 }]\n");
		expect(result.problems.map((problem) => problem.path)).toEqual(["/packages/0/source"]);
	});

	test("a union of a type and a literal names both", () => {
		const result = checkConfigFilesWith('[terminal]\nhyperlinks = "sometimes"\n');
		const invalid = result.problems.filter((problem) => problem.kind === "invalid");
		expect(invalid).toHaveLength(1);
		expect(invalid[0]!.message).toContain("boolean");
		expect(invalid[0]!.message).toContain('"auto"');
	});

	test("a timeout accepts the forms the dispatcher parses", () => {
		expect(checkConfigFilesWith('httpIdleTimeoutMs = "60000"\n').problems).toEqual([]);
		expect(checkConfigFilesWith('httpIdleTimeoutMs = "disabled"\n').problems).toEqual([]);
		const bad = checkConfigFilesWith('httpIdleTimeoutMs = "sometimes"\n');
		expect(bad.problems.filter((problem) => problem.kind === "invalid")).toHaveLength(1);
	});

	test("a bad value under a migrated key is reported at the key the user wrote", () => {
		// The check validates the file as written. Reporting `/steeringMode` for a
		// typo in `queueMode` would point at a line that is not in the file.
		const result = checkConfigFilesWith('queueMode = "nope"\n');
		expect(result.problems.map((problem) => problem.path)).toEqual(["/queueMode"]);
	});

	test("a malformed value in a migrated key is not silently dropped", () => {
		const result = checkConfigFilesWith('[retry]\nmaxDelayMs = "abc"\n');
		expect(result.problems.map((problem) => problem.path)).toEqual(["/retry/maxDelayMs"]);
	});

	test("a misspelling inside the older skills table is found", () => {
		const result = checkConfigFilesWith('[skills]\ncustomDirectores = ["/x"]\n');
		expect(result.problems.map((problem) => problem.path)).toEqual(["/skills/customDirectores"]);
	});
});

describe("project settings are never given the editor directive", () => {
	test("writing a project config leaves its header alone", async () => {
		const { root, env } = await makeRoot();
		const project = join(root, ".stepcode");
		await mkdir(project, { recursive: true });
		const path = join(project, "config.toml");
		await writeFile(path, 'theme = "dark"\n');

		const { writeStepConfig } = await import("../src/step/config-toml.ts");
		writeStepConfig(path, { theme: "dark", quietStartup: true }, { editorDirective: false });

		expect(readFileSync(path, "utf8")).not.toContain("#:schema");
		expect(env).toBeDefined();
	});
});
