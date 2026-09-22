/**
 * Scenario matrix for the render equivalence test (see render-equivalence.test.mts).
 *
 * Both presentations of the interactive tree - the default native one and the Step
 * skin - are driven through the same operations against the real TuiMainScreen
 * render loop. The parent test runs this file twice, once with
 * --disable-incremental, and requires the recorded write() sequences to match
 * exactly.
 *
 * Every step is recorded under its own id, so repeated labels no longer collapse
 * into a single frame: the whole ordered sequence is compared.
 *
 * Determinism: nothing in the tree may advance on wall-clock time while frames are
 * recorded. Spinners are scripted and every native Loader animation is stopped
 * right after the tree is built (see stopLoaders), so a recording is identical
 * across runs and across processes.
 */
import {
	type Component,
	Container,
	Editor,
	isIncrementalRenderDisabled,
	Loader,
	setIncrementalRenderDisabled,
	Spacer,
	Text,
	type Terminal,
	TuiMainScreen,
} from "@step-harness/pi-tui";
import type { AssistantMessage } from "@step-harness/providers";
import { AssistantMessageComponent } from "../apps/cli/src/ui/view/transcript/assistant-message.ts";
import { BashExecutionComponent } from "../apps/cli/src/ui/view/transcript/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../apps/cli/src/ui/view/transcript/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../apps/cli/src/ui/view/transcript/compaction-summary-message.ts";
import {
	StepAssistantMessageComponent,
	StepUserMessageComponent,
} from "../apps/cli/src/ui/view/transcript/step-message.ts";
import type { StepToolSpinnerState } from "../apps/cli/src/ui/view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "../apps/cli/src/ui/view/transcript/tool-execution.ts";
import { UserMessageComponent } from "../apps/cli/src/ui/view/transcript/user-message.ts";
import type { BranchSummaryMessage, CompactionSummaryMessage } from "../packages/coding-agent/src/core/messages.ts";
import { getEditorTheme, initTheme } from "../packages/coding-agent/src/theme/theme.ts";
import { setCapabilityOverrides } from "../packages/tui/src/terminal-image.ts";

/** One recorded frame: the writes a single scenario step produced. */
export type RecordedFrame = { id: string; label: string; writes: string[] };

/** The full ordered sequence of frames, in the order the steps ran. */
export type Recording = RecordedFrame[];

export type Diagnostics = {
	dirtyStartAfterTyping: number;
	totalLines: number;
	incremental: boolean;
	frames: number;
	/** Frames that placed a Kitty image; the image lifecycle must produce some. */
	kittyImageFrames: number;
	/** Kitty image delete sequences emitted; the image lifecycle must produce some. */
	kittyDeleteSequences: number;
	/** Frames that composited an overlay; the overlay lifecycle must produce some. */
	overlayFrames: number;
	/** Step messages probed for the renderDirtyStart contract. */
	stepMessagesChecked: number;
	/** Contract violations found by probeRenderDirtyStartContract. */
	dirtyStartViolations: string[];
	/**
	 * Whether the caches added by the incremental change hand back a stable array.
	 * Must be false in the baseline arm: --disable-incremental has to produce a
	 * genuinely cache-free run, otherwise the two arms are not comparable.
	 */
	spacerCacheStable: boolean;
};

const KITTY_IMAGE_PREFIX = "\x1b_Gi=";
const KITTY_DELETE_PREFIX = "\x1b_Ga=d,d=I,i=";
const OVERLAY_BODY = "overlay body";

/** Terminal that records every write and never touches a TTY. */
class RecordingTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	writes: string[] = [];

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

/** Minimal TUI stand-in: components under test only ever call requestRender(). */
function stubTui(terminal: Terminal): unknown {
	return { terminal, requestRender: () => {} };
}

/**
 * Hands back a brand-new array on every render, the way a spinner or a streaming row
 * does. Bumped explicitly by a scenario so the recording stays deterministic.
 */
class ChurningRow {
	private frame = 0;

	bump(): void {
		this.frame += 1;
	}

	render(_width: number): string[] {
		return [`churn frame ${this.frame}`];
	}

	invalidate(): void {}
}

/** Renders a Kitty graphics placeholder block so the image bookkeeping gets exercised. */
class ImageBlock {
	private id: number;
	private rows: number;

	constructor(id: number, rows = 1) {
		this.id = id;
		this.rows = rows;
	}

	setImage(id: number, rows = this.rows): void {
		this.id = id;
		this.rows = rows;
	}

	render(_width: number): string[] {
		const header = this.rows > 1 ? `\x1b_Gi=${this.id},r=${this.rows},v=1,a=T;` : `\x1b_Gi=${this.id},v=1,a=T;`;
		const lines = [`${header}${"A".repeat(8)}\x1b\\`];
		for (let i = 1; i < this.rows; i++) lines.push("");
		return lines;
	}

	invalidate(): void {}
}

/** Spinner whose frame the scenario controls, so the Step card's key is exercised. */
class ScriptedSpinner implements StepToolSpinnerState {
	frame = "⠋";

	elapsedSeconds(_toolCallId: string): number | null {
		return null;
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const TRANSCRIPT_SIZE = 24;

type Presentation = "native" | "step";

/** One interactive tree: the document/chat/status/editor/footer layout regular mode mounts. */
type Tree = {
	tui: TuiMainScreen;
	term: RecordingTerminal;
	chat: Container;
	editor: Editor;
	/** Root children in mount order, so a clear-and-remount step can restore them. */
	roots: Container[];
	spinner: ScriptedSpinner;
	appendedUser: UserMessageComponent | StepUserMessageComponent;
	appendedAssistant: AssistantMessageComponent | StepAssistantMessageComponent;
	appendedTool: ToolExecutionComponent;
	appendedBash: BashExecutionComponent;
	/** A tool card in the MIDDLE of the transcript, with stable children after it. */
	middleTool: ToolExecutionComponent;
	imageBlock: ImageBlock;
	churn: ChurningRow;
};

type Transcript = { bashExecutions: BashExecutionComponent[]; tools: ToolExecutionComponent[] };

function buildTranscript(chat: Container, ui: unknown, presentation: Presentation): Transcript {
	const bashExecutions: BashExecutionComponent[] = [];
	const tools: ToolExecutionComponent[] = [];
	const spinner: ScriptedSpinner | undefined = presentation === "step" ? new ScriptedSpinner() : undefined;
	for (let i = 0; i < TRANSCRIPT_SIZE; i++) {
		switch (i % 6) {
			case 0:
				chat.addChild(
					presentation === "step"
						? new StepUserMessageComponent(`user turn ${i}: please refactor the module and explain why`)
						: new UserMessageComponent(`user turn ${i}: please refactor the module and explain why`),
				);
				break;
			case 1:
				chat.addChild(
					presentation === "step"
						? new StepAssistantMessageComponent(
								assistantMessage(
									`assistant turn ${i}\n\n- updated packages/foo/src/bar.ts\n- added a regression test for the empty input path`,
								),
							)
						: new AssistantMessageComponent(
								assistantMessage(
									`assistant turn ${i}\n\n- updated packages/foo/src/bar.ts\n- added a regression test for the empty input path`,
								),
							),
				);
				break;
			case 2: {
				const tool = new ToolExecutionComponent(
					"read",
					`call-${i}`,
					{ path: `packages/foo/src/bar-${i}.ts` },
					{ presentation, spinner },
					undefined,
					ui as never,
					process.cwd(),
				);
				tools.push(tool);
				chat.addChild(tool);
				break;
			}
			case 3: {
				const bash = new BashExecutionComponent(`echo "turn ${i}"`, ui as never, false, presentation);
				bashExecutions.push(bash);
				chat.addChild(bash);
				break;
			}
			case 4:
				chat.addChild(
					i % 12 === 4
						? new BranchSummaryMessageComponent(
								{
									role: "branchSummary",
									summary: `Summarized ${i} messages from the side branch.`,
									fromId: `msg-${i}`,
									timestamp: 1,
								} satisfies BranchSummaryMessage,
								undefined,
								{ presentation },
							)
						: new CompactionSummaryMessageComponent(
								{
									role: "compactionSummary",
									summary: `Compacted ${i} messages into a shorter context.`,
									tokensBefore: 4321,
									timestamp: 1,
								} satisfies CompactionSummaryMessage,
								undefined,
								{ presentation },
							),
				);
				break;
			default:
				chat.addChild(new Spacer(1));
		}
	}
	return { bashExecutions, tools };
}

/**
 * Stop every Loader animation under the given components. Loader ticks on an 80 ms
 * setInterval and advances a Braille glyph, so which glyph a frame records would
 * otherwise depend on cross-process timing. Stopping them right after construction
 * pins every frame to its initial glyph, which is what makes the recordings
 * reproducible. Must run before the first settle, and again for anything mounted
 * later (the appended children and the remounted transcript).
 */
function stopLoaders(components: readonly Component[]): void {
	const seen = new Set<Container>();
	const walk = (node: Container): void => {
		if (seen.has(node)) return;
		seen.add(node);
		for (const child of node.children) {
			if (child instanceof Loader) child.stop();
			if (child instanceof Container) walk(child);
		}
	};
	for (const component of components) {
		if (component instanceof Container) walk(component);
	}
}

function buildTree(presentation: Presentation): Tree {
	const term = new RecordingTerminal();
	const tui = new TuiMainScreen(term, false, process.cwd());
	const ui = stubTui(term);

	const documentContainer = new Container();
	const chat = new Container();
	documentContainer.addChild(chat);
	const statusContainer = new Container();
	const editorContainer = new Container();
	const footerContainer = new Container();
	statusContainer.addChild(new Text("status: idle", 1, 0));
	footerContainer.addChild(new Text("footer hint", 1, 0));
	const editor = new Editor(ui as never, getEditorTheme());
	editorContainer.addChild(editor);

	const { bashExecutions, tools } = buildTranscript(chat, ui, presentation);
	const churn = new ChurningRow();
	chat.addChild(churn);
	// Bash executions animate a Loader on an 80ms timer, which would make the recording
	// nondeterministic. Settle them; the churn row and the scripted spinner cover the
	// always-dirty cases instead.
	for (const bash of bashExecutions) bash.setComplete(0, false);

	const appendedUser =
		presentation === "step"
			? new StepUserMessageComponent("appended user turn with a longer body that wraps")
			: new UserMessageComponent("appended user turn with a longer body that wraps");
	const appendedAssistant =
		presentation === "step"
			? new StepAssistantMessageComponent(assistantMessage("appended assistant turn"))
			: new AssistantMessageComponent(assistantMessage("appended assistant turn"));
	const spinner = new ScriptedSpinner();
	const appendedTool = new ToolExecutionComponent(
		"read",
		"call-appended",
		{ path: "packages/foo/src/appended.ts" },
		{ presentation, spinner },
		undefined,
		ui as never,
		process.cwd(),
	);
	const appendedBash = new BashExecutionComponent("echo appended", ui as never, false, presentation);
	// The appended children carry their own Loaders; pin them before the first frame.
	stopLoaders([appendedUser, appendedAssistant, appendedTool, appendedBash]);

	const roots = [documentContainer, statusContainer, editorContainer, footerContainer];
	for (const child of roots) {
		tui.addChild(child);
	}
	stopLoaders(roots);
	tui.setFocus(editor);
	tui.start();

	return {
		tui,
		term,
		chat,
		editor,
		roots,
		spinner,
		appendedUser,
		appendedAssistant,
		appendedTool,
		appendedBash,
		// transcript index 14 (14 % 6 === 2): a tool card with 10 transcript rows, the
		// churn row and the appended children still after it.
		middleTool: tools[2]!,
		imageBlock: new ImageBlock(7, 3),
		churn,
	};
}

/**
 * Let the 16ms render throttle drain so scheduled frames land inside this step.
 * Comfortably above the throttle so no frame can spill into the next step.
 */
const settle = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
};

/** Records the write() stream each scenario step produces, keyed by a unique step id. */
function makeRecorder(
	prefix: string,
	tree: Tree,
	recording: Recording,
): (label: string, action: () => void) => Promise<void> {
	let step = 0;
	return async (label: string, action: () => void): Promise<void> => {
		action();
		await settle();
		// One synchronous render, exactly the work a keystroke triggers.
		tree.tui.renderNow(false);
		await settle();
		recording.push({ id: `${prefix}#${step}:${label}`, label, writes: tree.term.writes });
		tree.term.writes = [];
		step += 1;
	};
}

/**
 * renderDirtyStart is only meaningful as an index into the array the component just
 * returned. Step's message components reflow Pi's rows into a differently shaped
 * array, so a mis-reported index could make a parent keep stale content on screen.
 * Probe the END-TO-END property through a real parent Container (the same
 * prefix-reuse path the transcript uses): after a Step message changes, the parent's
 * rendered output must equal the child's own fresh output — no stale prefix, no
 * duplicated rows. This catches a future component that publishes a bad dirty index
 * as well as a Container that fails to clamp it.
 */
function probeRenderDirtyStartContract(chat: Container, width: number): { checked: number; violations: string[] } {
	const violations: string[] = [];
	let checked = 0;
	const isStepMessage = (
		child: Container["children"][number],
	): child is StepUserMessageComponent | StepAssistantMessageComponent =>
		child instanceof StepUserMessageComponent || child instanceof StepAssistantMessageComponent;

	for (const child of chat.children) {
		if (!isStepMessage(child)) continue;
		checked += 1;
		// Render the Step message through a fresh parent so the parent caches the
		// child's current lines, then mutate the child and re-render the parent. The
		// parent reads child.renderDirtyStart to decide how much cached prefix to keep;
		// if that index is wrong (or unclamped) the parent keeps stale/duplicated rows.
		const parent = new Container();
		parent.addChild(child);
		parent.render(width);
		if (child instanceof StepAssistantMessageComponent) {
			child.updateContent(assistantMessage("contract probe: streamed tail line"), true);
		} else {
			child.invalidate();
		}
		const parentAfter = parent.render(width).join("\n");
		const childAfter = child.render(width).join("\n");
		if (parentAfter !== childAfter) {
			violations.push(
				`${child.constructor.name}: parent kept stale lines after the child changed ` +
					`(prefix reuse did not honor the child's new output)`,
			);
		}
	}
	return { checked, violations };
}

function summarize(recording: Recording, presentation: Presentation): Omit<
	Diagnostics,
	| "dirtyStartAfterTyping"
	| "totalLines"
	| "incremental"
	| "stepMessagesChecked"
	| "dirtyStartViolations"
	| "spacerCacheStable"
> {
	let kittyImageFrames = 0;
	let kittyDeleteSequences = 0;
	let overlayFrames = 0;
	for (const frame of recording) {
		if (!frame.id.startsWith(`${presentation}#`)) continue;
		const joined = frame.writes.join("");
		if (joined.includes(KITTY_IMAGE_PREFIX)) kittyImageFrames += 1;
		kittyDeleteSequences += joined.split(KITTY_DELETE_PREFIX).length - 1;
		if (joined.includes(OVERLAY_BODY)) overlayFrames += 1;
	}
	const frames = recording.filter((frame) => frame.id.startsWith(`${presentation}#`));
	return { frames: frames.length, kittyImageFrames, kittyDeleteSequences, overlayFrames };
}

/**
 * Report whether the Spacer cache added by the incremental change hands back a stable
 * array for unchanged input. It is gated on the kill switch, so the baseline arm must
 * report false and the optimized arm true - that is what keeps the two arms comparable
 * instead of both being partially cached.
 */
function probeCacheGating(): { spacerCacheStable: boolean } {
	const spacer = new Spacer(1);
	return { spacerCacheStable: spacer.render(40) === spacer.render(40) };
}

async function runMatrix(prefix: Presentation, tree: Tree, recording: Recording): Promise<Diagnostics> {
	const step = makeRecorder(prefix, tree, recording);
	const { tui, term, chat, editor, spinner } = tree;
	await settle();

	await step("initial-render", () => {});

	await step("typing-static-transcript", () => {
		for (const key of "please refactor the parser") editor.handleInput(key);
	});

	// Proof that the incremental path is live: after typing into a focused editor with a
	// static transcript, the optimized renderer reports a dirty start deep in the buffer
	// (only the tail is re-normalized and diffed) while the baseline reports 0.
	const dirtyStartAfterTyping = tui.renderDirtyStart;

	await step("editing-keys", () => {
		editor.handleInput("\x7f\x7f\x7f");
		editor.handleInput("\n");
		editor.handleInput("second line");
		editor.handleInput("\x1b[A"); // up
		editor.handleInput("\x1b[H"); // home
	});

	await step("append-messages", () => {
		chat.addChild(tree.appendedUser);
		chat.addChild(tree.appendedAssistant);
		chat.addChild(tree.appendedTool);
		chat.addChild(tree.appendedBash);
		chat.addChild(new Spacer(1));
	});

	// The appended assistant streams while three more children follow it, so the
	// middle-of-container dirty path (childStarts recomputation plus the child's own
	// renderDirtyStart) has to hold for a non-terminal child.
	await step("streaming-assistant-mid-transcript", () => {
		tree.appendedAssistant.updateContent(assistantMessage("appended assistant turn, still streaming"), true);
	});
	await step("streaming-assistant-mid-transcript", () => {
		tree.appendedAssistant.updateContent(
			assistantMessage("appended assistant turn, still streaming\n\nand now a second paragraph"),
			true,
		);
	});
	await step("streaming-assistant-mid-transcript", () => {
		tree.appendedAssistant.updateContent(
			assistantMessage("appended assistant turn, still streaming\n\nand now a second paragraph"),
			false,
		);
	});

	// Mutate a child in the MIDDLE of chatContainer: every child after it has to be
	// re-offset, and the children before it must keep their cached prefix.
	await step("middle-dirty-child", () => {
		tree.middleTool.updateArgs({ path: "packages/foo/src/bar-14-renamed.ts" });
	});
	await step("middle-dirty-child", () => {
		tree.middleTool.updateResult({ content: [{ type: "text", text: "middle result row" }], isError: false }, false);
	});
	await step("middle-dirty-child", () => {
		tree.middleTool.setExpanded(true);
	});

	await step("tool-progress", () => {
		tree.appendedTool.updateArgs({ path: "packages/foo/src/appended-2.ts" });
	});
	await step("tool-progress", () => {
		const body = Array.from({ length: 40 }, (_unused, i) => `result row ${i}`).join("\n");
		tree.appendedTool.updateResult({ content: [{ type: "text", text: body }], isError: false }, true);
	});
	await step("tool-progress", () => {
		tree.appendedTool.updateResult({ content: [{ type: "text", text: "ok  12 passed" }], isError: false }, false);
	});
	await step("tool-progress", () => {
		tree.appendedBash.appendOutput("running suite...\n");
		for (let i = 0; i < 30; i++) tree.appendedBash.appendOutput(`line ${i} of output\n`);
		tree.appendedBash.appendOutput("12 passed\n");
		tree.appendedBash.setComplete(0, false);
	});

	await step("expand-collapse", () => {
		tree.appendedTool.setExpanded(true);
	});
	await step("expand-collapse", () => {
		tree.appendedTool.setExpanded(false);
		tree.appendedBash.setExpanded(true);
	});
	await step("expand-collapse", () => {
		tree.appendedBash.setExpanded(false);
	});

	await step("no-op-renders", () => {
		tree.churn.bump();
	});
	await step("no-op-renders", () => {
		editor.handleInput("x");
	});
	await step("no-op-renders", () => {
		editor.handleInput("\x7f");
	});

	await step("spinner-frame", () => {
		spinner.frame = "⠙";
	});
	await step("spinner-frame", () => {
		spinner.frame = "⠹";
	});

	const overlay = new Text("overlay body\nsecond row", 1, 1);
	// Full overlay lifecycle: open, keep typing while it is up, close, keep typing
	// afterwards. The composited frame must never leak into the un-composited one.
	//
	// The overlay is anchored to the top of a viewport taller than the content below
	// the dirty point, so it lands ABOVE the region a prefix-reusing frame would carry
	// over. That is the only shape in which closing the overlay can leave stale rows,
	// and it is what gives the overlayStateChanged guard observable power.
	await step("overlay-lifecycle", () => {
		term.rows = 80;
		tui.showOverlay(overlay, { anchor: "top-left", width: 30 });
	});
	await step("overlay-lifecycle", () => {
		editor.handleInput("y");
	});
	await step("overlay-lifecycle", () => {
		tui.hideOverlay();
	});
	await step("overlay-lifecycle", () => {
		editor.handleInput("z");
	});

	await step("width-change", () => {
		term.columns = 100;
	});
	await step("width-change", () => {
		editor.handleInput("w");
	});
	await step("height-change", () => {
		term.rows = 30;
	});
	await step("height-change", () => {
		editor.handleInput("v");
	});

	await step("shrink-with-clear", () => {
		for (let i = 0; i < 12; i++) chat.removeChild(chat.children[0]);
	});
	tui.setClearOnShrink(false);
	await step("shrink-without-clear", () => {
		for (let i = 0; i < 6; i++) chat.removeChild(chat.children[0]);
	});
	tui.setClearOnShrink(true);

	// Full Kitty image lifecycle through real image lines: none, added, typed over,
	// re-placed under a new id, removed. Each transition has to delete or place the
	// right image ids, which only happens while the image bookkeeping is enabled.
	await step("kitty-image-lifecycle", () => {
		editor.handleInput("before image");
	});
	await step("kitty-image-lifecycle", () => {
		chat.addChild(tree.imageBlock);
	});
	await step("kitty-image-lifecycle", () => {
		editor.handleInput("typing under the image");
	});
	await step("kitty-image-lifecycle", () => {
		tree.imageBlock.setImage(9, 3);
	});
	await step("kitty-image-lifecycle", () => {
		chat.removeChild(tree.imageBlock);
	});
	await step("kitty-image-lifecycle", () => {
		editor.handleInput("after the image");
	});

	await step("theme-invalidate", () => {
		tui.invalidate();
	});

	await step("clear-and-remount", () => {
		tui.clear();
		chat.clear();
		buildTranscript(chat, stubTui(term), prefix === "step" ? "step" : "native");
		for (const child of tree.roots) tui.addChild(child);
		stopLoaders(tree.roots);
	});

	await step("clear-and-remount", () => {
		editor.handleInput("after remount");
	});

	const width = term.columns;
	const totalLines = tui.render(width).length;
	tui.stop();
	const summary = summarize(recording, prefix);
	const contract = probeRenderDirtyStartContract(chat, width);
	return {
		dirtyStartAfterTyping,
		totalLines,
		incremental: !isIncrementalRenderDisabled(),
		...summary,
		stepMessagesChecked: contract.checked,
		dirtyStartViolations: contract.violations,
		...probeCacheGating(),
	};
}

export async function runScenarios(): Promise<{ recording: Recording; diagnostics: Record<string, Diagnostics> }> {
	initTheme("dark");
	setCapabilityOverrides({ images: false, trueColor: true, hyperlinks: true });

	const recording: Recording = [];
	const diagnostics: Record<string, Diagnostics> = {};
	diagnostics.native = await runMatrix("native", buildTree("native"), recording);
	diagnostics.step = await runMatrix("step", buildTree("step"), recording);
	return { recording, diagnostics };
}

if (process.argv.includes("--child")) {
	setIncrementalRenderDisabled(process.argv.includes("--disable-incremental"));
	const { recording, diagnostics } = await runScenarios();
	// Transcript components keep Loader spinner intervals alive; exit once flushed.
	process.stdout.write(
		`<<<EQUIVALENCE-JSON>>>${JSON.stringify({ recording, diagnostics })}<<<EQUIVALENCE-END>>>\n`,
		() => process.exit(0),
	);
}
