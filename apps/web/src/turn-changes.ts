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
 * every patch still applies. Changes without a patch (large or binary files)
 * cannot be reverted and are reported as skipped; what a `bash` command changed
 * is not recorded at all, so a file a command rewrote no longer matches and is
 * left as it is. A revert is recorded as a custom message on the branch, which
 * also tells the model.
 */

import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import {
	detectLineEnding,
	normalizeToLF,
	resolveToCwd,
	restoreLineEndings,
	type SessionEntry,
	type WriteToolDetails,
} from "@step-harness/coding-agent";

/**
 * File-changing tools: the built-in names and the Step tool profile's, which
 * Web sessions use. Step's `edit_file` records the same patch as `edit`; its
 * `write_file` records none (skipped) and `changed: false` for a no-op.
 */
const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "edit_file", "write_file"]);

function toolPath(input: Readonly<Record<string, unknown>>): string | undefined {
	const value = input.path ?? input.file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Why a revert was refused; `path` is the file as the tool call named it.
 * `modified` means the file no longer matches the turn's patches and nothing
 * recorded explains it (a `bash` command, an outside edit); `conflict` means
 * undoing the later turns that changed it first was checked to let this turn
 * undo. Neither writes anything.
 */
export type TurnRevertCode = "busy" | "reverted" | "empty" | "missing" | "conflict" | "modified";

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
		if (entry.type !== "message") continue;
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
		if (!call?.path || !FILE_CHANGE_TOOLS.has(call.name)) continue;
		const details = (message.details ?? {}) as WriteToolDetails & { changed?: unknown };
		// Step's write_file left a file that already held the content untouched.
		if (details.changed === false) continue;
		if (typeof details.patch !== "string") {
			skipped.push({ path: call.path, reason: details.untracked ?? "unknown" });
			continue;
		}
		const write = call.name === "write" || call.name === "write_file";
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
	/** The path the revert reads and writes: the first one a change named it by. */
	absolute: string;
	/** LF, without BOM: the view the patches were made against. */
	content: string;
	lineEnding: LineEnding;
	bom: boolean;
	deleted: boolean;
}

/**
 * The same file however a path names it: `a.txt` and `A.txt` on a
 * case-insensitive disk, a symlink and its target. Two paths that would be
 * planned separately overwrite each other's result. A path that does not
 * exist keys as itself; the revert refuses it as `missing`.
 */
async function fileKey(absolute: string): Promise<string> {
	try {
		const { dev, ino } = await stat(absolute, { bigint: true });
		return `${dev}:${ino}`;
	} catch {
		return absolute;
	}
}

/** A file's text as a revert sees it; `undefined` when it cannot be read. */
type ReadText = (absolute: string, key: string) => Promise<string | undefined>;

async function readCurrent(absolute: string): Promise<string | undefined> {
	try {
		return await readFile(absolute, "utf8");
	} catch {
		// Unreadable counts as gone: the revert refuses it as `missing` and writes nothing.
		return undefined;
	}
}

/** The text a planned file is written back as. */
function revertedText(file: RevertFile): string {
	const text = restoreLineEndings(file.content, file.lineEnding);
	return file.bom ? `\uFEFF${text}` : text;
}

/**
 * What reverting `changes` would leave, file by file, read through `read`;
 * nothing is written. Throws `modified` when a file no longer matches the
 * patches and `missing` when one is gone. A file is deleted only when
 * reversing reaches the `write` that created it with nothing left, and the
 * turn has no unpatched change to the same path: `created` says the file was
 * absent before that one write, and an unrecorded change to the path leaves
 * open what was there before the turn. Files are keyed by `fileKey`.
 */
async function planRevert(
	changes: readonly TurnChange[],
	skipped: readonly SkippedChange[],
	cwd: string,
	read: ReadText,
): Promise<Map<string, RevertFile>> {
	if (!changes.length) throw new TurnRevertError("empty", "This turn has no file changes that can be reverted");
	const unpatched = new Set(await Promise.all(skipped.map((change) => fileKey(resolveToCwd(change.path, cwd)))));
	const files = new Map<string, RevertFile>();
	for (const change of [...changes].reverse()) {
		const absolute = resolveToCwd(change.path, cwd);
		const key = await fileKey(absolute);
		const mismatch = () =>
			new TurnRevertError("modified", `${change.path} no longer matches this turn's changes`, change.path);
		let file = files.get(key);
		if (!file) {
			const raw = await read(absolute, key);
			if (raw === undefined) throw new TurnRevertError("missing", `${change.path} no longer exists`, change.path);
			const bom = raw.startsWith("\uFEFF");
			const text = bom ? raw.slice(1) : raw;
			file = { absolute, content: normalizeToLF(text), lineEnding: detectLineEnding(text), bom, deleted: false };
			files.set(key, file);
		}
		// A change from before the file was recreated: what it held in between was not recorded.
		if (file.deleted) throw mismatch();
		try {
			file.content = reversePatch(file.content, change.patch);
		} catch {
			throw mismatch();
		}
		if (change.created) {
			if (file.content !== "" || unpatched.has(key)) throw mismatch();
			file.deleted = true;
		} else if (change.previous) {
			// A write replaced the whole file, line endings and BOM included.
			file.lineEnding = change.previous.lineEnding;
			file.bom = change.previous.bom;
		}
	}
	return files;
}

/**
 * Reverse-apply a turn's changes. Every file is computed first, and a refusal
 * (`TurnRevertError`) writes nothing. A failure while writing is passed on
 * unchanged; files written before it stay written. Returns the absolute paths
 * touched.
 */
export async function revertTurnChanges(
	changes: readonly TurnChange[],
	cwd: string,
	skipped: readonly SkippedChange[] = [],
): Promise<string[]> {
	const files = [...(await planRevert(changes, skipped, cwd, readCurrent)).values()];
	for (const file of files) {
		if (file.deleted) await unlink(file.absolute);
		else await writeFile(file.absolute, revertedText(file), "utf8");
	}
	return files.map((file) => file.absolute);
}

/**
 * Whether undoing later turns first would let the turn `turnId` undo. The
 * later turns not yet reverted that this turn's files depend on are those that
 * changed one of its files, then those that changed one of theirs, and so on;
 * one of them must have recorded a patch to `blocked`. Reverting them newest
 * first, each as a whole, then this turn must succeed on the files as they are
 * now. Simulated in memory; nothing is written, and the real reverts check
 * everything again.
 */
async function laterTurnsUnblock(
	entries: readonly SessionEntry[],
	turnId: string,
	turn: TurnChangeSet,
	/** `fileKey` of the file that blocked this turn's revert. */
	blocked: string,
	cwd: string,
): Promise<boolean> {
	const start = entries.findIndex((entry) => entry.id === turnId && isUserMessage(entry));
	const reverted = new Set(revertedTurnIds(entries));
	const keysOf = (set: TurnChangeSet) =>
		Promise.all(set.changes.map((change) => fileKey(resolveToCwd(change.path, cwd))));
	const candidates = await Promise.all(
		entries
			.slice(start + 1)
			.filter((entry) => isUserMessage(entry) && !reverted.has(entry.id))
			.map(async (entry) => {
				const set = turnChanges(entries, entry.id);
				return { set, keys: new Set(await keysOf(set)) };
			}),
	);
	const touched = new Set(await keysOf(turn));
	const dependent = new Set<(typeof candidates)[number]>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const candidate of candidates) {
			if (dependent.has(candidate) || ![...candidate.keys].some((key) => touched.has(key))) continue;
			dependent.add(candidate);
			for (const key of candidate.keys) touched.add(key);
			grew = true;
		}
	}
	const later = candidates.filter((candidate) => dependent.has(candidate));
	if (!later.some((candidate) => candidate.keys.has(blocked))) return false;
	// What each simulated revert left, by file key: the text, or undefined once deleted.
	const simulated = new Map<string, string | undefined>();
	const read: ReadText = (absolute, key) =>
		simulated.has(key) ? Promise.resolve(simulated.get(key)) : readCurrent(absolute);
	try {
		for (const { set } of later.reverse()) {
			for (const [key, file] of await planRevert(set.changes, set.skipped, cwd, read)) {
				simulated.set(key, file.deleted ? undefined : revertedText(file));
			}
		}
		await planRevert(turn.changes, turn.skipped, cwd, read);
		return true;
	} catch (error) {
		if (error instanceof TurnRevertError) return false;
		throw error;
	}
}

/**
 * The lock around reverting one session's turns. Checks and writes are
 * asynchronous, so without it a second request (double click, another tab)
 * passes the checks while the first is still writing files. Which turns are
 * reverted is read from the branch (`revertedTurnIds`).
 */
/** What a file held when a turn ended, for a rendered preview of that turn's delivery. */
export interface FileAtTurn {
	/** The reconstructed text; absent when the file on disk is still that version. */
	readonly text?: string;
	/** False when the version is not on record: the caller shows the current file instead. */
	readonly exact: boolean;
}

/** `patch` with its two sides swapped, so reversing it applies the original forward. */
function invertedPatch(patch: string): string {
	return patch
		.split("\n")
		.map((line) => {
			const header = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
			if (header) return `@@ -${header[2]} +${header[1]} @@${header[3]}`;
			// The "\ No newline" marker follows its line and keeps applying to it.
			if (line.startsWith("+")) return `-${line.slice(1)}`;
			if (line.startsWith("-")) return `+${line.slice(1)}`;
			return line;
		})
		.join("\n");
}

/** Apply a recorded unified patch forward; throws when the content no longer matches it. */
export function applyPatch(content: string, patch: string): string {
	return reversePatch(content, invertedPatch(patch));
}

/** The text a recorded change is compared and replayed in: LF without BOM, like the patches. */
function recordedText(raw: string): string {
	return normalizeToLF(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
}

/**
 * Replay the file's recorded changes up to `end` (exclusive): the latest full
 * content a write recorded, then each later patch applied forward. Undefined
 * when that is not on record: no write named the content, a later change has
 * neither content nor patch, a patch does not apply (something outside the
 * session edited the file in between), or a turn that changed the file was
 * reverted before `end`.
 */
async function replayFile(
	entries: readonly SessionEntry[],
	end: number,
	key: string,
	cwd: string,
): Promise<string | undefined> {
	const sameFile = async (path: string) => (await fileKey(resolveToCwd(path, cwd))) === key;
	const calls = new Map<string, { name: string; path?: string; content?: unknown }>();
	let content: string | undefined;
	for (const entry of entries.slice(0, end)) {
		if (entry.type === "custom_message" && entry.customType === TURN_REVERT_TYPE) {
			const turnId = (entry.details as { turnId?: unknown } | undefined)?.turnId;
			if (typeof turnId !== "string") continue;
			const reverted = turnChanges(entries, turnId);
			for (const change of [...reverted.changes, ...reverted.skipped])
				if (await sameFile(change.path)) return undefined;
			continue;
		}
		if (entry.type !== "message") continue;
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
				calls.set(String(part.id), { name: String(part.name ?? ""), path: toolPath(args), content: args.content });
			}
		}
		if (message.role !== "toolResult" || message.isError || !message.toolCallId) continue;
		const call = calls.get(message.toolCallId);
		if (!call?.path || !FILE_CHANGE_TOOLS.has(call.name) || !(await sameFile(call.path))) continue;
		const details = (message.details ?? {}) as WriteToolDetails & { changed?: unknown };
		const write = call.name === "write" || call.name === "write_file";
		// A write names the whole content, even when the file already held it (`changed: false`).
		if (write && typeof call.content === "string") content = recordedText(call.content);
		else if (details.changed === false) continue;
		else if (typeof details.patch === "string" && content !== undefined) {
			try {
				content = applyPatch(content, details.patch);
			} catch {
				content = undefined;
			}
		} else content = undefined;
	}
	return content;
}

/**
 * Rebuild `path` as the turn `turnId` left it. Preferably by replaying the
 * session's own records up to the end of that turn (`replayFile`), which does
 * not depend on what the file holds now. Without a recorded starting content
 * (the file predates the session) it falls back to the file on disk with every
 * later turn's patches to it reversed, newest first; reverted turns are
 * skipped there, since their edits are already gone from disk, and a later
 * change with no patch, a recreated file, or a patch that no longer applies
 * makes the result inexact. Nothing is written.
 */
export async function fileAtTurnEnd(
	entries: readonly SessionEntry[],
	turnId: string,
	path: string,
	cwd: string,
): Promise<FileAtTurn> {
	const start = entries.findIndex((entry) => entry.id === turnId && isUserMessage(entry));
	if (start < 0) return { exact: false };
	const next = entries.findIndex((entry, index) => index > start && isUserMessage(entry));
	const absolute = resolveToCwd(path, cwd);
	const key = await fileKey(absolute);
	const replayed = await replayFile(entries, next < 0 ? entries.length : next, key, cwd);
	if (replayed !== undefined) {
		const current = await readCurrent(absolute);
		return current !== undefined && recordedText(current) === replayed
			? { exact: true }
			: { text: replayed, exact: true };
	}
	const reverted = new Set(revertedTurnIds(entries));
	const later = entries
		.slice(start + 1)
		.filter((entry) => isUserMessage(entry) && !reverted.has(entry.id))
		.map((entry) => turnChanges(entries, entry.id));
	const sameFile = async (other: string) => (await fileKey(resolveToCwd(other, cwd))) === key;
	const patches: TurnChange[] = [];
	for (const turn of later) {
		for (const change of turn.skipped) if (await sameFile(change.path)) return { exact: false };
		for (const change of turn.changes) if (await sameFile(change.path)) patches.push(change);
	}
	if (!patches.length) return { exact: true };
	const raw = await readCurrent(absolute);
	if (raw === undefined) return { exact: false };
	const bom = raw.startsWith("\uFEFF");
	const text = bom ? raw.slice(1) : raw;
	let content = normalizeToLF(text);
	let lineEnding = detectLineEnding(text);
	let hasBom = bom;
	for (const change of patches.reverse()) {
		// Before a later write created the file, this turn's version is not on record.
		if (change.created) return { exact: false };
		try {
			content = reversePatch(content, change.patch);
		} catch {
			return { exact: false };
		}
		if (change.previous) {
			lineEnding = change.previous.lineEnding;
			hasBom = change.previous.bom;
		}
	}
	const restored = restoreLineEndings(content, lineEnding);
	return { text: hasBom ? `\uFEFF${restored}` : restored, exact: true };
}

export class TurnReverter {
	private busy = false;

	/** A revert is writing files or recording its turn. */
	isBusy(): boolean {
		return this.busy;
	}

	/**
	 * Revert the turn `turnId`; `record` appends the revert entry once the files
	 * are written. A file that no longer matches is refused as `conflict` only
	 * when undoing later turns first was checked to work, otherwise as `modified`.
	 */
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
			const turn = turnChanges(entries, turnId);
			let paths: string[];
			try {
				paths = await revertTurnChanges(turn.changes, cwd, turn.skipped);
			} catch (error) {
				if (
					error instanceof TurnRevertError &&
					error.code === "modified" &&
					error.path !== undefined &&
					(await laterTurnsUnblock(entries, turnId, turn, await fileKey(resolveToCwd(error.path, cwd)), cwd))
				) {
					throw new TurnRevertError(
						"conflict",
						`${error.path} was changed by a later turn; undo the later turns first, newest first`,
						error.path,
					);
				}
				throw error;
			}
			await record(turnId, turn.changes, paths);
			return { paths, skipped: turn.skipped };
		} finally {
			this.busy = false;
		}
	}
}
