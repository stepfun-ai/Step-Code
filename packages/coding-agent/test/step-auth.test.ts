import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { STEP_PROVIDER_ID, STEP_STATIC_REFRESH_TOKEN } from "../src/features/step-provider/index.ts";
import {
	getLegacyStepAuthPath,
	getStepAuthPath,
	logoutStepCredentials,
	migrateLegacyStepCredential,
} from "../src/step/auth.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Step credential compatibility", () => {
	test("preserves the selected Step profile in the canonical credential", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-profile-"));
		temporaryDirectories.push(directory);
		const nativePath = join(directory, "agent", "auth.json");
		const legacyPath = join(directory, "legacy", "auth.json");
		await mkdir(join(directory, "legacy"), { recursive: true });
		await writeFile(
			legacyPath,
			JSON.stringify({ version: 1, profile: "platform_cn", apiKey: "platform-key" }),
			"utf8",
		);

		const result = await migrateLegacyStepCredential({ nativePath, legacyPath });

		expect(result.migrated).toBe(true);
		expect(await AuthStorage.create(nativePath).read(STEP_PROVIDER_ID)).toMatchObject({
			type: "oauth",
			access: "platform-key",
			profile: "platform_cn",
		});
	});

	test("resolves the canonical auth file at the Step root", () => {
		const env = { STEP_CODING_AGENT_DIR: "/tmp/stepcode-agent" };
		expect(getStepAuthPath(env)).toBe("/tmp/auth.json");
	});

	test("keeps the credential inside the namespace when the agent directory is relative", () => {
		const env = { HOME: "/tmp/step-home", STEP_CODING_AGENT_DIR: "agent" };
		// A textual ".." hop would resolve against the process working directory
		// and write the credential wherever `step` happened to be launched.
		expect(getStepAuthPath(env)).toBe(join(process.cwd(), "auth.json"));
	});

	test("does not inherit a host Pi agent directory when the Step root is implicit", () => {
		const env = {
			HOME: "/tmp/step-home",
			PI_CODING_AGENT_DIR: "/tmp/pi-agent",
		};
		expect(getStepAuthPath(env)).toBe("/tmp/step-home/.stepcode/auth.json");
	});

	test("migrates a pi-shaped credential into the canonical Step path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "step", "auth.json");
		const fallbackPath = join(directory, "pi-auth.json");
		await writeFile(
			fallbackPath,
			JSON.stringify({
				[STEP_PROVIDER_ID]: {
					type: "oauth",
					access: "legacy-access",
					refresh: "legacy-refresh",
					expires: 1,
				},
			}),
		);

		const result = await migrateLegacyStepCredential({
			nativePath: targetPath,
			legacyPath: fallbackPath,
		});

		expect(result.migrated).toBe(true);
		expect(await AuthStorage.create(targetPath).read(STEP_PROVIDER_ID)).toMatchObject({
			type: "oauth",
			access: "legacy-access",
			refresh: "legacy-refresh",
		});
	});

	test("normalizes the old product-owned shape in place", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "auth.json");
		await writeFile(
			targetPath,
			JSON.stringify({
				version: 1,
				profile: "step",
				apiKey: "old-key",
				uid: "account-1",
				obtainedAt: "",
			}),
		);

		const result = await migrateLegacyStepCredential({
			nativePath: targetPath,
			legacyPath: targetPath,
		});

		expect(result.migrated).toBe(true);
		expect(JSON.parse(await readFile(targetPath, "utf8"))).toMatchObject({
			[STEP_PROVIDER_ID]: {
				type: "oauth",
				access: "old-key",
				refresh: STEP_STATIC_REFRESH_TOKEN,
				expires: Number.MAX_SAFE_INTEGER,
				uid: "account-1",
			},
		});
	});

	test("does not migrate when an explicit credential is supplied", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "target.json");
		const fallbackPath = join(directory, "fallback.json");
		await writeFile(fallbackPath, JSON.stringify({ apiKey: "legacy" }));

		const result = await migrateLegacyStepCredential({
			nativePath: targetPath,
			legacyPath: fallbackPath,
			explicitCredential: true,
		});

		expect(result).toMatchObject({
			migrated: false,
			reason: "explicit_credential",
		});
	});

	test("migrates an explicitly supplied legacy home credential", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const legacyPath = join(directory, ".stepcode", "auth.json");
		await mkdir(join(directory, ".stepcode"), { recursive: true });
		await writeFile(legacyPath, JSON.stringify({ apiKey: "legacy-home-key" }));

		// The launcher only reads this path during the one-time migration. Keeping
		// the helper independently testable lets embedded hosts explicitly invoke
		// the same migration without making the normal runtime depend on it.
		expect(getLegacyStepAuthPath({ STEPCODE_LEGACY_AUTH_PATH: legacyPath })).toBe(legacyPath);
		const nativePath = join(directory, ".stepcode", "agent", "auth.json");
		const result = await migrateLegacyStepCredential({ nativePath, legacyPath });

		expect(result).toMatchObject({ migrated: true, nativePath, legacyPath });
		expect(await AuthStorage.create(nativePath).read(STEP_PROVIDER_ID)).toMatchObject({
			type: "oauth",
			access: "legacy-home-key",
		});
	});

	test("logout removes canonical and fallback credentials and reports env precedence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "step", "auth.json");
		const fallbackPath = join(directory, "pi-auth.json");
		await AuthStorage.create(targetPath).modify(STEP_PROVIDER_ID, async () => ({
			type: "oauth",
			access: "access",
			refresh: STEP_STATIC_REFRESH_TOKEN,
			expires: Number.MAX_SAFE_INTEGER,
		}));
		await writeFile(fallbackPath, JSON.stringify({ apiKey: "legacy" }));

		const result = await logoutStepCredentials({
			nativePath: targetPath,
			legacyPath: fallbackPath,
			env: { STEP_API_KEY: "env-key" },
		});

		expect(result).toMatchObject({
			removedNative: true,
			removedLegacy: true,
			remainingSource: "environment",
		});
		expect(await AuthStorage.create(targetPath).read(STEP_PROVIDER_ID)).toBeUndefined();
	});

	test("logout clears the old top-level shape without deleting unrelated fallback auth", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "old-auth.json");
		const fallbackPath = join(directory, "other-auth.json");
		await writeFile(targetPath, JSON.stringify({ version: 1, profile: "step", apiKey: "old-key" }));
		await writeFile(
			fallbackPath,
			JSON.stringify({
				openai: { type: "api_key", key: "unrelated" },
			}),
		);

		const result = await logoutStepCredentials({ nativePath: targetPath, legacyPath: fallbackPath });

		expect(result.removedNative).toBe(true);
		expect(result.removedLegacy).toBe(false);
		expect(await readFile(fallbackPath, "utf8")).toContain("openai");
	});

	test("logout removes only Step from a shared pi auth file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-auth-"));
		temporaryDirectories.push(directory);
		const targetPath = join(directory, "step-auth.json");
		const fallbackPath = join(directory, "shared-auth.json");
		await writeFile(
			fallbackPath,
			JSON.stringify({
				step: { type: "oauth", access: "step-access", refresh: "refresh", expires: 1 },
				openai: { type: "api_key", key: "unrelated" },
			}),
		);

		const result = await logoutStepCredentials({ nativePath: targetPath, legacyPath: fallbackPath });

		expect(result.removedLegacy).toBe(true);
		expect(JSON.parse(await readFile(fallbackPath, "utf8"))).toEqual({
			openai: { type: "api_key", key: "unrelated" },
		});
	});
});
