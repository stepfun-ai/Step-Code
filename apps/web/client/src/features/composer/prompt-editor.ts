/**
 * DOM helpers for the composer's contenteditable `#prompt`.
 *
 * The prompt is plain text plus inline file chips: a chip is a non-editable
 * `<span class="prompt-file">` naming a file the host stored (see
 * `uploadFile`). The user writes around chips ("参考 [latest.json] 实现"), so a
 * sent message is the text in document order with each chip replaced by its
 * file name, plus the chips' upload ids (`promptFiles`), for which the host
 * appends each file's content. Only text and chips are ever inserted: pastes and
 * drops are intercepted, and the serialiser below reads any other markup a
 * browser produces (line-break `<br>`, block `<div>`) as text.
 */

import type { AttachedFile } from "../../lib/attached-files";
import type { UploadedFile } from "../../state/types";
import { type FileCompletionText, type FileQuery, fileQuery, sameFileQuery } from "./file-completion";
import type { PlannedEdit, PromptEditRun, PromptRange } from "./markdown-format";
import { type SlashToken, slashTokenAt } from "./slash-groups";

const CHIP_CLASS = "prompt-file";
const SVG_NS = "http://www.w3.org/2000/svg";
/** The staged session mode's lead: an inline prefix chip at the line start. */
export const MODE_LEAD_CLASS = "prompt-mode";
/** Any other leading command's chip: serializes back to its exact command text. */
export const COMMAND_LEAD_CLASS = "prompt-command";

/** Uploads still running, by chip key: send waits for them so no chip is sent without its upload id. */
const pendingUploads = new Map<string, Promise<void>>();
let nextChipKey = 0;

/** A chip reads as its file name; the host appends the file itself (`promptFiles`). */
function chipText(chip: HTMLElement): string {
	return chip.dataset.name ?? "";
}

/** A staged mode or command lead chip. */
function isLeadChip(node: Node): boolean {
	return (
		node instanceof HTMLElement &&
		(node.classList.contains(MODE_LEAD_CLASS) || node.classList.contains(COMMAND_LEAD_CLASS))
	);
}

/** `withLeads: false` drops the lead chips' command text, leaving what the user typed beside them. */
function serialize(parent: Node, withLeads = true): string {
	let out = "";
	for (const child of parent.childNodes) {
		if (child instanceof Text) {
			out += child.data.replace(/\u00a0/g, " ");
		} else if (child instanceof HTMLElement) {
			if (child.classList.contains(CHIP_CLASS)) out += chipText(child);
			// Every lead chip (a plain command or a mode) is the inline rendering of its exact command text.
			else if (isLeadChip(child)) out += withLeads ? (child.dataset.text ?? "") : "";
			else if (child.tagName === "BR") out += "\n";
			else if (child.tagName === "DIV" || child.tagName === "P") {
				// A block starts a new line unless one just ended.
				if (out && !out.endsWith("\n")) out += "\n";
				out += serialize(child, withLeads);
			} else out += serialize(child, withLeads);
		}
	}
	return out;
}

/** The prompt as message text: chips become their file names. */
export function promptText(root: HTMLElement): string {
	return serialize(root);
}

/**
 * The prompt as the message to send. A command chip sits where its `/word` was
 * typed, but the kernel runs only a command that leads the message: when no
 * chip leads it, the first command chip moves to the front (with one of the
 * spaces around it), so `111 /skill:x` is sent as `/skill:x 111` and the skill
 * runs with the text as its request. The editor's order is left as typed.
 */
export function promptMessageText(root: HTMLElement): string {
	if (leadingChips(root).length > 0) return serialize(root);
	const copy = root.cloneNode(true) as HTMLElement;
	const chip = copy.querySelector<HTMLElement>(`.${COMMAND_LEAD_CLASS}`);
	if (!chip) return serialize(root);
	const command = chip.dataset.text ?? "";
	const after = chip.nextSibling;
	const before = chip.previousSibling;
	if (after instanceof Text && /^[\s\u00a0]/.test(after.data)) after.data = after.data.slice(1);
	else if (before instanceof Text && /[\s\u00a0]$/.test(before.data)) before.data = before.data.slice(0, -1);
	chip.remove();
	const rest = serialize(copy).replace(/^\s+/, "");
	return rest ? `${command} ${rest}` : command;
}

/**
 * The prompt's text without its staged lead chips. Commands stack, so the slash
 * menu reads this: a `/word` typed after `/skill:a` is the next command to pick.
 */
export function promptBodyText(root: HTMLElement): string {
	return serialize(root, false);
}

/**
 * Remove everything the user typed beside the staged lead chips, keeping the
 * chips and the spaces that separate them: a slash pick replaces only the
 * `/word` it completes, never the commands already staged.
 */
export function clearPromptBody(root: HTMLElement): void {
	for (const child of [...root.childNodes]) {
		if (isLeadChip(child)) continue;
		if (child instanceof Text) {
			const spaces = child.data.replace(/[^\s\u00a0]/g, "");
			if (spaces) child.data = spaces;
			else child.remove();
		} else child.remove();
	}
}

interface CompletionProjection {
	text: string;
	cursor: number | null;
	spans: { node: Text; start: number; end: number }[];
}

/** Chips occupy one non-text character for detection, never their filename or upload metadata. */
function completionProjection(root: HTMLElement): CompletionProjection {
	const selection = getSelection();
	const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
	const caret = range?.collapsed && root.contains(range.startContainer) ? range : null;
	const projection: CompletionProjection = { text: "", cursor: null, spans: [] };
	const walk = (parent: Node) => {
		for (let index = 0; index < parent.childNodes.length; index += 1) {
			if (caret?.startContainer === parent && caret.startOffset === index)
				projection.cursor = projection.text.length;
			const child = parent.childNodes[index];
			if (child instanceof Text) {
				const start = projection.text.length;
				projection.text += child.data.replace(/\u00a0/g, " ");
				projection.spans.push({ node: child, start, end: projection.text.length });
				if (caret?.startContainer === child) projection.cursor = start + caret.startOffset;
			} else if (child instanceof HTMLElement) {
				if (child.classList.contains(CHIP_CLASS) || child.contentEditable === "false") projection.text += "\ufffc";
				else if (child.tagName === "BR") projection.text += "\n";
				else {
					if (
						(child.tagName === "DIV" || child.tagName === "P") &&
						projection.text &&
						!projection.text.endsWith("\n")
					) {
						projection.text += "\n";
					}
					walk(child);
				}
			}
		}
		if (caret?.startContainer === parent && caret.startOffset === parent.childNodes.length) {
			projection.cursor = projection.text.length;
		}
	};
	walk(root);
	return projection;
}

/** The active @path at the actual collapsed selection inside the editor, including a token's right-hand suffix. */
export function promptFileQuery(root: HTMLElement): FileQuery | null {
	const projection = completionProjection(root);
	return projection.cursor === null ? null : fileQuery(projection.text, projection.cursor);
}

function projectionPoint(projection: CompletionProjection, offset: number): { node: Text; offset: number } | null {
	const span = projection.spans.find((item) => item.start <= offset && offset <= item.end);
	return span ? { node: span.node, offset: offset - span.start } : null;
}

/**
 * Replace only the still-active @ token, preserving surrounding DOM and file
 * chips. A moved selection or edited token rejects the pick. Native insertText
 * keeps browser undo; the Range fallback covers a browser that refuses it.
 */
export function replaceFileQuery(root: HTMLElement, expected: FileQuery, completion: FileCompletionText): boolean {
	const projection = completionProjection(root);
	if (projection.cursor === null || !sameFileQuery(fileQuery(projection.text, projection.cursor), expected))
		return false;
	// Keep an existing word separator and place the caret after it on a settled pick.
	const inserted =
		projection.text[expected.end] === " " && completion.text.endsWith(" ")
			? { text: completion.text.slice(0, -1), cursor: completion.cursor }
			: completion;
	const start = projectionPoint(projection, expected.start);
	const end = projectionPoint(projection, expected.end);
	if (!start || !end) return false;
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	select(range);
	if (!document.execCommand("insertText", false, inserted.text)) {
		range.deleteContents();
		const text = document.createTextNode(inserted.text);
		range.insertNode(text);
	}
	const next = projectionPoint(completionProjection(root), expected.start + inserted.cursor);
	if (next) {
		const caret = document.createRange();
		caret.setStart(next.node, next.offset);
		caret.collapse(true);
		select(caret);
	}
	// The insertion's input precedes the caret adjustment for a quoted directory drill.
	root.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}

/** The `/word` at the actual collapsed caret inside the editor (see `slashTokenAt`), or null. */
export function promptSlashToken(root: HTMLElement): SlashToken | null {
	const projection = completionProjection(root);
	return projection.cursor === null ? null : slashTokenAt(projection.text, projection.cursor);
}

/**
 * Remove only the still-active `/word` — the command it named becomes a lead
 * chip — keeping every other word, chip and line around it. One space goes
 * with it when it sat between two words, so `fix /commit it` leaves
 * `fix it`, not a double space. A moved caret or edited word rejects it.
 */
export function removeSlashToken(root: HTMLElement, expected: SlashToken): boolean {
	const projection = completionProjection(root);
	if (projection.cursor === null) return false;
	const current = slashTokenAt(projection.text, projection.cursor);
	if (!current || current.start !== expected.start || current.end !== expected.end) return false;
	const before = projection.text[current.start - 1];
	const end =
		projection.text[current.end] === " " && (before === undefined || /\s/.test(before))
			? current.end + 1
			: current.end;
	const start = projectionPoint(projection, current.start);
	const stop = projectionPoint(projection, end);
	if (!start || !stop) return false;
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(stop.node, stop.offset);
	range.deleteContents();
	range.collapse(true);
	select(range);
	return true;
}

/** An uploaded chip: its upload id (the message's `files`) and what the sent bubble shows before the host echoes it. */
export interface PromptFile extends AttachedFile {
	readonly id: string;
}

/** The uploaded chips, in prompt order. */
export function promptFiles(root: HTMLElement): PromptFile[] {
	return [...root.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}[data-upload-id]`)].map((chip) => ({
		id: chip.dataset.uploadId ?? "",
		name: chip.dataset.name ?? "",
		path: chip.dataset.path ?? "",
		bytes: Number(chip.dataset.size ?? 0),
	}));
}

/**
 * Deleting everything can leave a stray `<br>` behind; remove it so `:empty`
 * shows the placeholder again. Never call this during an IME composition.
 */
export function tidyEmptyPrompt(root: HTMLElement): void {
	if (root.firstChild && !root.textContent && !root.querySelector(`.${CHIP_CLASS}`)) root.replaceChildren();
}

function select(range: Range): void {
	const selection = getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

export function placeCaretAtEnd(root: HTMLElement): void {
	const range = document.createRange();
	range.selectNodeContents(root);
	range.collapse(false);
	select(range);
}

/** Replace the whole prompt with `text` and put the caret after it. */
export function setPromptText(root: HTMLElement, text: string): void {
	root.replaceChildren(...(text ? [document.createTextNode(text)] : []));
	if (document.activeElement === root) placeCaretAtEnd(root);
}

/** The selection inside `root`, or a collapsed range at its end when the selection is elsewhere. */
function caretRange(root: HTMLElement): Range {
	const selection = getSelection();
	if (selection?.rangeCount) {
		const range = selection.getRangeAt(0);
		if (root.contains(range.commonAncestorContainer)) return range;
	}
	const range = document.createRange();
	range.selectNodeContents(root);
	range.collapse(false);
	return range;
}

/**
 * Insert plain text at the caret. `execCommand` keeps the browser's undo
 * history and fires `input`; the range fallback covers a browser that refuses.
 */
export function insertTextAtCaret(root: HTMLElement, text: string): void {
	if (!text) return;
	select(caretRange(root));
	if (document.execCommand("insertText", false, text)) return;
	const range = caretRange(root);
	range.deleteContents();
	const node = document.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	select(range);
	root.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Shift+Enter: a `<br>` line break rather than the browser's default block split. */
export function insertLineBreak(root: HTMLElement): void {
	select(caretRange(root));
	if (!document.execCommand("insertLineBreak")) insertTextAtCaret(root, "\n");
}

/** Move the caret to the drop point, when that point is inside the prompt. */
export function placeCaretAtPoint(root: HTMLElement, x: number, y: number): void {
	let range: Range | null = null;
	// caretPositionFromPoint is Chrome 128+ / Safari 18+; older WebKit has only caretRangeFromPoint.
	const position =
		typeof document.caretPositionFromPoint === "function" ? document.caretPositionFromPoint(x, y) : null;
	if (position) {
		range = document.createRange();
		range.setStart(position.offsetNode, position.offset);
	} else if (typeof document.caretRangeFromPoint === "function") {
		range = document.caretRangeFromPoint(x, y);
	}
	if (!range || !root.contains(range.startContainer)) return;
	range.collapse(true);
	select(range);
}

function createChip(name: string, key: string): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = CHIP_CLASS;
	chip.contentEditable = "false";
	chip.dataset.uploadKey = key;
	chip.dataset.name = name;
	chip.dataset.state = "uploading";
	chip.title = name;
	const icon = document.createElementNS(SVG_NS, "svg");
	icon.setAttribute("class", "icon icon--xs");
	icon.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", "#i-fileText");
	icon.append(use);
	const label = document.createElement("span");
	label.textContent = name;
	chip.append(icon, label);
	return chip;
}

/**
 * Insert a chip for `name` at the caret, followed by a space so the caret can
 * sit after it. The chip gets its upload id when `upload` settles; a failed upload
 * removes the chip and reports through `onFail`.
 */
export function insertFileChip(
	root: HTMLElement,
	name: string,
	upload: Promise<UploadedFile>,
	onFail: (error: unknown) => void,
): Promise<void> {
	nextChipKey += 1;
	const key = String(nextChipKey);
	const chip = createChip(name, key);
	const range = caretRange(root);
	range.deleteContents();
	const space = document.createTextNode(" ");
	// insertNode puts each node at the range start: the space first, then the chip before it.
	range.insertNode(space);
	range.insertNode(chip);
	range.setStartAfter(space);
	range.collapse(true);
	select(range);
	const settled = upload
		.then(
			(file) => {
				chip.dataset.uploadId = file.id;
				chip.dataset.path = file.path;
				chip.dataset.size = String(file.size);
				chip.dataset.state = "ready";
				chip.title = file.path;
			},
			(error: unknown) => {
				chip.remove();
				onFail(error);
			},
		)
		.finally(() => pendingUploads.delete(key));
	pendingUploads.set(key, settled);
	return settled;
}

/** Resolve once every chip inserted so far has its upload id or has been removed. */
export async function waitForUploads(root?: HTMLElement): Promise<void> {
	const keys = root
		? [...root.querySelectorAll<HTMLElement>(".prompt-file")].map((chip) => chip.dataset.uploadKey)
		: [...pendingUploads.keys()];
	await Promise.all(keys.map((key) => (key ? pendingUploads.get(key) : undefined)));
}

/* ── Markdown formatting ─────────────────────────────────────────────────── */

/**
 * Plain-text offset of a DOM boundary, using the same projection as
 * `completionProjection`: chips are one U+FFFC and a block start begins a line.
 * `null` means the boundary is outside the prompt.
 */
function promptOffset(root: HTMLElement, node: Node, offset: number): number | null {
	if (node !== root && !root.contains(node)) return null;
	let total = 0;
	let last: string | null = null;
	let found: number | null = null;
	const walk = (parent: Node): boolean => {
		for (let index = 0; index < parent.childNodes.length; index += 1) {
			if (parent === node && index === offset) {
				found = total;
				return true;
			}
			const child = parent.childNodes[index];
			if (child instanceof Text) {
				if (child === node) {
					found = total + Math.min(offset, child.data.length);
					return true;
				}
				const value = child.data.replace(/\u00a0/g, " ");
				total += value.length;
				last = value.slice(-1) || last;
				continue;
			}
			if (!(child instanceof HTMLElement)) continue;
			if (child.classList.contains(CHIP_CLASS) || child.contentEditable === "false") {
				if (child === node) {
					found = total;
					return true;
				}
				total += 1;
				last = "\ufffc";
				continue;
			}
			if (child.tagName === "BR") {
				if (child === node) {
					found = total;
					return true;
				}
				total += 1;
				last = "\n";
				continue;
			}
			// A block starts a new line unless one just ended (the projection's rule).
			if ((child.tagName === "DIV" || child.tagName === "P") && total > 0 && last !== "\n") {
				total += 1;
				last = "\n";
			}
			if (walk(child)) return true;
		}
		if (parent === node && offset >= parent.childNodes.length) {
			found = total;
			return true;
		}
		return false;
	};
	walk(root);
	return found;
}

/** The current selection as plain-text offsets, with the prompt's projected text. */
export function promptSelection(root: HTMLElement): PromptRange | null {
	const selection = getSelection();
	if (!selection?.rangeCount) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;
	const start = promptOffset(root, range.startContainer, range.startOffset);
	const end = promptOffset(root, range.endContainer, range.endOffset);
	if (start === null || end === null || start > end) return null;
	return { text: completionProjection(root).text, start, end };
}

/** Select the projected text between two offsets; an empty prompt has only its start. */
function selectPromptRange(root: HTMLElement, start: number, end: number): boolean {
	const projection = completionProjection(root);
	const empty = root.childNodes.length === 0;
	const from = projectionPoint(projection, start) ?? (empty && start === 0 ? { node: root, offset: 0 } : null);
	const to = projectionPoint(projection, end) ?? (empty && end === 0 ? { node: root, offset: 0 } : null);
	if (!from || !to) return false;
	const range = document.createRange();
	range.setStart(from.node, from.offset);
	range.setEnd(to.node, to.offset);
	select(range);
	return true;
}

/**
 * Apply a planned Markdown edit. A change that stays inside one text node goes
 * through a single `execCommand`, so one formatting action is one undo step; a
 * change that crosses a line break or a chip falls back to per-run edits.
 * `execCommand` keeps the browser's undo history, and the fallback only inserts
 * or deletes markers — the selected content is never rewritten.
 */
export function applyPromptEdit(root: HTMLElement, edit: PlannedEdit): boolean {
	const runs = [...edit.runs].sort((left, right) => left.start - right.start);
	const applied =
		runs.length > 1 && applyInOneStep(root, edit, runs[0].start, runs[runs.length - 1].end)
			? true
			: applyRuns(root, runs);
	if (!applied) return false;
	// The restored selection follows the edits above; the composer reads the
	// prompt's text on this event (the last execCommand's input ran first).
	selectPromptRange(root, edit.selectionStart, edit.selectionEnd);
	root.dispatchEvent(new InputEvent("input", { bubbles: true }));
	return true;
}

function applyRuns(root: HTMLElement, runs: readonly PromptEditRun[]): boolean {
	for (const run of [...runs].sort((left, right) => right.start - left.start)) {
		if (!selectPromptRange(root, run.start, run.end)) return false;
		const applied =
			run.start === run.end ? document.execCommand("insertText", false, run.text) : document.execCommand("delete");
		if (!applied) return false;
	}
	return true;
}

/**
 * Replace the whole changed span in one command when it lives in a single text
 * node. The replacement is the plan's own result for that span, so markers and
 * text stay identical to the per-run application.
 */
function applyInOneStep(root: HTMLElement, edit: PlannedEdit, start: number, end: number): boolean {
	const projection = completionProjection(root);
	const from = projectionPoint(projection, start);
	const to = projectionPoint(projection, end);
	if (!from || !to || from.node !== to.node) return false;
	const removed = end - start;
	const replacementLength = edit.text.length - (projection.text.length - removed);
	const replacement = edit.text.slice(start, start + replacementLength);
	if (!selectPromptRange(root, start, end)) return false;
	return document.execCommand("insertText", false, replacement);
}

/** Insert a marker pair around the selection (or drop an existing one). */
export function formatPromptSelection(root: HTMLElement, plan: (range: PromptRange) => PlannedEdit | null): boolean {
	const range = promptSelection(root);
	if (!range) return false;
	const edit = plan(range);
	return edit ? applyPromptEdit(root, edit) : false;
}

/* ── The staged session mode's lead chip ─────────────────────────────────── */

/** What `insertModeLead` renders: the mode's icon, its label and the command the send will run. */
export interface ModeLead {
	readonly id: string;
	readonly icon: string;
	readonly label: string;
	/** Tooltip: the command line the chip stands for, e.g. `/goal`. */
	readonly command: string;
}

/**
 * The mode's lead sits at the very start of the line, before any text: a
 * backspace over it removes it like a word (the composer then unstages the
 * mode), and `modePrefix` still leads the outgoing message. The three modes
 * are mutually exclusive — one rides a message — so staging another mode
 * replaces any mode chip already standing, in its place; only plain commands
 * stack beside it.
 */
export function insertModeLead(root: HTMLElement, lead: ModeLead): void {
	const existing = root.querySelector<HTMLElement>(`.${MODE_LEAD_CLASS}[data-mode="${lead.id}"]`);
	if (existing) return;
	const chip = buildLeadChip(MODE_LEAD_CLASS, lead.id, lead.icon, lead.label, lead.command);
	const other = root.querySelector<HTMLElement>(`.${MODE_LEAD_CLASS}`);
	if (other) other.replaceWith(chip);
	else appendLeadChip(root, chip);
	focusAfterLead(root, chip);
	refreshPlaceholderHint(root);
}

/**
 * Drop one mode's lead chip (toggling it off, a wiped prompt); without `id`,
 * every mode chip goes — at most one stands, but plain-command chips stay.
 */
export function removeModeLead(root: HTMLElement, id?: string): void {
	for (const chip of [...root.querySelectorAll<HTMLElement>(`.${MODE_LEAD_CLASS}`)]) {
		if (id && chip.dataset.mode !== id) continue;
		if (chip.nextSibling?.textContent === " ") chip.nextSibling.remove();
		chip.remove();
	}
	refreshPlaceholderHint(root);
}

/**
 * A lead chip as an element: the sent format's own look (tool-glyph + label, no
 * pill), its command text — no trailing space; the space node `appendLeadChip`
 * sets after each chip separates the serialized stack — on `dataset.text`.
 */
function buildLeadChip(
	className: string,
	mode: string | undefined,
	icon: string,
	label: string,
	text: string,
): HTMLElement {
	const chip = document.createElement("span");
	chip.className = className;
	chip.contentEditable = "false";
	if (mode) chip.dataset.mode = mode;
	chip.dataset.text = text;
	chip.title = text.trim();
	const glyph = document.createElement("span");
	glyph.className = "tool-glyph";
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "icon icon--xs tool-kind-icon");
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", `#i-${icon}`);
	svg.append(use);
	glyph.append(svg);
	const labelText = document.createElement("span");
	labelText.className = `${className}-label`;
	labelText.textContent = label;
	chip.append(glyph, labelText);
	return chip;
}

/**
 * Append `chip` after the last lead already staged, keeping the stack in order.
 * The previous chip's separating space also separates the two chips (a typed
 * command leaves that space behind when it is stripped into its chip), so the
 * new chip goes past it — or past whatever follows when that space is gone,
 * after setting one — and carries its own space after.
 */
function appendLeadChip(root: HTMLElement, chip: HTMLElement): void {
	const leads = leadingChips(root);
	const last = leads.at(-1) ?? null;
	let anchor = last ? last.nextSibling : (root.firstChild ?? null);
	if (last && anchor?.textContent === " ") anchor = anchor.nextSibling ?? null;
	if (last && anchor === last.nextSibling) root.insertBefore(document.createTextNode(" "), anchor);
	root.insertBefore(chip, anchor);
	root.insertBefore(document.createTextNode(" "), chip.nextSibling);
}

/**
 * The lead chips that start the prompt, in order: the run of chips before the
 * first text. A command chip placed mid-text (`replaceSlashTokenWithCommand`)
 * is not part of it, so a later lead still stacks at the front.
 */
function leadingChips(root: HTMLElement): HTMLElement[] {
	const leads: HTMLElement[] = [];
	for (const child of root.childNodes) {
		if (isLeadChip(child)) leads.push(child as HTMLElement);
		else if (!(child instanceof Text && !child.data.replace(/\u00a0/g, " ").trim())) break;
	}
	return leads;
}

/** Park the caret just after `chip`'s trailing space, where typing continues, when the editor holds focus. */
function focusAfterLead(root: HTMLElement, chip: HTMLElement): void {
	if (document.activeElement !== root) return;
	const range = document.createRange();
	range.setStart(chip.nextSibling ?? chip, chip.nextSibling ? 1 : 0);
	range.collapse(true);
	select(range);
}

/**
 * A plain command's lead chip: it APPENDS after any leads already staged —
 * commands stack, one input can carry several, in the order they were staged.
 */
function insertLeadChip(
	root: HTMLElement,
	className: string,
	mode: string | undefined,
	icon: string,
	label: string,
	text: string,
): void {
	const chip = buildLeadChip(className, mode, icon, label, text);
	appendLeadChip(root, chip);
	focusAfterLead(root, chip);
	refreshPlaceholderHint(root);
}

/**
 * `data-empty` lets the placeholder render after the mode lead when the chip is
 * the prompt's only content (the `:empty` rule cannot fire there).
 */
export function refreshPlaceholderHint(root: HTMLElement): void {
	const onlyLead = Boolean(root.querySelector(`.${MODE_LEAD_CLASS}`)) && !promptText(root).trim();
	if (onlyLead) root.dataset.empty = "";
	else delete root.dataset.empty;
}

/** What `insertCommandLead` renders: a non-mode command and the icon it shows. */
export interface CommandLead {
	/** The command as typed, without trailing space: `/feedback`, `/skill:foo`. */
	readonly command: string;
	readonly icon: string;
}

/**
 * A plain leading command's chip: icon + the command text, at the line start
 * like the mode lead. Unlike it, the chip serializes back to exactly its
 * command text, so the message the kernel receives is unchanged.
 */
export function insertCommandLead(root: HTMLElement, lead: CommandLead): void {
	insertLeadChip(root, COMMAND_LEAD_CLASS, undefined, lead.icon, lead.command, lead.command);
}

/**
 * Turn the still-active `/word` into `lead`'s command chip where it was typed,
 * keeping the words around it in order (`111 /` -> `111 /skill:x`,
 * `/skill:a 和 /` -> `/skill:a 和 /skill:b`). The chip serializes back to its
 * command text in place; `promptMessageText` moves the first one to the front
 * of a sent message that no command leads. A moved caret or edited word
 * rejects it.
 */
export function replaceSlashTokenWithCommand(root: HTMLElement, expected: SlashToken, lead: CommandLead): boolean {
	const projection = completionProjection(root);
	if (projection.cursor === null) return false;
	const current = slashTokenAt(projection.text, projection.cursor);
	if (!current || current.start !== expected.start || current.end !== expected.end) return false;
	const start = projectionPoint(projection, current.start);
	const stop = projectionPoint(projection, current.end);
	if (!start || !stop) return false;
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(stop.node, stop.offset);
	range.deleteContents();
	const chip = buildLeadChip(COMMAND_LEAD_CLASS, undefined, lead.icon, lead.command, lead.command);
	range.insertNode(chip);
	// The chip carries a separating space after it, unless the text already has one.
	const next = chip.nextSibling;
	const spaced = next instanceof Text && /^[\s\u00a0]/.test(next.data);
	const space = spaced ? next : document.createTextNode(" ");
	if (!spaced) chip.after(space);
	const caret = document.createRange();
	caret.setStart(space, 1);
	caret.collapse(true);
	select(caret);
	refreshPlaceholderHint(root);
	return true;
}

/**
 * The first text the user can still edit: in document order, not inside a file
 * chip or either lead chip.
 */
function firstPromptTextNode(root: HTMLElement): Text | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text;
		let outsideChips = true;
		for (let el = text.parentElement; el && el !== root; el = el.parentElement) {
			if (el.contentEditable === "false" || el.classList.contains(CHIP_CLASS)) {
				outsideChips = false;
				break;
			}
		}
		if (outsideChips) return text;
	}
	return null;
}

/** A command complete enough to lead the message: `name` plus the space after it. */
const LEADING_COMMAND = /^(\s*)(?:\/([A-Za-z0-9][\w.:-]*)|ultracode:)(\s)/;

/**
 * Take a completed leading command out of the prompt's text and report its
 * name (slash commands without the slash; the keyword form as `ultracode`) —
 * the caller turns it into the matching lead chip. Nothing else moves: the
 * command must be the very first text (a command after a file chip or mid-text
 * is not a command the kernel would run).
 */
export function stripLeadingCommand(root: HTMLElement): string | null {
	const serialized = promptText(root).replace(/\u00a0/g, " ");
	if (!/^\s*(?:\/[A-Za-z0-9]|ultracode:)/.test(serialized)) return null;
	const node = firstPromptTextNode(root);
	if (!node?.data) return null;
	const match = LEADING_COMMAND.exec(node.data.replace(/\u00a0/g, " "));
	if (!match) return null;
	// Keep any leading spaces (they separate a mode chip), drop the command and one space.
	const start = match[1].length;
	const end = match[0].length;
	node.data = node.data.slice(0, start) + node.data.slice(end);
	if (!node.data) node.remove();
	return match[2] ?? "ultracode";
}

/** A copy of the prompt's content, put back by `restorePrompt` when a send fails. */
export function snapshotPrompt(root: HTMLElement): Node[] {
	return [...root.childNodes].map((node) => node.cloneNode(true));
}

export function restorePrompt(root: HTMLElement, nodes: readonly Node[]): void {
	root.replaceChildren(...nodes);
	if (root.isConnected && document.activeElement === root) placeCaretAtEnd(root);
}

/** Restore a failed send without discarding later typing or stacking two staged modes. */
export function restoreFailedPrompt(root: HTMLElement, nodes: readonly Node[]): void {
	const restored = document.createElement("div");
	restored.replaceChildren(...nodes);
	const newerMode = root.querySelector<HTMLElement>(`.${MODE_LEAD_CLASS}`);
	const lead: Node[] = [];
	if (newerMode) {
		lead.push(newerMode, document.createTextNode(" "));
		removeModeLead(restored);
		removeModeLead(root);
	}
	restorePrompt(root, [...lead, ...restored.childNodes, ...root.childNodes]);
}
