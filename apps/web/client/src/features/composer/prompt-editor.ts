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

function serialize(parent: Node): string {
	let out = "";
	for (const child of parent.childNodes) {
		if (child instanceof Text) {
			out += child.data.replace(/\u00a0/g, " ");
		} else if (child instanceof HTMLElement) {
			if (child.classList.contains(CHIP_CLASS)) out += chipText(child);
			// A plain command chip is the inline rendering of the command text itself.
			else if (child.classList.contains(COMMAND_LEAD_CLASS)) out += child.dataset.text ?? "";
			// The staged mode's lead is the inline rendering of its command; the
			// outgoing message gets that command from `modePrefix`, not the chip.
			else if (child.classList.contains(MODE_LEAD_CLASS)) continue;
			else if (child.tagName === "BR") out += "\n";
			else if (child.tagName === "DIV" || child.tagName === "P") {
				// A block starts a new line unless one just ended.
				if (out && !out.endsWith("\n")) out += "\n";
				out += serialize(child);
			} else out += serialize(child);
		}
	}
	return out;
}

/** The prompt as message text: chips become their file names. */
export function promptText(root: HTMLElement): string {
	return serialize(root);
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
): void {
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
}

/** Resolve once every chip inserted so far has its upload id or has been removed. */
export async function waitForUploads(): Promise<void> {
	await Promise.all(pendingUploads.values());
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
 * mode), and `modePrefix` still leads the outgoing message. Re-staging another
 * mode replaces the chip in place.
 */
export function insertModeLead(root: HTMLElement, lead: ModeLead): void {
	const existing = root.querySelector<HTMLElement>(`.${MODE_LEAD_CLASS}`);
	if (existing?.dataset.mode === lead.id && existing.textContent === lead.label) return;
	existing?.remove();
	const chip = document.createElement("span");
	chip.className = MODE_LEAD_CLASS;
	chip.contentEditable = "false";
	chip.dataset.mode = lead.id;
	chip.title = lead.command;
	const icon = document.createElementNS(SVG_NS, "svg");
	icon.setAttribute("class", `icon icon--xs ${MODE_LEAD_CLASS}-icon`);
	icon.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", `#i-${lead.icon}`);
	icon.append(use);
	const label = document.createElement("span");
	label.className = `${MODE_LEAD_CLASS}-label`;
	label.textContent = lead.label;
	chip.append(icon, label);
	root.insertBefore(chip, root.firstChild ?? null);
	// The space after it is where the caret sits and what separates the chip from the typed text.
	root.insertBefore(document.createTextNode(" "), chip.nextSibling);
	if (document.activeElement === root) {
		const range = document.createRange();
		range.setStart(chip.nextSibling ?? chip, chip.nextSibling ? 1 : 0);
		range.collapse(true);
		select(range);
	}
	refreshPlaceholderHint(root);
}

/** Drop the lead chip and its separating space (toggling the mode off, or a wiped prompt). */
export function removeModeLead(root: HTMLElement): void {
	const chip = root.querySelector(`.${MODE_LEAD_CLASS}`);
	if (!chip) return;
	if (chip.nextSibling?.textContent === " ") chip.nextSibling.remove();
	chip.remove();
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
	root.querySelector(`.${COMMAND_LEAD_CLASS}`)?.remove();
	const chip = document.createElement("span");
	chip.className = COMMAND_LEAD_CLASS;
	chip.contentEditable = "false";
	chip.dataset.text = `${lead.command} `;
	chip.title = lead.command;
	const icon = document.createElementNS(SVG_NS, "svg");
	icon.setAttribute("class", `icon icon--xs ${COMMAND_LEAD_CLASS}-icon`);
	icon.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", `#i-${lead.icon}`);
	icon.append(use);
	const label = document.createElement("span");
	label.className = `${COMMAND_LEAD_CLASS}-label`;
	label.textContent = lead.command;
	chip.append(icon, label);
	root.insertBefore(chip, root.firstChild ?? null);
	root.insertBefore(document.createTextNode(" "), chip.nextSibling);
	if (document.activeElement === root) {
		const range = document.createRange();
		range.setStart(chip.nextSibling ?? chip, chip.nextSibling ? 1 : 0);
		range.collapse(true);
		select(range);
	}
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
	placeCaretAtEnd(root);
}
