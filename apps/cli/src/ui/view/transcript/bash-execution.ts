/**
 * Component for displaying bash command execution with streaming output.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DynamicBorder,
	keyHint,
	keyText,
	stripAnsi,
	type TruncationResult,
	theme,
	truncateTail,
	truncateToVisualLines,
} from "@step-harness/coding-agent";
import {
	Container,
	isIncrementalRenderDisabled,
	Loader,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import { RenderLineCache } from "./render-line-cache.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

const STEP_BODY_PREFIX = "  └ ";
const STEP_BODY_CONTINUATION = "    ";

/** Keep the Step presentation's width invariant after adding its gutter. */
function clampStepLine(line: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "", false);
}

/** Wrap one output line using pi-tui's grapheme-aware terminal width logic. */
function wrapStepOutput(line: string, width: number): string[] {
	return wrapTextWithAnsi(line.replace(/\t/g, "   "), Math.max(1, Math.floor(width)));
}

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	/** Presentation-only skin; execution and streaming state stay native. */
	private readonly presentation: "native" | "step";
	private readonly excludeFromContext: boolean;
	/** Captured from the native Loader callback so Step does not create another timer. */
	private loaderFrame = "⠋";
	private readonly cache = new RenderLineCache();
	/** Bumped by every state change so the Step card is only rebuilt when it must be. */
	private contentVersion = 0;

	constructor(command: string, ui: TUI, excludeFromContext = false, presentation: "native" | "step" = "native") {
		super();
		this.command = command;
		this.presentation = presentation;
		this.excludeFromContext = excludeFromContext;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Command header
		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Loader
		this.loader = new Loader(
			ui,
			(spinner) => {
				this.loaderFrame = spinner || "⠋";
				// The Step card renders this frame, so it is part of the cache key.
				this.contentVersion += 1;
				return theme.fg(colorKey, spinner);
			},
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);
		this.contentContainer.addChild(this.loader);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/**
	 * Step's direct `!` command uses the same compact tool-card language as
	 * model-invoked `run_command` calls. The component still owns the exact
	 * output/truncation state above; this branch only reshapes those values into
	 * plain rows and leaves the native Pi renderer untouched for the default
	 * presentation.
	 */
	override render(width: number): string[] {
		if (this.presentation !== "step") return super.render(width);

		const safeWidth = Math.max(1, Math.floor(width));
		if (!isIncrementalRenderDisabled() && this.cache.matches(safeWidth, this.contentVersion)) {
			return this.cache.get();
		}
		const commandColor = this.excludeFromContext ? "dim" : "bashMode";
		const paintCommand = (text: string): string => theme.fg(commandColor, theme.bold(text));
		const muted = (text: string): string => theme.fg("muted", text);
		const glyph = this.stepGlyph();
		const headerRows = wrapStepOutput(`$ ${this.command}`, Math.max(1, safeWidth - 2));
		const lines: string[] = headerRows.map((row, index) =>
			index === 0 ? `${glyph} ${paintCommand(row)}` : `  ${paintCommand(row)}`,
		);

		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		// A shell's trailing newline is a terminator, not an extra visible row.
		while (availableLines.at(-1) === "") availableLines.pop();
		const allOutputRows = availableLines.flatMap((line) =>
			wrapStepOutput(line, Math.max(1, safeWidth - visibleWidth(STEP_BODY_PREFIX))),
		);
		const hiddenLineCount = Math.max(0, allOutputRows.length - PREVIEW_LINES);
		const displayLines = this.expanded ? allOutputRows : allOutputRows.slice(-PREVIEW_LINES);
		for (const [index, row] of displayLines.entries()) {
			const prefix = index === 0 ? STEP_BODY_PREFIX : STEP_BODY_CONTINUATION;
			lines.push(muted(`${prefix}${row}`));
		}

		if (this.status === "running") {
			lines.push(muted(`${STEP_BODY_PREFIX}Running... (${keyText("tui.select.cancel")} to cancel)`));
		} else {
			if (hiddenLineCount > 0) {
				const hint = this.expanded ? "to collapse" : "to expand";
				lines.push(
					muted(
						`${STEP_BODY_PREFIX}… +${hiddenLineCount} ${hiddenLineCount === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", hint)})`,
					),
				);
			}
			if (this.status === "cancelled") lines.push(`${muted(STEP_BODY_PREFIX)}${theme.fg("warning", "cancelled")}`);
			if (this.status === "error")
				lines.push(`${muted(STEP_BODY_PREFIX)}${theme.fg("error", `exit ${this.exitCode ?? "?"}`)}`);
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				lines.push(`${muted(STEP_BODY_PREFIX)}${theme.fg("warning", `Full output: ${this.fullOutputPath}`)}`);
			}
		}

		return this.cache.store(safeWidth, this.contentVersion, [
			...lines.map((line) => clampStepLine(line, safeWidth)),
			"",
		]);
	}

	private stepGlyph(): string {
		switch (this.status) {
			case "running":
				return theme.fg(this.excludeFromContext ? "dim" : "accent", this.loaderFrame);
			case "error":
				return theme.fg("error", "✗");
			case "cancelled":
				return theme.fg("warning", "■");
			default:
				return theme.fg("success", "●");
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.contentVersion += 1;
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.contentVersion += 1;
		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const header = new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			if (this.expanded) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
