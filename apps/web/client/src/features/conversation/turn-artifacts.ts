import { type ArtifactKind, artifactKind, workspaceFilePath, workspaceFileReference } from "../../lib/file-references";
import { basename } from "../../lib/format";
import { markdownFileReferences } from "../../lib/markdown";
import type { ChangedFile, TurnChanges } from "../../lib/turn-changes";
import type { TimelineItem } from "../../state/types";
import type { TurnFooter } from "./turn-footers";

export interface TurnArtifact {
	readonly path: string;
	readonly label: string;
	readonly kind: ArtifactKind;
	/** The turn that delivered it: its page renders as this turn left the file. */
	readonly turnId: string;
	/**
	 * This turn's recorded change of the file (the same entry its "Edited N files" card lists), so the
	 * delivery can open that turn's diff. Absent when the turn only referenced the file.
	 */
	readonly change?: { readonly turnId: string; readonly file: ChangedFile };
}

// Streaming updates regroup history; unchanged settled turns must not reparse Markdown each frame.
// One entry per turn, so a long conversation does not evict its own turns on every update.
const artifactCache = new Map<string, { readonly signature: string; readonly artifacts: readonly TurnArtifact[] }>();
const ARTIFACT_CACHE_TURNS = 512;

/** Recognize references and observed outputs, not a durable or filesystem-verified registry. */
export function turnArtifacts(
	items: readonly TimelineItem[],
	footer: TurnFooter,
	cwd: string,
): readonly TurnArtifact[] {
	// The turn's user message sits just before its rows; scanning back keeps every turn O(its length).
	let start = footer.lastIndex;
	while (start > 0 && !opensTurn(items[start], footer.turnId)) start--;
	const outputs = new Map<string, string>();
	const windows = /^[a-z]:[\\/]/i.test(cwd);
	const keyOf = (path: string) => (windows ? path.toLowerCase() : path);
	for (let index = Math.max(0, start); index <= footer.lastIndex; index++) {
		const item = items[index];
		if (item.kind !== "tool" || item.state !== "completed" || item.imported) continue;
		if (!["edit", "write", "edit_file", "write_file", "apply_patch"].includes(item.toolName)) continue;
		const raw = item.change?.path ?? item.args?.path;
		const path = raw ? workspaceFilePath(cwd, raw) : undefined;
		if (path && artifactKind(path) !== "file" && outputs.size < 64) outputs.set(keyOf(path), path);
	}
	const found = new Map<string, TurnArtifact>();
	const add = (path: string, label: string) => {
		if (found.size >= 12 || artifactKind(path) === "file" || found.has(keyOf(path))) return;
		found.set(keyOf(path), {
			path,
			label: label.slice(0, 160) || basename(path),
			kind: artifactKind(path),
			turnId: footer.turnId,
		});
	};
	const text = footer.messages
		.filter((message) => !message.error)
		.map((message) => message.content)
		.join("\n\n");
	const cacheKey = `${cwd}\u0000${footer.turnId}`;
	const signature = `${text}\u0000${[...outputs.values()].join("\u0000")}`;
	const cached = artifactCache.get(cacheKey);
	if (cached?.signature === signature) return cached.artifacts;
	for (const reference of markdownFileReferences(text)) {
		let path = workspaceFileReference(cwd, reference.path);
		if (!path) continue;
		if (reference.inlineCode) {
			const referenceKey = keyOf(path);
			const exact = outputs.get(keyOf(path));
			const matches = path.includes("/")
				? []
				: [...outputs.values()].filter((output) => keyOf(basename(output)) === referenceKey);
			// Bare code-styled filenames alone do not prove that a file was delivered.
			path = path.includes("/") ? exact : matches.length === 1 ? matches[0] : undefined;
			if (!path) continue;
		}
		add(path, reference.inlineCode ? basename(path) : reference.label);
	}
	for (const path of outputs.values()) add(path, basename(path));
	const result = [...found.values()];
	artifactCache.delete(cacheKey);
	if (artifactCache.size >= ARTIFACT_CACHE_TURNS) {
		const oldest = artifactCache.keys().next().value;
		if (oldest !== undefined) artifactCache.delete(oldest);
	}
	artifactCache.set(cacheKey, { signature, artifacts: result });
	return result;
}

function opensTurn(item: TimelineItem, turnId: string): boolean {
	return item.kind === "message" && item.role === "user" && (item.entryId ?? item.itemId) === turnId;
}

/**
 * Attach the turn's own change records to its deliveries. Both sides name the file relative to the
 * workspace, but changes keep the tool's spelling (a backslash, a leading `./`), so they meet on the
 * same normalized key the recognition uses. Unchanged artifacts keep their object.
 */
export function withTurnChanges(
	artifacts: readonly TurnArtifact[],
	turn: TurnChanges | undefined,
	cwd: string,
): readonly TurnArtifact[] {
	if (!turn || !artifacts.length) return artifacts;
	// Both inputs keep their identity while the turn is unchanged (see their caches), so the result can too.
	const cached = attachedCache.get(artifacts);
	if (cached?.turn === turn && cached.cwd === cwd) return cached.result;
	const result = attachChanges(artifacts, turn, cwd);
	attachedCache.set(artifacts, { turn, cwd, result });
	return result;
}

const attachedCache = new WeakMap<
	readonly TurnArtifact[],
	{ readonly turn: TurnChanges; readonly cwd: string; readonly result: readonly TurnArtifact[] }
>();

function attachChanges(artifacts: readonly TurnArtifact[], turn: TurnChanges, cwd: string): readonly TurnArtifact[] {
	const windows = /^[a-z]:[\\/]/i.test(cwd);
	const keyOf = (path: string) => (windows ? path.toLowerCase() : path);
	const changed = new Map<string, ChangedFile>();
	for (const file of turn.files) {
		const path = workspaceFilePath(cwd, file.path) ?? file.path.replace(/\\/g, "/");
		changed.set(keyOf(path), file);
	}
	let attached = false;
	const result = artifacts.map((artifact) => {
		const file = changed.get(keyOf(artifact.path));
		if (!file) return artifact;
		attached = true;
		return { ...artifact, change: { turnId: turn.turnId, file } };
	});
	return attached ? result : artifacts;
}
