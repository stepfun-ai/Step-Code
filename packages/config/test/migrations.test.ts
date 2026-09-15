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

function makeAgentDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "step-config-mig-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
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
			configDirName: ".step-cli",
			migrateKeybindings: (config) => ({ config, migrated: false }),
		});

		expect(result.migratedAuthProviders).toEqual(["step"]);
		expect(result.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("invokes the injected keybindings migrator and persists a migrated config", () => {
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ old: true }));
		let called = false;

		runMigrations(agentDir, {
			agentDir,
			configDirName: ".step-cli",
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
	const cwd = mkdtempSync(join(tmpdir(), "step-config-mig-cwd-"));
	mkdirSync(join(cwd, ".step-cli", "hooks"), { recursive: true });
	return cwd;
}
