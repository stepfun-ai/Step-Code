/**
 * Step-only credential compatibility helpers.
 *
 * Pi stores credentials under `<agentDir>/auth.json`. StepCode stores its
 * provider credential at the top-level `~/.stepcode/auth.json`; credentials written by the retired
 * namespace remain migration fallbacks.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { Credential } from "@step-harness/providers";
import { AuthStorage, readStoredCredential } from "../core/auth-storage.ts";
import { STEP_PROVIDER_ID, STEP_STATIC_REFRESH_TOKEN } from "../features/step-provider/index.ts";
import { LEGACY_RENAMED_CONFIG_DIR, resolveStepConfigRoot, resolveStepHomeDir } from "./environment.ts";

/** Current Pi-shaped credential path under the StepCode agent directory. */
export function getStepAuthPath(env: Record<string, string | undefined> = process.env): string {
	return env.STEPCODE_AUTH_PATH?.trim() || join(resolveStepConfigRoot(env), "auth.json");
}

/** Old product-owned credential path, used only as a migration fallback. */
export function getLegacyStepAuthPath(env: Record<string, string | undefined> = process.env): string {
	const candidates = getLegacyStepAuthPaths(env);
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** All historical locations used before this layout. */
export function getLegacyStepAuthPaths(env: Record<string, string | undefined> = process.env): string[] {
	const explicit = env.STEPCODE_LEGACY_AUTH_PATH?.trim();
	if (explicit) return [explicit];
	const home = resolveStepHomeDir(env);
	const canonicalRoot = join(home, ".stepcode");
	const retiredRoot = join(home, LEGACY_RENAMED_CONFIG_DIR);
	// Keep the canonical root-level file first: this is the old pre-Pi StepCode
	// credential shape that needs in-place normalization. The remaining paths
	// cover Pi-shaped files created by the previous release.
	return [
		join(canonicalRoot, "auth.json"),
		join(retiredRoot, "agent", "auth.json"),
		join(retiredRoot, "auth.json"),
		join(canonicalRoot, "legacy-auth.json"),
	];
}

export interface StepAuthPathOptions {
	/** Target auth path. Defaults to StepCode's Pi-shaped agent auth file. */
	nativePath?: string;
	/** Fallback auth path. Defaults to the active coding-agent path. */
	legacyPath?: string;
}

export interface StepAuthMigrationResult {
	migrated: boolean;
	legacyPath: string;
	nativePath: string;
	/** A non-secret reason when migration was intentionally skipped. */
	reason?: "same_path" | "explicit_credential" | "native_credential" | "missing" | "invalid";
}

/**
 * Import an old Step credential into pi's canonical OAuth shape.
 *
 * Migration is deliberately best effort. A broken legacy file must not stop a
 * normal launch, and an explicit environment/CLI key always wins over a file.
 */
export async function migrateLegacyStepCredential(
	options: StepAuthPathOptions & {
		explicitCredential?: boolean;
	} = {},
): Promise<StepAuthMigrationResult> {
	const nativePath = normalize(options.nativePath ?? getStepAuthPath());
	const legacyPath = normalize(options.legacyPath ?? getLegacyStepAuthPath());
	const base = { nativePath, legacyPath };

	// Do not let a legacy file overwrite a credential created by pi or a prior
	// migration. `readStoredCredential` is intentionally tolerant of a missing
	// file, while an existing malformed native file is left untouched below.
	if (readStoredCredential(STEP_PROVIDER_ID, nativePath)) {
		return { ...base, migrated: false, reason: "native_credential" };
	}

	// A previous Step launch may have written its product-owned `{ apiKey, ... }`
	// object at the canonical path. Normalize it in place before pi reads the
	// file; otherwise the provider entry would be invisible to AuthStorage.
	const targetLegacy = await readLegacyStepCredential(nativePath);
	if (targetLegacy !== undefined) {
		try {
			await writeCanonicalCredentialFile(nativePath, targetLegacy);
			return { ...base, migrated: true };
		} catch {
			return { ...base, migrated: false, reason: "invalid" };
		}
	}

	if (options.explicitCredential) return { ...base, migrated: false, reason: "explicit_credential" };

	if (nativePath === legacyPath) return { ...base, migrated: false, reason: "same_path" };

	const legacy = await readLegacyStepCredential(legacyPath);
	if (legacy === undefined) {
		return {
			...base,
			migrated: false,
			reason: existsSync(legacyPath) ? "invalid" : "missing",
		};
	}

	try {
		const storage = AuthStorage.create(nativePath);
		await storage.modify(STEP_PROVIDER_ID, async (current) => {
			// A concurrent process may have logged in after the initial read. Keep
			// that newer credential instead of replacing it with the legacy value.
			if (current) return undefined;
			return canonicalCredential(legacy);
		});
		return { ...base, migrated: true };
	} catch {
		// AuthStorage validates and locks its file. A malformed or read-only native
		// store should remain visible to pi so it can report the real problem.
		return { ...base, migrated: false, reason: "invalid" };
	}
}

export interface StepLogoutResult {
	removedNative: boolean;
	removedLegacy: boolean;
	nativePath: string;
	legacyPath: string;
	remainingSource: "environment" | null;
}

/** Remove Step credentials from both the native and legacy stores. */
export async function logoutStepCredentials(
	options: StepAuthPathOptions & {
		env?: Record<string, string | undefined>;
	} = {},
): Promise<StepLogoutResult> {
	const nativePath = normalize(options.nativePath ?? getStepAuthPath());
	const legacyPath = normalize(options.legacyPath ?? getLegacyStepAuthPath());
	let removedNative = false;
	let removedLegacy = false;

	if (nativePath === legacyPath) {
		// In a custom setup the paths can intentionally converge. Delete only the
		// provider entry so other providers in the shared auth file survive.
		if (readStoredCredential(STEP_PROVIDER_ID, nativePath)) {
			await AuthStorage.create(nativePath).delete(STEP_PROVIDER_ID);
			removedNative = true;
		} else if (await readLegacyStepCredential(nativePath)) {
			// The old product-owned file has no provider map, so removing it is the
			// only way to clear that credential shape.
			await rm(nativePath, { force: true });
			removedNative = true;
		}
	} else {
		if (readStoredCredential(STEP_PROVIDER_ID, nativePath)) {
			await AuthStorage.create(nativePath).delete(STEP_PROVIDER_ID);
			removedNative = true;
		} else if (await readLegacyStepCredential(nativePath)) {
			await rm(nativePath, { force: true });
			removedNative = true;
		}
		if (readStoredCredential(STEP_PROVIDER_ID, legacyPath)) {
			// A pi auth file can contain credentials for several providers; remove
			// only Step's entry rather than deleting the shared file.
			await AuthStorage.create(legacyPath).delete(STEP_PROVIDER_ID);
			removedLegacy = true;
		} else if (await readLegacyStepCredential(legacyPath)) {
			await rm(legacyPath, { force: true });
			removedLegacy = true;
		}
	}

	const env = options.env ?? process.env;
	return {
		removedNative,
		removedLegacy,
		nativePath,
		legacyPath,
		remainingSource: env.STEP_API_KEY?.trim() ? "environment" : null,
	};
}

interface LegacyStepCredential {
	apiKey: string;
	profile?: string;
	uid?: string;
	refresh?: string;
	expires?: number;
}

async function readLegacyStepCredential(filePath: string): Promise<LegacyStepCredential | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	const topLevelKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
	if (topLevelKey && topLevelKey !== "<your_api_key>") {
		const uid = typeof record.uid === "string" && record.uid.trim() ? record.uid.trim() : undefined;
		const profile = typeof record.profile === "string" && record.profile.trim() ? record.profile.trim() : undefined;
		return { apiKey: topLevelKey, ...(profile ? { profile } : undefined), ...(uid ? { uid } : undefined) };
	}

	// Also accept a pi-shaped credential from an interrupted/experimental Step
	// launch. This is the fallback format we migrate into the canonical path.
	const stored = record[STEP_PROVIDER_ID];
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
	const credential = stored as Record<string, unknown>;
	const apiKey =
		typeof credential.access === "string"
			? credential.access.trim()
			: typeof credential.key === "string"
				? credential.key.trim()
				: "";
	if (!apiKey || apiKey === "<your_api_key>") return undefined;
	const uid = typeof credential.uid === "string" && credential.uid.trim() ? credential.uid.trim() : undefined;
	const profile =
		typeof credential.profile === "string" && credential.profile.trim() ? credential.profile.trim() : undefined;
	const refresh =
		typeof credential.refresh === "string" && credential.refresh.trim() ? credential.refresh.trim() : undefined;
	const expires =
		typeof credential.expires === "number" && Number.isFinite(credential.expires) ? credential.expires : undefined;
	return {
		apiKey,
		...(profile ? { profile } : undefined),
		...(uid ? { uid } : undefined),
		...(refresh ? { refresh } : undefined),
		...(expires ? { expires } : undefined),
	};
}

function canonicalCredential(legacy: LegacyStepCredential): Credential {
	return {
		type: "oauth",
		access: legacy.apiKey,
		refresh: legacy.refresh ?? STEP_STATIC_REFRESH_TOKEN,
		expires: legacy.expires ?? Number.MAX_SAFE_INTEGER,
		...(legacy.profile ? { profile: legacy.profile } : undefined),
		...(legacy.uid ? { uid: legacy.uid } : undefined),
	};
}

async function writeCanonicalCredentialFile(filePath: string, legacy: LegacyStepCredential): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, JSON.stringify({ [STEP_PROVIDER_ID]: canonicalCredential(legacy) }, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmod(filePath, 0o600);
}
