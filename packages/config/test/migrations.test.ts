import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	migrateAuthToAuthJson,
	migrateSessionsFromAgentRoot,
	runMigrations,
	showDeprecationWarnings,
} from "../src/index.ts";

let tempDir: string | undefined;
const tempCwds: string[] = [];

function makeAgentDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "step-config-mig-"));
	return tempDir;
}

/** Create a project cwd temp dir tracked for afterEach cleanup (survives assertion failures). */
function makeCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "step-config-mig-cwd-"));
	tempCwds.push(cwd);
	return cwd;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
	for (const cwd of tempCwds.splice(0)) {
		rmSync(cwd, { recursive: true, force: true });
	}
});

describe("migrateAuthToAuthJson", () => {
	it("folds legacy oauth.json into auth.json and marks the source migrated", () => {
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "oauth.json"), JSON.stringify({ step: { access: "tok" } }));

		const providers = migrateAuthToAuthJson(agentDir);

		expect(providers).toEqual(["step"]);
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
		expect(auth.step).toEqual({ type: "oauth", access: "tok" });
		expect(existsSync(join(agentDir, "oauth.json.migrated"))).toBe(true);
	});

	it("promotes settings.json apiKeys and strips them from settings", () => {
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ apiKeys: { step: "sk-1" }, other: 1 }));

		const providers = migrateAuthToAuthJson(agentDir);

		expect(providers).toEqual(["step"]);
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
		expect(auth.step).toEqual({ type: "api_key", key: "sk-1" });
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(settings.apiKeys).toBeUndefined();
		expect(settings.other).toBe(1);
	});

	it("is a no-op when auth.json already exists", () => {
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ existing: true }));
		writeFileSync(join(agentDir, "oauth.json"), JSON.stringify({ step: { access: "tok" } }));

		expect(migrateAuthToAuthJson(agentDir)).toEqual([]);
		expect(existsSync(join(agentDir, "oauth.json"))).toBe(true);
	});
});

describe("migrateSessionsFromAgentRoot", () => {
	it("relocates stray session files into sessions/<encoded-cwd>/", () => {
		const agentDir = makeAgentDir();
		const header = JSON.stringify({ type: "session", cwd: "/home/user/project" });
		writeFileSync(join(agentDir, "abc.jsonl"), `${header}\n{"type":"message"}\n`);

		migrateSessionsFromAgentRoot(agentDir);

		const moved = join(agentDir, "sessions", "--home-user-project--", "abc.jsonl");
		expect(existsSync(moved)).toBe(true);
		expect(existsSync(join(agentDir, "abc.jsonl"))).toBe(false);
	});

	it("does not throw when the agent directory is missing", () => {
		const agentDir = join(tmpdir(), "step-config-mig-missing-xyz");
		expect(() => migrateSessionsFromAgentRoot(agentDir)).not.toThrow();
	});
});

describe("runMigrations", () => {
	it("orchestrates auth migration and reports extension-system warnings using the injected inputs", () => {
		const agentDir = makeAgentDir();
		const cwd = makeCwdWithHooks();
		writeFileSync(join(agentDir, "oauth.json"), JSON.stringify({ step: { access: "tok" } }));

		const result = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});

		expect(result.migratedAuthProviders).toEqual(["step"]);
		expect(result.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(true);
	});

	it("stops warning about a leftover hooks/ once the scope has an extensions/ directory", () => {
		const agentDir = makeAgentDir();
		const cwd = makeCwd();
		// Migrated scope: extensions/ present, a stale hooks/ left behind must not nag.
		mkdirSync(join(cwd, ".stepcode", "hooks"), { recursive: true });
		mkdirSync(join(cwd, ".stepcode", "extensions"), { recursive: true });

		const result = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});

		expect(result.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(false);
	});

	it("warns about a custom tools/ that has not migrated to extensions/", () => {
		// Positive control for the custom-tools path: without extensions/, the
		// warning must actually fire, so the suppression test below cannot pass green
		// on a broken customTools filter.
		const agentDir = makeAgentDir();
		const cwd = makeCwd();
		mkdirSync(join(cwd, ".stepcode", "tools"), { recursive: true });
		writeFileSync(join(cwd, ".stepcode", "tools", "my-tool.js"), "export default {};");

		const result = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});

		expect(result.deprecationWarnings.some((w) => w.includes("tools/"))).toBe(true);
	});

	it("also silences the custom-tools warning once extensions/ exists", () => {
		const agentDir = makeAgentDir();
		const cwd = makeCwd();
		mkdirSync(join(cwd, ".stepcode", "tools"), { recursive: true });
		writeFileSync(join(cwd, ".stepcode", "tools", "my-tool.js"), "export default {};");
		mkdirSync(join(cwd, ".stepcode", "extensions"), { recursive: true });

		const result = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});

		expect(result.deprecationWarnings.some((w) => w.includes("tools/"))).toBe(false);
	});

	it("applies the extensions/ guard per scope: the global agent dir warns and then goes silent", () => {
		// Global scope is a distinct call site (checkDeprecatedExtensionDirs(agentDir)).
		// Positive: a global hooks/ with no extensions/ warns.
		const agentDir = makeAgentDir();
		const cwd = makeCwd();
		mkdirSync(join(agentDir, "hooks"), { recursive: true });

		const before = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});
		expect(before.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(true);

		// Suppression: once the global agent dir has extensions/, the leftover hooks/ is silent.
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const after = runMigrations(cwd, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});
		expect(after.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(false);
	});

	it("invokes the injected keybindings migrator and persists a migrated config", () => {
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ old: true }));
		let called = false;

		runMigrations(agentDir, {
			agentDir,
			configDirName: ".stepcode",
			migrateKeybindings: (config) => {
				called = true;
				return { config: { ...config, migrated: true }, migrated: true };
			},
		});

		expect(called).toBe(true);
		const rewritten = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf-8"));
		expect(rewritten.migrated).toBe(true);
	});
});

describe("showDeprecationWarnings", () => {
	it("returns immediately when there are no warnings", async () => {
		await expect(showDeprecationWarnings([])).resolves.toBeUndefined();
	});
});

function makeCwdWithHooks(): string {
	const cwd = makeCwd();
	mkdirSync(join(cwd, ".stepcode", "hooks"), { recursive: true });
	return cwd;
}
