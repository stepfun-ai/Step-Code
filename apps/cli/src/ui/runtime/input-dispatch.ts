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
 * `wireInputHandlers` must register onto defaultEditor BEFORE any editor swap: the swap
 * path (setCustomEditorComponent) copies actionHandlers/onCtrlD/onPasteImage from
 * defaultEditor to the swapped-in editor, so a late registration would be missed.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSession,
	APP_NAME,
	extensionForImageMimeType,
	readClipboardImage,
	readClipboardText,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeContext } from "./context.ts";
import { handleEscape } from "./interrupt.ts";

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

export async function clipboardPaste(ctx: RuntimeContext): Promise<void> {
	try {
		const image = await readClipboardImage();
		if (image) {
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `${APP_NAME}-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			ctx.editor.insertTextAtCursor?.(filePath);
			ctx.redraw.requestRender();
			return;
		}

		const text = await readClipboardText();
		if (text) {
			ctx.editor.insertTextAtCursor?.(text);
			ctx.redraw.requestRender();
		}
	} catch {
		// Silently ignore clipboard errors (may not have permission, etc.)
	}
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
}

export function wireSubmitHandler(ctx: RuntimeContext): void {
	ctx.defaultEditor.onSubmit = async (text: string) => {
		text = text.trim();
		if (!text) return;

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
		if (text === "/arminsayshi") {
			ctx.handleArminSaysHi();
			ctx.editor.setText("");
			return;
		}
		if (text === "/dementedelves") {
			ctx.handleDementedDelves();
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
				ctx.queueCompactionMessage(text, "steer");
			}
			return;
		}

		// If streaming, use prompt() with steer behavior
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (ctx.session.isStreaming) {
			ctx.editor.addToHistory?.(text);
			ctx.editor.setText("");
			await ctx.session.prompt(text, { streamingBehavior: "steer" });
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
