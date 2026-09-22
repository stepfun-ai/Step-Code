/**
 * input-dispatch.ts — key-binding registration + the submit router (S4-1 STEP 3).
 *
 * Everything here is relocated VERBATIM from InteractiveMode (only `this.` → `ctx.`). The
 * slash if-ladder ORDER, the per-branch `setText("")` placement (before vs after the
 * awaited command), the per-branch `addToHistory` position, the `stopLogoIntro()`
 * first-in-onSubmit, the exact `/model` vs `/model ` (slice 7) and `/thinking`(10) vs
 * `/effort`(8) offsets, the bash `!`/`!!` branch AFTER the slash checks, and the
 * compaction gate BEFORE the streaming gate are all load-bearing and preserved byte for
 * byte.
 *
 * Slash targets stay INJECTED host callbacks (ctx.handleXxxCommand) — the commands/ wiring
 * is deferred to S4-2, and importing the host command methods back here would be a
 * runtime→host reverse dependency. onEscape's non-timer branches delegate to interrupt
 * (handleEscape), which owns the double-Esc window.
 *
 * `wireKeyHandlers` must register onto defaultEditor BEFORE any editor swap: the swap
 * path (setCustomEditorComponent) copies onEscape/onCtrlD/onPasteImage/onEmptyPaste/canDequeue/
 * onExtensionShortcut from defaultEditor to the swapped-in editor, so a late registration
 * would be missed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSession,
	APP_NAME,
	cleanPastedPath,
	extensionForImageMimeType,
	isImageFilePath,
	isWindowsPath,
	readClipboardImage,
	readClipboardImagePath,
	readClipboardText,
	wslPathToPosix,
} from "@step-harness/coding-agent";
import type { RuntimeContext } from "./context.ts";
import { handleEscape } from "./interrupt.ts";
import { resolvePastedImages } from "./pasted-images.ts";

/** Pure recognizer: is `text` a slash command provided by a loaded extension? */
export function isExtensionCommand(extensionRunner: AgentSession["extensionRunner"], text: string): boolean {
	if (!text.startsWith("/")) return false;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	return !!extensionRunner.getCommand(commandName);
}

export async function rightClickPaste(ctx: RuntimeContext): Promise<void> {
	const target = ctx.renderer.getFocusedComponent();
	const handleInput = target?.handleInput;
	if (!target || !handleInput) return;
	try {
		const text = await readClipboardText();
		if (!text || ctx.renderer.getFocusedComponent() !== target) return;
		handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
		ctx.redraw.requestRender();
	} catch {
		// Silently ignore clipboard errors (may not have permission, etc.)
	}
}

/**
 * Register a pasted image file and insert its `[Image #N]` placeholder at the
 * cursor. The placeholder is what the user sees; the absolute path is remembered
 * in ctx.pastedImages and resolved back to an attached image when the message is
 * sent. A trailing space separates it from whatever the user types next.
 */
function insertImagePlaceholder(ctx: RuntimeContext, absolutePath: string): void {
	const n = ctx.pastedImages.register(absolutePath);
	ctx.editor.insertTextAtCursor?.(`[Image #${n}] `);
}

export async function clipboardPaste(ctx: RuntimeContext, opts?: { imageOnly?: boolean }): Promise<void> {
	try {
		// A copied FILE (Finder/Explorer) puts BOTH a file URL and the file's ICON
		// on the clipboard, so readClipboardImage() below would return the icon, not
		// the file. Prefer the real file path: reference the file itself.
		const clipboardFile = await readClipboardImagePath();
		if (clipboardFile && fs.existsSync(clipboardFile)) {
			insertImagePlaceholder(ctx, clipboardFile);
			ctx.redraw.requestRender();
			return;
		}

		const image = await readClipboardImage();
		if (image) {
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `${APP_NAME}-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			insertImagePlaceholder(ctx, filePath);
			ctx.redraw.requestRender();
			return;
		}

		// The empty-bracketed-paste trigger (Cmd+V of an image-only clipboard) only
		// wants an image. Skip the text fallback so a genuinely empty paste with no
		// image inserts nothing — identical to the behavior before this hook existed.
		if (opts?.imageOnly) return;

		const text = await readClipboardText();
		if (text) {
			ctx.editor.insertTextAtCursor?.(text);
			ctx.redraw.requestRender();
		}
	} catch {
		// Silently ignore clipboard errors (may not have permission, etc.)
	}
}

/**
 * Handle a bracketed paste whose text is an image file reference — e.g. a file
 * copied in Finder/Explorer, which the terminal pastes as its (often bare) name.
 * Resolve it to an absolute path (a bare name via the clipboard's file URL) and
 * insert it as an `[Image #N]` placeholder (registering the path so it is attached
 * on send); if it cannot be resolved, insert the original text unchanged so
 * nothing is lost.
 *
 * Exported for unit testing the WSL Windows-path branch composition.
 */
export async function insertPastedImagePath(ctx: RuntimeContext, pastedText: string): Promise<void> {
	let absolutePath: string | undefined;
	try {
		const cleaned = cleanPastedPath(pastedText);
		if (path.isAbsolute(cleaned) && isImageFilePath(cleaned) && fs.existsSync(cleaned)) {
			absolutePath = cleaned;
		} else if (isWindowsPath(cleaned)) {
			// On WSL, a file copied in Windows Explorer pastes as a Windows path
			// (`C:\...`) that does not exist on the Linux side; convert it to its
			// `/mnt/...` form before checking. On non-WSL this returns null, so a
			// stray `C:\...` paste falls through to the raw-text insert below.
			const posixPath = await wslPathToPosix(cleaned);
			if (posixPath && isImageFilePath(posixPath) && fs.existsSync(posixPath)) {
				absolutePath = posixPath;
			}
		} else {
			const clipboardPath = await readClipboardImagePath();
			const matches = clipboardPath
				? path.isAbsolute(cleaned)
					? clipboardPath === cleaned
					: path.basename(clipboardPath) === path.basename(cleaned)
				: false;
			if (clipboardPath && matches && fs.existsSync(clipboardPath)) {
				absolutePath = clipboardPath;
			}
		}
	} catch {
		// Fall back to the original pasted text below.
	}
	if (absolutePath) {
		insertImagePlaceholder(ctx, absolutePath);
	} else {
		ctx.editor.insertTextAtCursor?.(pastedText);
	}
	ctx.redraw.requestRender();
}

export function handleStartupSubmit(ctx: RuntimeContext, text: string): void {
	ctx.editor.setText(text);
	ctx.showStatus("Startup is still in progress");
}

export function wireKeyHandlers(ctx: RuntimeContext): void {
	// Set up handlers on defaultEditor - they use ctx.editor for text access
	// so they work correctly regardless of which editor is active
	ctx.defaultEditor.onEscape = () => {
		handleEscape(ctx);
	};

	// Register app action handlers
	ctx.defaultEditor.onAction("app.clear", () => ctx.handleCtrlC());
	ctx.defaultEditor.onCtrlD = () => ctx.handleCtrlD();
	ctx.defaultEditor.onAction("app.suspend", () => ctx.handleCtrlZ());
	ctx.defaultEditor.onAction("app.thinking.cycle", () => {
		// Step keeps pi's keybinding id and native editor dispatch, but uses
		// Shift+Tab for its permission preset cycle. The command is handled by
		// the Step extension; ordinary pi sessions retain thinking-level cycling.
		if (ctx.options.tuiStyle === "step" && ctx.session.extensionRunner.getCommand("permissions")) {
			void ctx.session.prompt("/permissions --cycle");
			return;
		}
		ctx.cycleThinkingLevel();
	});
	ctx.defaultEditor.onAction("app.model.cycleForward", () => ctx.cycleModel("forward"));
	ctx.defaultEditor.onAction("app.model.cycleBackward", () => ctx.cycleModel("backward"));

	// Global debug handler on TUI (works regardless of focus)
	ctx.ui.onDebug = () => ctx.handleDebugCommand();
	ctx.defaultEditor.onAction("app.model.select", () => ctx.showModelSelector());
	// Manual redraw (Ctrl+L): force a differential-renderer reset plus immediate
	// repaint — the user-facing recovery for terminals that garble the viewport
	// after scrolling or font changes (feedback issue-9ad367d596a230a9). The
	// concrete renderNow(true) reset stays at the call site, not the redraw facade.
	ctx.defaultEditor.onAction("app.redraw", () => ctx.ui.renderNow(true));
	ctx.defaultEditor.onAction("app.tools.expand", () => ctx.toggleToolOutputExpansion());
	ctx.defaultEditor.onAction("app.thinking.toggle", () => ctx.toggleThinkingBlockVisibility());
	ctx.defaultEditor.onAction("app.editor.external", () => void ctx.handleOpenExternalEditor());
	ctx.defaultEditor.onAction(
		"app.message.copy",
		() =>
			void ctx.handleCopyCommand({
				flashConfirmation: true,
				preferSelection: true,
			}),
	);
	ctx.defaultEditor.onAction("app.message.followUp", () => ctx.handleFollowUp());
	ctx.defaultEditor.canDequeue = () => {
		const { steering, followUp } = ctx.getAllQueuedMessages();
		return steering.length > 0 || followUp.length > 0;
	};
	ctx.defaultEditor.onAction("app.message.dequeue", () => ctx.handleDequeue());
	ctx.defaultEditor.onAction("app.session.new", () => ctx.handleClearCommand());
	ctx.defaultEditor.onAction("app.session.tree", () => ctx.showTreeSelector());
	ctx.defaultEditor.onAction("app.session.fork", () => ctx.showUserMessageSelector());
	ctx.defaultEditor.onAction("app.session.resume", () => ctx.showSessionSelector());

	ctx.defaultEditor.onChange = (text: string) => {
		const wasBashMode = ctx.isBashMode;
		const wasBashExcluded = ctx.isBashExcluded;
		const trimmed = text.trimStart();
		ctx.isBashMode = trimmed.startsWith("!");
		ctx.isBashExcluded = trimmed.startsWith("!!");
		if (wasBashMode !== ctx.isBashMode || wasBashExcluded !== ctx.isBashExcluded) {
			ctx.updateEditorBorderColor();
		}
	};

	// Handle clipboard paste (triggered on Ctrl+V). Images are attached by path;
	// otherwise, paste plain text from the system clipboard.
	ctx.defaultEditor.onPasteImage = () => {
		void ctx.handleClipboardPaste();
	};

	// An empty bracketed paste (macOS Cmd+V of an image-only clipboard) has no text
	// to insert; treat it as an image-only paste so the clipboard image is attached
	// by path. No image on the clipboard -> no-op (no text fallback).
	ctx.defaultEditor.onEmptyPaste = () => {
		void ctx.handleClipboardPaste(true);
	};

	// A paste whose text is a single image file path/name (e.g. a file copied in
	// Finder/Explorer, pasted by the terminal as its name) is resolved to an
	// absolute `@` reference. Returning true claims the paste; anything else
	// pastes normally.
	ctx.defaultEditor.onPasteImagePath = (content: string) => {
		const cleaned = cleanPastedPath(content);
		// Only claim a short, single-line, image-extension token. The length cap
		// keeps large single-line pastes on the base editor's paste path (which
		// collapses big blobs) and bounds how often the clipboard is probed.
		if (cleaned.length === 0 || cleaned.length > 512 || cleaned.includes("\n") || !isImageFilePath(cleaned)) {
			return false;
		}
		void insertPastedImagePath(ctx, content);
		return true;
	};
}

export function wireSubmitHandler(ctx: RuntimeContext): void {
	ctx.defaultEditor.onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;
		// These two answer in place instead of going through the agent, so without
		// an echo the transcript shows a reply to a question nobody asked.
		if (text === "/mcp" || text === "/status") ctx.addCommandInputToChat(text);

		// Whatever this submission produces can push the transcript past the
		// viewport, and an animating welcome block above the viewport leaves pi
		// nothing but a full redraw per frame. The launch flourish is over.
		ctx.stepWelcome?.stopLogoIntro();

		// Handle commands
		if (text === "/settings") {
			ctx.showSettingsSelector();
			ctx.editor.setText("");
			return;
		}
		if (text === "/scoped-models") {
			ctx.editor.setText("");
			await ctx.showModelsSelector();
			return;
		}
		if (text === "/model" || text.startsWith("/model ")) {
			const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
			ctx.editor.setText("");
			await ctx.handleModelCommand(searchTerm);
			return;
		}
		if (text === "/thinking" || text.startsWith("/thinking ") || text === "/effort" || text.startsWith("/effort ")) {
			const searchTerm = text.startsWith("/thinking ")
				? text.slice(10).trim()
				: text.startsWith("/effort ")
					? text.slice(8).trim()
					: undefined;
			ctx.editor.setText("");
			ctx.handleThinkingCommand(searchTerm);
			return;
		}
		if (text === "/export" || text.startsWith("/export ")) {
			await ctx.handleExportCommand(text);
			ctx.editor.setText("");
			return;
		}
		if (text === "/import" || text.startsWith("/import ")) {
			await ctx.handleImportCommand(text);
			ctx.editor.setText("");
			return;
		}
		if (text === "/share") {
			await ctx.handleShareCommand();
			ctx.editor.setText("");
			return;
		}
		if (text === "/copy") {
			await ctx.handleCopyCommand();
			ctx.editor.setText("");
			return;
		}
		if (text === "/name" || text.startsWith("/name ")) {
			ctx.handleNameCommand(text);
			ctx.editor.setText("");
			return;
		}
		if (text === "/session") {
			ctx.handleSessionCommand();
			ctx.editor.setText("");
			return;
		}
		if (text === "/hotkeys") {
			ctx.handleHotkeysCommand();
			ctx.editor.setText("");
			return;
		}
		if (text === "/fork") {
			ctx.showUserMessageSelector();
			ctx.editor.setText("");
			return;
		}
		if (text === "/clone") {
			ctx.editor.setText("");
			await ctx.handleCloneCommand();
			return;
		}
		if (text === "/tree") {
			ctx.showTreeSelector();
			ctx.editor.setText("");
			return;
		}
		if (text === "/trust") {
			ctx.showTrustSelector();
			ctx.editor.setText("");
			return;
		}
		if (text === "/login" || text.startsWith("/login ")) {
			const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
			ctx.editor.setText("");
			await ctx.handleLoginCommand(providerRef);
			return;
		}
		if (text === "/logout") {
			ctx.editor.setText("");
			if (ctx.options.stepLogout) await ctx.handleStepLogoutCommand();
			else ctx.showOAuthSelector("logout");
			return;
		}
		if (text === "/new") {
			ctx.editor.setText("");
			await ctx.handleClearCommand();
			return;
		}
		if (text === "/compact" || text.startsWith("/compact ")) {
			const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
			ctx.editor.setText("");
			await ctx.handleCompactCommand(customInstructions);
			return;
		}
		if (text === "/reload") {
			ctx.editor.setText("");
			await ctx.handleReloadCommand();
			return;
		}
		if (text === "/debug") {
			ctx.handleDebugCommand();
			ctx.editor.setText("");
			return;
		}
		if (text === "/resume") {
			ctx.showSessionSelector();
			ctx.editor.setText("");
			return;
		}
		if (text === "/quit") {
			ctx.editor.setText("");
			await ctx.shutdown();
			return;
		}

		// An unregistered slash command used to fall through to normal submission
		// and reach the model verbatim, with no error. Everything the hardcoded
		// chain above handles has already returned, so anything command-shaped
		// still here must resolve to an extension command, prompt template, or
		// skill. Feedback issue-d59692496ef285c0.
		const unknownCommand = ctx.getUnknownSlashCommandName(text);
		if (unknownCommand !== undefined) {
			ctx.showError(`/${unknownCommand} is not a command. Type / to list the available commands.`);
			// submitValue() clears the editor before calling this handler, so put
			// the text back: a mistyped command is usually one character off.
			ctx.editor.setText(text);
			return;
		}

		// Handle bash command (! for normal, !! for excluded from context)
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (ctx.session.isBashRunning) {
					ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
					ctx.editor.setText(text);
					return;
				}
				ctx.editor.addToHistory?.(text);
				await ctx.handleBashCommand(command, isExcluded);
				ctx.isBashMode = false;
				ctx.isBashExcluded = false;
				ctx.updateEditorBorderColor();
				return;
			}
		}

		// Queue input during compaction (extension commands execute immediately)
		if (ctx.session.isCompacting) {
			if (ctx.isExtensionCommand(text)) {
				ctx.editor.addToHistory?.(text);
				ctx.editor.setText("");
				await ctx.session.prompt(text);
			} else {
				const { text: message, images } = await resolvePastedImages(ctx.pastedImages, text, {
					autoResizeImages: ctx.settingsManager.getImageAutoResize(),
				});
				ctx.queueCompactionMessage(message, "steer", images.length ? images : undefined);
			}
			return;
		}

		// If streaming, use prompt() with steer behavior
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (ctx.session.isStreaming) {
			ctx.editor.addToHistory?.(text);
			ctx.editor.setText("");
			const { text: message, images } = await resolvePastedImages(ctx.pastedImages, text, {
				autoResizeImages: ctx.settingsManager.getImageAutoResize(),
			});
			await ctx.session.prompt(message, { streamingBehavior: "steer", images: images.length ? images : undefined });
			ctx.updatePendingMessagesDisplay();
			ctx.redraw.requestRender();
			return;
		}

		// Normal message submission
		// First, move any pending bash components to chat
		ctx.flushPendingBashComponents();

		if (ctx.onInputCallback) {
			ctx.onInputCallback(text);
		} else {
			ctx.pendingUserInputs.push(text);
		}
		ctx.editor.addToHistory?.(text);
	};
}
