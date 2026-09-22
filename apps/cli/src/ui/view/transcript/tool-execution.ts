import type { ToolDefinition, ToolRenderContext } from "@step-harness/coding-agent";
import {
	convertToPng,
	createAllToolDefinitions,
	getTextOutput as getRenderedTextOutput,
	keyHint,
	renderDiff,
	renderToolPath,
	replaceTabs,
	type ToolName,
	theme,
} from "@step-harness/coding-agent";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	isIncrementalRenderDisabled,
	Spacer,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@step-harness/pi-tui";
import { RenderLineCache } from "./render-line-cache.ts";
import { stepErrorHint } from "./step-error-hints.ts";
import { prependAfterTerminalSequences } from "./step-message.ts";
import type { StepToolSpinnerState } from "./step-spinner.ts";

const FALLBACK_PREVIEW_LINES = 10;
const STEP_COLLAPSED_LINES = 5;
const STEP_COLLAPSED_DIFF_LINES = 8;

/** The legacy Step names whose visible headers differ from Pi's native names. */
const STEP_TOOL_NAMES = new Set([
	"list_directory",
	"find_files",
	"search_files",
	"read_file",
	"write_file",
	"edit_file",
	"run_command",
]);

type StepPlanItem = {
	step: string;
	status: "pending" | "in_progress" | "completed";
};

type StepPlan = {
	items: StepPlanItem[];
	explanation?: string;
};

function trimRenderedLine(line: string): string {
	const plain = stripTerminalSequences(line).replace(/\s+$/u, "");
	return truncateToWidth(line, visibleWidth(plain), "", false);
}

function trimRenderedRows(lines: string[]): string[] {
	let first = 0;
	while (first < lines.length && stripTerminalSequences(lines[first] ?? "").trim() === "") first += 1;
	let last = lines.length;
	while (last > first && stripTerminalSequences(lines[last - 1] ?? "").trim() === "") last -= 1;
	return lines.slice(first, last).map(trimRenderedLine);
}

function clampStepLine(line: string, width: number): string {
	// Projected titles/summaries can contain raw argument whitespace after the
	// native renderer has split its rows. One array entry must remain one
	// physical terminal line, or spinner redraws corrupt cursor accounting.
	const singleLine = replaceTabs(line).replace(/[\r\n]+/gu, " ");
	return visibleWidth(singleLine) <= width ? singleLine : truncateToWidth(singleLine, width, "", false);
}

/** Remove Pi's full-width self-shell fill for the Step edit presentation. */
function stripToolShellBackground(line: string): string {
	return line.replace(/\x1b\[(?:48;[0-9;]*|49)m/gu, "");
}

/** Remove a renderer's leading literal-space inset without touching ANSI/OSC. */
function removeLeadingVisibleSpaces(line: string, count: number): string {
	if (count <= 0) return line;
	let index = 0;
	let remaining = count;
	let output = "";
	while (index < line.length) {
		if (line[index] === "\x1b" && line[index + 1] === "[") {
			const match = /^(\x1b\[[0-9;?]*[ -/]*[@-~])/.exec(line.slice(index));
			if (match) {
				output += match[1];
				index += match[1].length;
				continue;
			}
		}
		if (line[index] === "\x1b" && line[index + 1] === "]") {
			let end = index + 2;
			while (end < line.length) {
				if (line[end] === "\x07") {
					end += 1;
					break;
				}
				if (line[end] === "\x1b" && line[end + 1] === "\\") {
					end += 2;
					break;
				}
				end += 1;
			}
			if (end > index + 2 && end <= line.length) {
				output += line.slice(index, end);
				index = end;
				continue;
			}
		}
		if (remaining > 0 && line[index] === " ") {
			remaining -= 1;
			index += 1;
			continue;
		}
		output += line.slice(index);
		break;
	}
	return output;
}

function normalizePlanStatus(status: unknown): StepPlanItem["status"] {
	if (status === "completed" || status === "complete" || status === "done") return "completed";
	if (status === "in_progress" || status === "in-progress" || status === "active") return "in_progress";
	return "pending";
}

function readPlanCandidate(candidate: unknown): StepPlan | undefined {
	if (!Array.isArray(candidate)) return undefined;
	const items: StepPlanItem[] = [];
	for (const raw of candidate) {
		if (typeof raw === "string" && raw.trim()) {
			items.push({ step: raw.trim(), status: "pending" });
			continue;
		}
		if (!raw || typeof raw !== "object") continue;
		const value = raw as Record<string, unknown>;
		const step = value.step ?? value.title ?? value.task ?? value.text;
		if (typeof step !== "string" || step.trim().length === 0) continue;
		items.push({
			step: step.trim(),
			status: normalizePlanStatus(value.status),
		});
	}
	return { items };
}

function extractStepPlan(toolName: string, args: unknown, details: unknown): StepPlan | undefined {
	if (toolName !== "update_plan" && toolName !== "updatePlan" && toolName !== "plan") return undefined;
	const candidates: unknown[] = [];
	for (const value of [args, details]) {
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		candidates.push(record.plan, record.items, record.steps, record.tasks);
		if (record.plan && typeof record.plan === "object") {
			const nested = record.plan as Record<string, unknown>;
			candidates.push(nested.items, nested.steps, nested.tasks);
		}
	}
	for (const candidate of candidates) {
		const plan = readPlanCandidate(candidate);
		if (plan) {
			for (const value of [args, details]) {
				if (
					value &&
					typeof value === "object" &&
					typeof (value as Record<string, unknown>).explanation === "string"
				) {
					plan.explanation = ((value as Record<string, unknown>).explanation as string).trim();
				}
				if (value && typeof value === "object") {
					const nested = (value as Record<string, unknown>).plan;
					if (
						nested &&
						typeof nested === "object" &&
						typeof (nested as Record<string, unknown>).explanation === "string"
					) {
						plan.explanation = ((nested as Record<string, unknown>).explanation as string).trim();
					}
				}
			}
			return plan;
		}
	}
	return undefined;
}

function wrapPlainStepText(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

function readStringArg(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === "string" && record[key].trim().length > 0) {
			return record[key] as string;
		}
	}
	return undefined;
}

function readNumberArg(args: unknown, ...keys: string[]): number | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === "number" && Number.isFinite(record[key])) {
			return record[key] as number;
		}
	}
	return undefined;
}

function readNumberDetail(details: unknown, ...keys: string[]): number | undefined {
	return readNumberArg(details, ...keys);
}

/**
 * Build the old Step-shaped call title while leaving Pi's renderer in charge
 * of the actual call/result body. Pi's shell renderers intentionally use their
 * own labels (`$ command`, `edit path`, ...); the Step model-facing contract
 * uses the names below, so changing the title here is presentation-only.
 */
function formatStepCallTitle(toolName: string, args: unknown, cwd: string): string | undefined {
	if (!STEP_TOOL_NAMES.has(toolName)) return undefined;

	const title = theme.fg("toolTitle", theme.bold(toolName));
	const path = readStringArg(args, "path", "file_path", "directory");
	const command = readStringArg(args, "command");
	const pattern = readStringArg(args, "pattern", "query");
	let argument: string | undefined;
	let pathArgument: string | undefined;
	let argumentSuffix = "";

	switch (toolName) {
		case "run_command":
			argument = command;
			break;
		case "find_files":
			argument = pattern;
			if (path) argumentSuffix = ` in ${path}`;
			break;
		case "search_files":
			argument = pattern ? `/${pattern}/` : undefined;
			if (path) argumentSuffix = ` in ${path}`;
			break;
		case "list_directory":
			argument = path ?? ".";
			pathArgument = argument;
			break;
		case "read_file": {
			argument = path;
			pathArgument = path;
			const start = readNumberArg(args, "start_line", "offset");
			const end = readNumberArg(args, "end_line");
			const limit = readNumberArg(args, "limit");
			if (argument && start !== undefined && end !== undefined) {
				argumentSuffix = `:${start}-${end}`;
			} else if (argument && start !== undefined && limit !== undefined) {
				argumentSuffix = `:${start}-${start + Math.max(0, limit - 1)}`;
			}
			break;
		}
		case "write_file":
		case "edit_file":
			argument = path;
			pathArgument = path;
			break;
		default:
			break;
	}

	if (!argument) return title;
	// Path arguments still use Pi's hyperlink/path shortening helper. The other
	// arguments intentionally stay muted: the surrounding status glyph/name is
	// the Step accent and native renderer syntax remains in the body.
	const argumentText = pathArgument
		? `${renderToolPath(pathArgument, theme, cwd)}${theme.fg("warning", argumentSuffix)}`
		: `${theme.fg("toolOutput", argument)}${theme.fg("toolOutput", argumentSuffix)}`;
	return `${title}(${argumentText})`;
}

/**
 * Derive the compact one-line summaries that the former Step projection put
 * beside settled context-fetching tools. Native Pi renderers intentionally hide
 * those result bodies while collapsed; keeping the summary in this presentation
 * branch restores the old visual density without changing the result payload.
 */
function formatStepCollapsedSummary(
	toolName: string,
	args: unknown,
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean },
	showImages: boolean,
): string | undefined {
	if (result.isError) return undefined;
	const details = result.details;
	const path = readStringArg(args, "path", "file_path", "directory") ?? ".";
	const output = getRenderedTextOutput(result, showImages).trim();

	switch (toolName) {
		case "read_file": {
			const outputCount = output ? output.split(/\r?\n/u).filter((line) => line.trim().length > 0).length : 0;
			const start =
				readNumberDetail(details, "startLine", "effectiveStartLine") ??
				readNumberArg(args, "start_line", "offset") ??
				1;
			const detailEnd = readNumberDetail(details, "endLine", "effectiveEndLine");
			const requestedEnd = readNumberArg(args, "end_line");
			const requestedLimit = readNumberArg(args, "limit", "max_lines");
			const rangeCount =
				detailEnd !== undefined && detailEnd >= start
					? detailEnd - start + 1
					: requestedEnd !== undefined && requestedEnd >= start
						? requestedEnd - start + 1
						: requestedLimit !== undefined
							? requestedLimit
							: undefined;
			const count =
				readNumberDetail(details, "selectedLines", "returnedLines", "outputLines") ?? rangeCount ?? outputCount;
			if (count <= 0) return `Read ${path} (empty)`;
			const end = detailEnd ?? requestedEnd ?? start + count - 1;
			return `Read ${path} lines ${start}-${end} (${count} lines)`;
		}
		case "list_directory": {
			const returned = readNumberDetail(details, "returnedEntries") ?? (output ? output.split(/\r?\n/u).length : 0);
			const total = readNumberDetail(details, "totalEntries") ?? returned;
			return `Listed ${path} (${returned}/${total} entries)`;
		}
		case "find_files": {
			const returned = readNumberDetail(details, "returnedFiles") ?? (output ? output.split(/\r?\n/u).length : 0);
			const matched = readNumberDetail(details, "matchedFiles") ?? returned;
			const pattern = readStringArg(args, "pattern") ?? "files";
			return `Found ${returned}/${matched} files matching '${pattern}'`;
		}
		case "search_files": {
			const matches =
				readNumberDetail(details, "matches") ?? (output ? output.split(/\r?\n/u).filter(Boolean).length : 0);
			const files = readNumberDetail(details, "filesMatched") ?? countSearchFiles(output);
			const pattern = readStringArg(args, "pattern") ?? "";
			return `Found ${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"} for '${pattern}'`;
		}
		default:
			return undefined;
	}
}

function countSearchFiles(output: string): number {
	const files = new Set<string>();
	for (const line of output.split(/\r?\n/u)) {
		const match = /^(.*?):\d+(?:[-:])\s/u.exec(line.trim());
		if (match?.[1]) files.add(match[1]);
	}
	return files.size;
}

/** Normalize Pi's renderer-specific expansion copy to the Step transcript form. */
function normalizeStepExpandHint(line: string): string {
	const plain = stripTerminalSequences(line).trim();
	const match = /^\.\.\. \((\d+) (?:earlier|more) lines?,.*to expand\)$/u.exec(plain);
	if (!match) return line;
	const count = Number(match[1]);
	return theme.fg(
		"muted",
		`… +${count} ${count === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", "to expand")})`,
	);
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	/** Presentation-only shell; tool execution and renderer callbacks stay native. */
	presentation?: "native" | "step";
	/** Shared Step animation clock; omitted for the native Pi presentation. */
	spinner?: StepToolSpinnerState;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	/** References kept separate so the Step shell can add its connector between call/result. */
	private stepCallComponent?: Component;
	private stepResultComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private readonly presentation: "native" | "step";
	private readonly cache = new RenderLineCache();
	/** Bumped by every state change so the Step card is only rebuilt when it must be. */
	private contentVersion = 0;
	private readonly spinner?: StepToolSpinnerState;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.presentation = options.presentation ?? "native";
		this.spinner = options.spinner;
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		if (this.presentation !== "step") {
			this.addChild(new Spacer(1));
		}

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		const shellPaddingX = this.presentation === "step" ? 0 : 1;
		const shellPaddingY = this.presentation === "step" ? 0 : 1;
		const initialBackground =
			this.presentation === "step" ? undefined : (text: string) => theme.bg("toolPendingBg", text);
		this.contentBox = new Box(shellPaddingX, shellPaddingY, initialBackground);
		this.contentText = new Text("", shellPaddingX, shellPaddingY, initialBackground);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
			}>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.contentVersion += 1;
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.presentation !== "step") {
			if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
				const contentLines = this.selfRenderContainer.render(width);
				if (contentLines.length === 0 && this.imageComponents.length === 0) {
					return [];
				}

				const lines: string[] = [];
				if (contentLines.length > 0) lines.push("");
				lines.push(...contentLines);
				this.appendImages(lines, width);
				return lines;
			}
			return super.render(width);
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			return this.renderStepSelfLines(width);
		}
		return this.renderStepDefaultLines(width);
	}

	private appendImages(lines: string[], width: number): void {
		for (let i = 0; i < this.imageComponents.length; i++) {
			const spacer = this.imageSpacers[i];
			if (spacer) lines.push(...spacer.render(width));
			const imageComponent = this.imageComponents[i];
			if (imageComponent) lines.push(...imageComponent.render(width));
		}
	}

	/**
	 * Content version for the Step card. The spinner frame and the elapsed clock move
	 * without any component state changing, so they are part of the key. A string key
	 * avoids fragile numeric bit-packing: any distinct (version, elapsed, frame) triple
	 * yields a distinct key regardless of how large the frame code point or elapsed
	 * seconds grow.
	 */
	private stepCacheKey(): string {
		const spinner = this.spinner;
		const frame = spinner?.frame ?? "";
		const elapsed = spinner?.elapsedSeconds(this.toolCallId) ?? -1;
		return `${this.contentVersion}|${Math.max(0, elapsed)}|${frame}`;
	}

	private renderStepDefaultLines(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const key = this.stepCacheKey();
		if (!isIncrementalRenderDisabled() && this.cache.matches(safeWidth, key)) {
			return this.cache.get();
		}
		return this.cache.store(safeWidth, key, this.buildStepDefaultLines(width));
	}

	private renderStepSelfLines(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const key = this.stepCacheKey();
		if (!isIncrementalRenderDisabled() && this.cache.matches(safeWidth, key)) {
			return this.cache.get();
		}
		return this.cache.store(safeWidth, key, this.buildStepSelfLines(width));
	}

	/** Render a Step card while leaving call/result content to Pi's components. */
	private buildStepDefaultLines(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const plan = extractStepPlan(this.toolName, this.args, this.result?.details);
		if (plan && !this.result?.isError) {
			return this.renderStepPlan(plan, safeWidth);
		}
		const callWidth = Math.max(1, safeWidth - 2);
		const bodyWidth = Math.max(1, safeWidth - 4);

		let callLines: string[];
		let resultLines: string[] = [];
		if (this.hasRendererDefinition()) {
			callLines = this.stepCallComponent ? trimRenderedRows(this.stepCallComponent.render(callWidth)) : [];
			// Failed runs bypass the result renderer: native renderers format
			// success payloads ("3 matches") and would bury the actual error
			// text — the why must never be replaced by a success-shaped body.
			resultLines =
				!this.isPartial && this.result?.isError
					? this.renderStepFallbackOutput()
					: this.getResultRenderer()
						? this.stepResultComponent
							? trimRenderedRows(this.stepResultComponent.render(bodyWidth))
							: []
						: this.renderStepFallbackOutput();
		} else {
			const fallback = trimRenderedRows(this.contentText.render(safeWidth));
			callLines = fallback.length > 0 ? [fallback[0]!] : [];
			resultLines = this.renderStepFallbackOutput(fallback.slice(1));
		}

		if (callLines.length === 0) callLines = [theme.fg("toolTitle", theme.bold(this.toolName))];
		// Some native call renderers (notably `write`) include a preview below
		// their header. Treat those rows as payload so the Step connector remains
		// stable and the preview participates in the same collapse budget as a
		// result renderer's output.
		if (callLines.length > 1) {
			resultLines = [...callLines.slice(1), ...resultLines];
			callLines = [callLines[0]!];
		}
		const stepTitle = formatStepCallTitle(this.toolName, this.args, this.cwd);
		if (stepTitle !== undefined) {
			// Keep the native renderer's body/state, but use the exact Step tool
			// contract in the visible invocation row.
			callLines[0] = stepTitle;
		}

		// Settled discovery calls use the old Step one-line summary. This is a
		// presentation decision only: the full native result remains available via
		// the global expand action and in the persisted transcript.
		if (!this.isPartial && this.result && !this.result.isError && !this.expanded) {
			const summary = formatStepCollapsedSummary(this.toolName, this.args, this.result, this.showImages);
			if (summary !== undefined) {
				const collapsed = `${this.presentationGlyph()} ${theme.fg("toolTitle", theme.bold(this.toolName))} ${theme.fg("muted", `· ${summary}`)}`;
				return [clampStepLine(collapsed, safeWidth), ""];
			}
		}
		const glyph = this.presentationGlyph();
		const header = callLines.map((line, index) => {
			const hasGlyph = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●✗■]/u.test(stripTerminalSequences(line).trimStart());
			const prefix = index === 0 && !hasGlyph ? `${glyph} ` : index === 0 ? "" : "  ";
			return clampStepLine(prependAfterTerminalSequences(line, prefix), safeWidth);
		});
		if (header.length > 0) {
			header[0] = clampStepLine(`${header[0]}${this.stepElapsedSuffix()}`, safeWidth);
		}

		// Built-in read intentionally hides result rows while collapsed. Keep a
		// discoverable expansion affordance in the Step header when there is output
		// behind that native renderer decision.
		if (!this.expanded && resultLines.length === 0 && this.toolName === "read" && this.hasTextResult()) {
			const hint = ` ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
			header[0] = clampStepLine(`${header[0]}${hint}`, safeWidth);
		}

		const body = this.buildStepBodyLines(resultLines, bodyWidth);
		// 错误呈现三要素收尾：what（✗ 标题行）/ why（错误文本）之后补 how——
		// 一行可执行的恢复建议，让失败不只是被报告，还能被处理。
		if (!this.isPartial && this.result?.isError) {
			const hint = stepErrorHint(this.getTextOutput());
			body.push(clampStepLine(`    ${theme.fg("muted", `↳ ${hint}`)}`, safeWidth));
		}
		const lines = [...header, ...body];
		this.appendImages(lines, safeWidth);
		return lines.length > 0 ? [...lines, ""] : [];
	}

	/** Self-shell tools own their inner framing; only add the Step status gutter. */
	private buildStepSelfLines(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		let lines = trimRenderedRows(this.selfRenderContainer.render(safeWidth));
		if (lines.length === 0) {
			const output: string[] = [];
			this.appendImages(output, safeWidth);
			return output;
		}

		// Pi's built-in edit shell uses a one-cell Box inset. Remove that inset so
		// the Step glyph occupies the same column as ordinary tool cards.
		if (this.toolName === "edit" || this.toolName === "edit_file") {
			lines = lines.map((line) => stripToolShellBackground(removeLeadingVisibleSpaces(line, 1)));
		}
		const stepTitle = formatStepCallTitle(this.toolName, this.args, this.cwd);
		if (stepTitle !== undefined && lines.length > 0) {
			lines[0] = stepTitle;
		}

		const firstPlain = stripTerminalSequences(lines[0] ?? "").trimStart();
		const hasGlyph = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●✗■]/u.test(firstPlain);
		if (!hasGlyph) {
			lines[0] = prependAfterTerminalSequences(lines[0] ?? "", `${this.presentationGlyph()} `);
		}
		if (lines.length > 0) {
			lines[0] = clampStepLine(`${lines[0]}${this.stepElapsedSuffix()}`, safeWidth);
		}

		// Edit's self renderer contains a header followed by a diff. Give that
		// built-in payload the same connector as ordinary Step cards. Arbitrary
		// extension self-shells remain untouched after their status gutter.
		if ((this.toolName === "edit" || this.toolName === "edit_file") && lines.length > 1) {
			const bodyStart = lines.findIndex(
				(line, index) => index > 0 && stripTerminalSequences(line).trim().length > 0,
			);
			if (bodyStart > 0) {
				const body = this.buildStepBodyLines(lines.slice(bodyStart), Math.max(1, safeWidth - 4));
				lines = [lines[0]!, ...body];
			}
		}

		const output = lines.map((line) => clampStepLine(line, safeWidth));
		this.appendImages(output, safeWidth);
		return [...output, ""];
	}

	private buildStepBodyLines(resultLines: string[], bodyWidth: number): string[] {
		let lines = resultLines
			.filter((line) => stripTerminalSequences(line).trim().length > 0)
			.map(normalizeStepExpandHint);
		const diffText =
			this.result?.details && typeof this.result.details.diff === "string" ? this.result.details.diff : undefined;
		if (diffText && !lines.join("\n").includes(diffText.split(/\r?\n/u)[0] ?? "")) {
			lines = [...lines, ...renderDiff(diffText).split("\n")];
		}

		if (lines.length === 0) return [];
		if (!this.expanded && !lines.some((line) => stripTerminalSequences(line).includes("to expand"))) {
			const budget = diffText ? STEP_COLLAPSED_DIFF_LINES : STEP_COLLAPSED_LINES;
			if (lines.length > budget) {
				const head = Math.max(1, Math.floor((budget - 1) / 2));
				const tail = Math.max(1, budget - 1 - head);
				const hidden = lines.length - head - tail;
				lines = [
					...lines.slice(0, head),
					`${theme.fg("muted", `… +${hidden} ${hidden === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", "to expand")})`)}`,
					...lines.slice(-tail),
				];
			}
		}

		return lines.map((line, index) => {
			const connector = index === 0 ? "  └ " : "    ";
			return clampStepLine(prependAfterTerminalSequences(line, connector), bodyWidth + 4);
		});
	}

	private hasTextResult(): boolean {
		return this.result?.content.some((content) => content.type === "text" && Boolean(content.text?.trim())) ?? false;
	}

	private renderStepFallbackOutput(existing?: string[]): string[] {
		if (!this.result) return existing ?? [];
		const output = this.getTextOutput();
		if (!output) return existing ?? [];
		// Failed runs paint their output with the error color so the why is
		// scannable at a glance, mirroring the ✗ glyph in the header row.
		const paint = this.result.isError
			? (line: string) => theme.fg("error", line)
			: (line: string) => theme.fg("toolOutput", line);
		return output.split(/\r?\n/u).map(paint);
	}

	private renderStepPlan(plan: StepPlan, width: number): string[] {
		const bodyWidth = Math.max(1, width - 4);
		const body: string[] = [];
		if (plan.explanation) {
			body.push(
				...wrapPlainStepText(plan.explanation, bodyWidth).map((line) => theme.italic(theme.fg("muted", line))),
			);
		}
		if (plan.items.length === 0) {
			body.push(theme.italic(theme.fg("muted", "(no steps provided)")));
		} else {
			for (const item of plan.items) {
				const itemRows = wrapPlainStepText(item.step, Math.max(1, bodyWidth - 2));
				const { glyph, paint } =
					item.status === "completed"
						? {
								glyph: theme.fg("muted", "✔"),
								paint: (text: string) => theme.strikethrough(theme.fg("muted", text)),
							}
						: item.status === "in_progress"
							? {
									glyph: theme.fg("accent", "□"),
									paint: (text: string) => theme.bold(theme.fg("accent", text)),
								}
							: {
									glyph: theme.fg("muted", "□"),
									paint: (text: string) => theme.fg("muted", text),
								};
				body.push(`${glyph} ${paint(itemRows[0] ?? "")}`);
				body.push(...itemRows.slice(1).map((line) => `  ${paint(line)}`));
			}
		}

		const lines = [
			clampStepLine(`${theme.fg("muted", "• ")}${theme.bold("Updated Plan")}`, width),
			...body.map((line, index) => clampStepLine(`${index === 0 ? "  └ " : "    "}${line}`, width)),
		];
		this.appendImages(lines, width);
		return [...lines, ""];
	}

	private presentationGlyph(): string {
		if (this.isPartial || !this.result) return theme.fg("accent", this.spinner?.frame ?? "⠋");
		if (this.result.isError) return theme.fg("error", "✗");
		return theme.fg("success", "●");
	}

	/** Running tool rows carry the same elapsed suffix as the former Step TUI. */
	private stepElapsedSuffix(): string {
		if (!this.isPartial && this.result) return "";
		const seconds = this.spinner?.elapsedSeconds(this.toolCallId) ?? null;
		return seconds !== null && seconds >= 1 ? theme.fg("muted", ` · ${seconds}s`) : "";
	}

	private updateDisplay(): void {
		this.contentVersion += 1;
		const bgFn =
			this.presentation === "step"
				? undefined
				: this.isPartial
					? (text: string) => theme.bg("toolPendingBg", text)
					: this.result?.isError
						? (text: string) => theme.bg("toolErrorBg", text)
						: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		this.stepCallComponent = undefined;
		this.stepResultComponent = undefined;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				const component = this.createCallFallback();
				this.callRendererComponent = component;
				this.stepCallComponent = component;
				renderContainer.addChild(component);
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					this.stepCallComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					const component = this.createCallFallback();
					this.callRendererComponent = component;
					this.stepCallComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						this.resultRendererComponent = component;
						this.stepResultComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{
								content: this.result.content as any,
								details: this.result.details,
							},
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						this.stepResultComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						const component = this.createResultFallback();
						if (component) {
							this.resultRendererComponent = component;
							this.stepResultComponent = component;
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.callRendererComponent = undefined;
			this.resultRendererComponent = undefined;
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
