/**
 * File changes per conversation turn.
 *
 * `edit` and `write` record a unified patch in their tool result
 * (`details.patch`, LF without BOM); `write` also records the overwritten
 * file's line ending and BOM, or why it recorded no patch. The client derives
 * each turn's change card from the same details.
 *
 * A turn is the run of entries from one user message to the next. Reverting a
 * turn reverse-applies its own patches, newest first, and writes nothing unless
 * every patch still applies. Changes without a patch (large or binary files,
 * `bash`) cannot be reverted and are reported as skipped. A revert is recorded
 * as a custom message on the branch, which also tells the model.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import {
	detectLineEnding,
	normalizeToLF,
	resolveToCwd,
	restoreLineEndings,
	type SessionEntry,
	type WriteToolDetails,
} from "@step-harness/coding-agent";

function toolPath(input: Readonly<Record<string, unknown>>): string | undefined {
	const value = input.path ?? input.file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Why a revert was refused; `path` is the file as the tool call named it. */
export type TurnRevertCode = "busy" | "reverted" | "empty" | "missing" | "conflict";

export class TurnRevertError extends Error {
	readonly code: TurnRevertCode;
	readonly path?: string;

	constructor(code: TurnRevertCode, message: string, path?: string) {
		super(message);
		this.code = code;
		this.path = path;
	}
}

/* ── Patches ─────────────────────────────────────────────────────────────── */

interface Hunk {
	readonly newStart: number;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
	/** The last line of that side has no trailing newline ("\ No newline at end of file"). */
	readonly oldNoEol: boolean;
	readonly newNoEol: boolean;
	/** Unchanged lines at the start and at the end of the hunk. */
	readonly leading: number;
	readonly trailing: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string): Hunk[] {
	const lines = patch.split("\n");
	const hunks: Hunk[] = [];
	let index = 0;
	while (index < lines.length) {
		const header = HUNK_HEADER.exec(lines[index] ?? "");
		index += 1;
		if (!header) continue;
		let oldCount = header[2] === undefined ? 1 : Number(header[2]);
		let newCount = header[4] === undefined ? 1 : Number(header[4]);
		const oldLines: string[] = [];
		const newLines: string[] = [];
		let oldNoEol = false;
		let newNoEol = false;
		let last: " " | "-" | "+" | undefined;
		let leading = 0;
		let trailing = 0;
		while (index < lines.length && (oldCount > 0 || newCount > 0 || lines[index]?.startsWith("\\"))) {
			const line = lines[index] ?? "";
			index += 1;
			const marker = line[0];
			if (marker === "\\") {
				if (last === "-" || last === " ") oldNoEol = true;
				if (last === "+" || last === " ") newNoEol = true;
				continue;
			}
			const text = line.slice(1);
			if (marker === " ") {
				if (last === undefined || (last === " " && trailing === leading)) leading += 1;
				trailing += 1;
			} else trailing = 0;
			if (marker === "-") {
				oldLines.push(text);
				oldCount -= 1;
				last = "-";
			} else if (marker === "+") {
				newLines.push(text);
				newCount -= 1;
				last = "+";
			} else {
				oldLines.push(text);
				newLines.push(text);
				oldCount -= 1;
				newCount -= 1;
				last = " ";
			}
		}
		hunks.push({ newStart: Number(header[3]), oldLines, newLines, oldNoEol, newNoEol, leading, trailing });
	}
	return hunks;
}

/** Where `block` sits in `lines` within [0, limit), nearest to `center` first; -1 when absent. */
function locate(lines: readonly string[], block: readonly string[], center: number, limit: number): number {
	const last = limit - block.length;
	const fits = (start: number) => block.every((line, offset) => lines[start + offset] === line);
	for (let distance = 0; center - distance >= 0 || center + distance <= last; distance += 1) {
		if (center - distance >= 0 && center - distance <= last && fits(center - distance)) return center - distance;
		if (distance && center + distance >= 0 && center + distance <= last && fits(center + distance))
			return center + distance;
	}
	return -1;
}

/** `hunk` without up to `fuzz` unchanged lines at each end (GNU patch's fuzz factor). */
function trimmed(hunk: Hunk, fuzz: number): Hunk {
	const head = Math.min(fuzz, hunk.leading);
	// A hunk of context only (never produced by jsdiff) keeps its lines.
	const tail = Math.min(fuzz, hunk.trailing, hunk.oldLines.length - head, hunk.newLines.length - head);
	return {
		...hunk,
		newStart: hunk.newStart + head,
		oldLines: hunk.oldLines.slice(head, hunk.oldLines.length - tail),
		newLines: hunk.newLines.slice(head, hunk.newLines.length - tail),
		leading: hunk.leading - head,
		trailing: hunk.trailing - tail,
	};
}

/**
 * Undo `patch` on `content` (LF line endings). Like `patch -R`, a hunk may
 * have moved because later edits added or removed lines elsewhere, and its
 * unchanged context lines may have been edited since; the lines the patch
 * itself changed must still be there, or this throws.
 */
export function reversePatch(content: string, patch: string): string {
	const lines = content.split("\n");
	const hunks = parseHunks(patch);
	let limit = lines.length;
	// How far the hunks below have moved; the next one up is searched around the same shift.
	let shift = 0;
	for (const original of [...hunks].reverse()) {
		let hunk = original;
		let start = -1;
		for (let fuzz = 0; fuzz <= Math.max(original.leading, original.trailing); fuzz += 1) {
			hunk = trimmed(original, fuzz);
			const expected = (hunk.newLines.length ? hunk.newStart - 1 : hunk.newStart) + shift;
			start = hunk.newLines.length ? locate(lines, hunk.newLines, expected, limit) : Math.min(expected, limit);
			if (start >= 0) break;
		}
		if (start < 0) throw new Error("content changed since the patch");
		shift = start - (hunk.newLines.length ? hunk.newStart - 1 : hunk.newStart);
		lines.splice(start, hunk.newLines.length, ...hunk.oldLines);
		const after = start + hunk.oldLines.length;
		// Only the trailing newline differs between the two sides of the last line.
		if (hunk.oldNoEol && !hunk.newNoEol && lines[after] === "" && after === lines.length - 1) lines.pop();
		if (hunk.newNoEol && !hunk.oldNoEol && after === lines.length) lines.push("");
		limit = start;
	}
	return lines.join("\n");
}

/* ── Turns ───────────────────────────────────────────────────────────────── */

type LineEnding = "\r\n" | "\n";

export interface TurnChange {
	readonly toolCallId: string;
	readonly path: string;
	readonly patch: string;
	readonly created: boolean;
	/** Line ending and BOM of the file a `write` replaced. */
	readonly previous?: { readonly lineEnding: LineEnding; readonly bom: boolean };
}

/** A successful edit/write with no patch to reverse. */
export interface SkippedChange {
	readonly path: string;
	readonly reason: NonNullable<WriteToolDetails["untracked"]> | "unknown";
}

export interface TurnChangeSet {
	readonly changes: readonly TurnChange[];
	readonly skipped: readonly SkippedChange[];
}

function isUserMessage(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "user";
}

/** `customType` of the entry that records a reverted turn (and tells the model about it). */
export const TURN_REVERT_TYPE = "stepcode-web.turn-revert";

/** User entry ids of the turns reverted on this branch. */
export function revertedTurnIds(entries: readonly SessionEntry[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== TURN_REVERT_TYPE) continue;
		const turnId = (entry.details as { turnId?: unknown } | undefined)?.turnId;
		if (typeof turnId === "string") ids.push(turnId);
	}
	return ids;
}

/** What the model is told after a revert: which request's edits are gone and which files to re-read. */
export function turnRevertNotice(
	entries: readonly SessionEntry[],
	turnId: string,
	changes: readonly TurnChange[],
): string {
	const entry = entries.find((candidate) => candidate.id === turnId);
	const content = entry?.type === "message" ? (entry.message as { content?: unknown }).content : undefined;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part: { type?: string; text?: string }) => (part?.type === "text" ? (part.text ?? "") : ""))
						.join("")
				: "";
	const request = text.replace(/\s+/g, " ").trim();
	const files = [...new Set(changes.map((change) => change.path))];
	return [
		`The user reverted the file changes you made while answering this earlier request: "${request.length > 200 ? `${request.slice(0, 199)}…` : request}".`,
		`These files are back to their content from before that request: ${files.join(", ")}.`,
		"Treat those edits as undone and re-read the files before changing them again.",
	].join("\n");
}

/** Successful edit/write calls of the turn that starts at the user entry `turnId`, in order. */
export function turnChanges(entries: readonly SessionEntry[], turnId: string): TurnChangeSet {
	const start = entries.findIndex((entry) => entry.id === turnId && isUserMessage(entry));
	const changes: TurnChange[] = [];
	const skipped: SkippedChange[] = [];
	if (start < 0) return { changes, skipped };
	const calls = new Map<string, { name: string; path?: string }>();
	for (const entry of entries.slice(start + 1)) {
		if (isUserMessage(entry)) break;
		if (entry.type !== "message" || entry.imported) continue;
		const message = entry.message as {
			role: string;
			content?: unknown;
			toolCallId?: string;
			isError?: boolean;
			details?: unknown;
		};
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Array<Record<string, unknown>>) {
				if (part?.type !== "toolCall") continue;
				const args = (part.arguments ?? {}) as Record<string, unknown>;
				calls.set(String(part.id), { name: String(part.name ?? ""), path: toolPath(args) });
			}
		}
		if (message.role !== "toolResult" || message.isError || !message.toolCallId) continue;
		const call = calls.get(message.toolCallId);
		if (!call?.path || (call.name !== "edit" && call.name !== "write")) continue;
		const details = (message.details ?? {}) as WriteToolDetails;
		if (typeof details.patch !== "string") {
			skipped.push({ path: call.path, reason: details.untracked ?? "unknown" });
			continue;
		}
		const write = call.name === "write";
		changes.push({
			toolCallId: message.toolCallId,
			path: call.path,
			patch: details.patch,
			created: write && details.created === true,
			...(write && details.previous ? { previous: details.previous } : {}),
		});
	}
	return { changes, skipped };
}

interface RevertFile {
	/** LF, without BOM: the view the patches were made against. */
	content: string;
	lineEnding: LineEnding;
	bom: boolean;
	deleted: boolean;
}

/**
 * Reverse-apply a turn's changes. Every file is computed first; nothing is
 * written unless all patches apply. Returns the absolute paths touched.
 */
export async function revertTurnChanges(changes: readonly TurnChange[], cwd: string): Promise<string[]> {
	if (!changes.length) throw new TurnRevertError("empty", "This turn has no file changes that can be reverted");
	const files = new Map<string, RevertFile>();
	for (const change of [...changes].reverse()) {
		const absolute = resolveToCwd(change.path, cwd);
		const conflict = () => new TurnRevertError("conflict", `${change.path} changed since this turn`, change.path);
		let file = files.get(absolute);
		if (!file) {
			let raw: string;
			try {
				raw = await readFile(absolute, "utf8");
			} catch {
				throw new TurnRevertError("missing", `${change.path} no longer exists`, change.path);
			}
			const bom = raw.startsWith("﻿");
			const text = bom ? raw.slice(1) : raw;
			file = { content: normalizeToLF(text), lineEnding: detectLineEnding(text), bom, deleted: false };
			files.set(absolute, file);
		}
		if (file.deleted) throw conflict();
		try {
			file.content = reversePatch(file.content, change.patch);
		} catch {
			throw conflict();
		}
		if (change.created) {
			if (file.content !== "") throw conflict();
			file.deleted = true;
		} else if (change.previous) {
			// A write replaced the whole file, line endings and BOM included.
			file.lineEnding = change.previous.lineEnding;
			file.bom = change.previous.bom;
		}
	}
	for (const [absolute, file] of files) {
		if (file.deleted) {
			await unlink(absolute);
			continue;
		}
		const text = restoreLineEndings(file.content, file.lineEnding);
		await writeFile(absolute, file.bom ? `﻿${text}` : text, "utf8");
	}
	return [...files.keys()];
}

/**
 * The lock around reverting one session's turns. Checks and writes are
 * asynchronous, so without it a second request (double click, another tab)
 * passes the checks while the first is still writing files. Which turns are
 * reverted is read from the branch (`revertedTurnIds`).
 */
export class TurnReverter {
	private busy = false;

	/** A revert is writing files or recording its turn. */
	isBusy(): boolean {
		return this.busy;
	}

	/** Revert the turn `turnId`; `record` appends the revert entry once the files are written. */
	async revert(
		turnId: string,
		entries: readonly SessionEntry[],
		cwd: string,
		record: (turnId: string, changes: readonly TurnChange[], paths: readonly string[]) => Promise<void>,
	): Promise<{ paths: string[]; skipped: readonly SkippedChange[] }> {
		if (this.busy) throw new TurnRevertError("busy", "This session is already reverting a turn");
		if (revertedTurnIds(entries).includes(turnId))
			throw new TurnRevertError("reverted", "This turn was already reverted");
		this.busy = true;
		try {
			const { changes, skipped } = turnChanges(entries, turnId);
			const paths = await revertTurnChanges(changes, cwd);
			await record(turnId, changes, paths);
			return { paths, skipped };
		} finally {
			this.busy = false;
		}
	}
}
