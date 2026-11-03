/**
 * Remembers which foreign configs the user has already been asked about.
 *
 * What is recorded is the *question*, not the answer: "we showed you Codex's
 * servers". Recording the answer instead would make a decline indistinguishable
 * from never having asked, so either the prompt would return every launch or a
 * user who declined once could never be offered a source that a later release
 * learns to read.
 *
 * It lives in `config.toml` rather than a file of its own. One flag does not
 * justify another entry in `~/.stepcode/`, and the unified config is already the
 * file that answers "what does Step think about MCP here". An earlier build kept
 * it in `mcp-import.json`; that file is read once, folded in, and deleted.
 *
 * The record is advisory. If it cannot be read, the worst case is one extra
 * prompt; if it cannot be written, the worst case is the same. Neither is worth
 * failing a launch over, so every operation degrades quietly.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readGlobalStepConfig, updateGlobalStepConfig } from "./config-toml.ts";
import { resolveStepConfigRoot } from "./environment.ts";
import { isStepMcpImportSource, type StepMcpImportSource } from "./mcp-import.ts";

/** Config table holding the record. */
export const STEP_MCP_IMPORT_CONFIG_KEY = "mcp_import";

/** Pre-config.toml location, read for migration and then removed. */
const LEGACY_STATE_FILE_NAME = "mcp-import.json";

export interface StepMcpImportState {
	readonly reviewedSources: readonly StepMcpImportSource[];
}

function legacyStatePath(env: NodeJS.ProcessEnv): string {
	return join(resolveStepConfigRoot(env), LEGACY_STATE_FILE_NAME);
}

function readSources(value: unknown): StepMcpImportSource[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is StepMcpImportSource => typeof entry === "string" && isStepMcpImportSource(entry),
	);
}

/** Reads the legacy JSON file's `reviewedSources` keys, or nothing. */
function readLegacyState(env: NodeJS.ProcessEnv): StepMcpImportSource[] {
	const path = legacyStatePath(env);
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const raw = (parsed as { reviewedSources?: unknown }).reviewedSources;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
		return readSources(Object.keys(raw as Record<string, unknown>));
	} catch {
		return [];
	}
}

/** Reads the record; anything unreadable or malformed reads as "nothing reviewed". */
export function readStepMcpImportState(env: NodeJS.ProcessEnv = process.env): StepMcpImportState {
	let fromConfig: StepMcpImportSource[] = [];
	try {
		const table = readGlobalStepConfig(env)[STEP_MCP_IMPORT_CONFIG_KEY];
		if (typeof table === "object" && table !== null && !Array.isArray(table)) {
			fromConfig = readSources((table as { reviewed?: unknown }).reviewed);
		}
	} catch {
		// An unreadable config costs one extra prompt, not a failed launch.
	}
	const merged = new Set<StepMcpImportSource>([...fromConfig, ...readLegacyState(env)]);
	return { reviewedSources: [...merged] };
}

export function hasReviewedStepMcpImportSource(state: StepMcpImportState, source: StepMcpImportSource): boolean {
	return state.reviewedSources.includes(source);
}

/**
 * Marks sources as offered, and retires the legacy file if one is still around.
 *
 * Merges rather than replaces: two Step processes racing on first launch would
 * otherwise have the loser erase the winner's record, and the user would be
 * asked about that source again.
 */
export function markStepMcpImportSourcesReviewed(
	sources: readonly StepMcpImportSource[],
	env: NodeJS.ProcessEnv = process.env,
): StepMcpImportState {
	const merged = new Set<StepMcpImportSource>([...readStepMcpImportState(env).reviewedSources, ...sources]);
	const reviewed = [...merged];

	try {
		updateGlobalStepConfig(env, (document) => ({
			...document,
			[STEP_MCP_IMPORT_CONFIG_KEY]: { reviewed },
		}));
		// Only after the new home holds the record: losing both would re-prompt.
		rmSync(legacyStatePath(env), { force: true });
	} catch {
		// Not being able to remember costs one extra prompt next launch.
	}
	return { reviewedSources: reviewed };
}
