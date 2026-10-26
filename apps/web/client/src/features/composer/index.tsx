/**
 * Composer feature slot, mounted by App.tsx inside `.composer-zone`:
 * `form#composer.composer` (legacy index.html 847-1007, app.js 2354-2985,
 * 3256-3273, 3508-3549, 3576-3583, 3818-3885).
 */

import "./composer.css";

import {
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { renderMarkdown } from "../../lib/markdown";
import {
	activeCwd,
	copyText,
	interruptCurrent,
	sessionTitle,
	showError,
	timelineFromEntries,
} from "../../state/session";
import { getState, type ModeId, setUi, useAppStore } from "../../state/store";
import type { SessionSnapshot, TreeEntry } from "../../state/types";
import { Icon, IconButton, MarkdownView, Tooltip } from "../../ui";
import { openFeedback } from "../conversation";
import { rewritePrompt } from "../conversation/actions";
import { askSideQuestion } from "../files";
import { MicButton } from "../voice";
import { AttachmentList } from "./Attachments";
import {
	type ContextPackage,
	chooseMode,
	clearModes,
	modePrefix,
	packageSessionContext,
	type StagedPick,
	sendMessage,
	stageCommandLead,
	syncStagedModeLead,
	turnActive,
	updateQueued,
} from "./actions";
import { FileMenu, type FileMenuHandle } from "./FileMenu";
import { type FileQuery, fileCompletionText, sameFileQuery } from "./file-completion";
import { ModelMenu } from "./ModelMenu";
import { MODES, modeFromCommand } from "./modes";
import { PerformanceBar } from "./PerformanceBar";
import { PlanStrip } from "./PlanStrip";
import { PlusMenu } from "./PlusMenu";
import { PolicyMenu } from "./PolicyMenu";
import { PromptInput } from "./PromptInput";
import {
	insertLineBreak,
	insertModeLead,
	insertTextAtCaret,
	placeCaretAtEnd,
	promptFileQuery,
	promptFiles,
	promptText,
	removeModeLead,
	replaceFileQuery,
	restorePrompt,
	setPromptText,
	snapshotPrompt,
	waitForUploads,
} from "./prompt-editor";
import { QueueDock } from "./QueueDock";
import { type SlashItem, SlashMenu, type SlashMenuHandle, slashQuery } from "./SlashMenu";

export { ImagePreview } from "./ImagePreview";
// The conversation's command-echo rows reuse the composer's command icon map
// and mode metadata, so a command looks the same in the flow as at the prompt.
export { commandLeadIcon, MODES, modeFromCommand } from "./modes";
export { SelectionDialog } from "./SelectionDialog";
export { TextInputDialog } from "./TextInputDialog";

export interface ComposerProps {
	/**
	 * `#workspaceControl` from the workspace feature: a compact folder pill just
	 * above `.composer-card`, outside it. App passes it in so the composer does
	 * not import the workspace feature.
	 */
	readonly workspaceControl?: ReactNode;
	/**
	 * `#branchControl` from the git branch feature: the branch pill beside the
	 * workspace pill. Passed in for the same reason as `workspaceControl`.
	 */
	readonly branchControl?: ReactNode;
	/** `edit`: the stripped-down instance that rewrites a message in place. */
	readonly variant?: "full" | "edit";
}

/** The three listbox popovers; only one is open at a time (legacy `setupPopover` `open()`). */
type ComposerMenu = "policy" | "plus" | "model";

export function Composer({ workspaceControl, branchControl, variant = "full" }: ComposerProps) {
	const t = useT();
	const form = useRef<HTMLFormElement | null>(null);
	const prompt = useRef<HTMLDivElement | null>(null);
	const stageFiles = useRef<((files: readonly File[]) => void) | null>(null);
	const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
	const [query, setQuery] = useState<string | null>(null);
	const slash = useRef<SlashMenuHandle | null>(null);
	const files = useRef<FileMenuHandle | null>(null);
	const [pathQuery, setPathQuery] = useState<FileQuery | null>(null);
	const lastPathQuery = useRef<FileQuery | null>(null);
	const composing = useRef(false);
	const cwd = useAppStore(activeCwd);
	const selection = useAppStore((state) => `${state.current?.id ?? "draft"}\0${activeCwd(state)}`);
	const status = useAppStore((state) => state.current?.status);
	const waiting = status === "waiting";
	/** During a turn Enter queues the message and Cmd/Ctrl+Enter steers it (see `sendMessage`). */
	const active = useAppStore(turnActive);
	const queuedCount = useAppStore((state) => state.current?.queuedMessages?.length ?? 0);
	/*
	 * Whether `#prompt` holds text to send. While a turn runs, `#sendButton` is the stop button
	 * until the user types; then it queues the message. Edits that bypass `input`
	 * (`setPromptText`, `restorePrompt`) call `syncHasText` themselves.
	 */
	const [hasText, setHasText] = useState(false);
	/** `#prompt` swapped for its rendered Markdown (the editor stays mounted underneath). */
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewSource, setPreviewSource] = useState("");
	const previewing = useRef(false);
	const previewRef = useRef<HTMLDivElement | null>(null);
	/** Closing the preview asks for the editor back: focus waits for the commit that unhides it. */
	const returnToEditor = useRef(false);
	/** Shift+Enter leaves the preview: the editor gets the newline it asked for once it is visible. */
	const newlineOnReturn = useRef(false);
	/** Picked other-session contexts, one removable chip each, sent with the next message. */
	const [contextPackages, setContextPackages] = useState<readonly ContextPackage[]>([]);
	/** Picked skills and plugins, one light-purple icon chip each, sent with the next message. */
	const [stagedPicks, setStagedPicks] = useState<readonly StagedPick[]>([]);
	// Single-select and single-shot: at most one mode rides the next message.
	const modes = useAppStore((state) => state.modes);
	const activeMode = (Object.keys(modes) as ModeId[]).find((id) => modes[id]);
	// The staged mode's presentation: the card's accent, the lead chip and the
	// prompt's placeholder all read this entry (see modes.ts).
	const activeModeMeta = activeMode ? MODES.find((mode) => mode.id === activeMode) : undefined;
	/*
	 * The staged mode is the prompt's leading chip — icon + label at the line
	 * start, part of the text, deleted with a backspace (the input sync in
	 * `onValueInput` then unstages it). The chip renders the command; the send
	 * itself still leads the message with it (see `modePrefix`).
	 */
	useEffect(() => {
		const editor = prompt.current;
		if (!editor) return;
		if (activeModeMeta)
			insertModeLead(editor, {
				id: activeModeMeta.id,
				icon: activeModeMeta.icon,
				label: t(activeModeMeta.labelKey),
				command: modePrefix(activeModeMeta.id).trim(),
			});
		else removeModeLead(editor);
	}, [activeModeMeta, t]);
	/** Back to the editor, caret after the draft. */
	const closePreview = useCallback(() => {
		previewing.current = false;
		returnToEditor.current = true;
		setPreviewOpen(false);
	}, []);
	/** Show the draft as rendered Markdown; the menus belong to the editor and close. */
	const openPreview = useCallback(() => {
		const editor = prompt.current;
		if (!editor) return;
		const text = promptText(editor);
		if (!text.trim()) return;
		setPreviewSource(text);
		previewing.current = true;
		setPreviewOpen(true);
		setQuery(null);
		setPathQuery(null);
		lastPathQuery.current = null;
		setUi({ slashMenu: null, fileCompletionOpen: false });
	}, []);
	const togglePreview = useCallback(() => {
		if (previewing.current) closePreview();
		else openPreview();
	}, [openPreview, closePreview]);
	/** Drop the preview without moving focus: the prompt is being cleared for a send. */
	const dismissPreview = useCallback(() => {
		previewing.current = false;
		returnToEditor.current = false;
		setPreviewOpen(false);
	}, []);
	const syncHasText = useCallback(() => {
		const editor = prompt.current;
		const text = editor ? promptText(editor) : "";
		setHasText(Boolean(text.trim()));
		if (!previewing.current) return;
		// Edits that bypass `input` (voice, menus, a failed send) still refresh the preview;
		// an emptied prompt closes it rather than showing a stale render.
		if (text.trim()) setPreviewSource(text);
		else closePreview();
	}, [closePreview]);
	useEffect(() => {
		if (previewOpen) {
			previewRef.current?.focus();
			return;
		}
		// The editor stays `visibility: hidden` until this commit clears `data-preview`,
		// so it can only take focus — and the caret — here.
		if (!returnToEditor.current) return;
		returnToEditor.current = false;
		const editor = prompt.current;
		if (!editor) return;
		editor.focus();
		placeCaretAtEnd(editor);
		if (newlineOnReturn.current) {
			newlineOnReturn.current = false;
			insertLineBreak(editor);
		}
	}, [previewOpen]);
	/*
	 * A dictated transcript lands at the caret like typed text, with a space
	 * keeping it off the word before it, and the send state re-syncs — the
	 * same path `setPromptText` takes for edits that bypass `input`.
	 */
	const insertVoiceTranscript = useCallback(
		(text: string) => {
			const editor = prompt.current;
			if (!editor || !text) return;
			editor.focus();
			const existing = promptText(editor);
			insertTextAtCaret(editor, existing && !/\s$/u.test(existing) ? ` ${text}` : text);
			syncHasText();
		},
		[syncHasText],
	);
	const edit = variant === "edit";
	// The in-place editor rewrites one message; it is never the run's stop button.
	const stopMode = !edit && status === "running" && !hasText;
	/* Rewriting: the edit instance starts from the message's text and submits a fork. */
	const editingPrompt = useAppStore((state) => state.ui.editingPrompt);
	const editLoaded = useRef(false);
	useEffect(() => {
		if (!edit || !editingPrompt || editLoaded.current) return;
		editLoaded.current = true;
		const editor = prompt.current;
		if (!editor) return;
		// Focus before filling: setPromptText parks the caret at the end only when
		// the editor already holds focus, so a fill-then-focus leaves it at the start.
		editor.focus();
		setPromptText(editor, editingPrompt.text);
		setHasText(Boolean(editingPrompt.text.trim()));
	}, [edit, editingPrompt]);

	const menu = (name: ComposerMenu) => ({
		open: openMenu === name,
		onOpen: () => setOpenMenu(name),
		onClose: () => setOpenMenu((value) => (value === name ? null : value)),
	});

	const syncFileQuery = useCallback(() => {
		const editor = prompt.current;
		if (!editor || document.activeElement !== editor) {
			// Dismissal survives returning focus to the same unchanged token.
			setUi({ fileCompletionOpen: false });
			return;
		}
		const next = composing.current ? null : promptFileQuery(editor);
		const changed = !sameFileQuery(lastPathQuery.current, next);
		lastPathQuery.current = next;
		setPathQuery((current) => (sameFileQuery(current, next) ? current : next));
		if (!next) setUi({ fileCompletionOpen: false });
		else if (changed) setUi({ fileCompletionOpen: true, slashMenu: null });
	}, []);

	const onValueInput = useCallback(
		(value: string) => {
			// Backspacing over the staged mode's lead chip drops the mode, like deleting its command.
			if (prompt.current) syncStagedModeLead(prompt.current);
			setHasText(Boolean(value.trim()));
			if (previewing.current) {
				// An undo can empty the draft while the preview owns the screen; it closes rather
				// than leaving an empty rendered pane over a hidden editor.
				if (value.trim()) setPreviewSource(value);
				else closePreview();
			}
			const next = slashQuery(value);
			setQuery(next);
			const view = getState().ui.slashMenu;
			if (next !== null) setUi({ slashMenu: "commands", fileCompletionOpen: false });
			else if (view) setUi({ slashMenu: null });
			syncFileQuery();
		},
		[syncFileQuery, closePreview],
	);

	const onCompositionChange = useCallback((active: boolean) => {
		composing.current = active;
		if (active) {
			lastPathQuery.current = null;
			setPathQuery(null);
			setUi({ fileCompletionOpen: false });
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: session/workspace replacement invalidates the active token.
	useEffect(() => {
		lastPathQuery.current = null;
		setPathQuery(null);
		setUi({ fileCompletionOpen: false });
		// The preview belongs to the draft it showed; another session or workspace starts in the editor.
		previewing.current = false;
		setPreviewOpen(false);
		return () => setUi({ fileCompletionOpen: false });
	}, [selection]);

	useEffect(() => {
		if (waiting) setUi({ fileCompletionOpen: false });
	}, [waiting]);

	const pickFile = useCallback(
		(entry: TreeEntry, expected: FileQuery, drill: boolean) => {
			const editor = prompt.current;
			if (!editor || activeCwd() !== cwd || !getState().ui.fileCompletionOpen) return;
			if (!replaceFileQuery(editor, expected, fileCompletionText(entry, expected.quoted, drill))) {
				syncFileQuery();
				return;
			}
			if (!drill) setUi({ fileCompletionOpen: false });
		},
		[syncFileQuery, cwd],
	);

	const pickSlash = useCallback(
		(item: SlashItem) => {
			const editor = prompt.current;
			if (!editor) return;
			setQuery(null);
			setPathQuery(null);
			lastPathQuery.current = null;
			setUi({ fileCompletionOpen: false });
			if (item.kind === "mcp") {
				// A status view, not a prompt: nothing is sent.
				setPromptText(editor, "");
				setHasText(false);
				setUi({ slashMenu: "mcp" });
				clearModes();
			} else if (item.kind === "feedback") {
				// The product's own feedback dialog, which POSTs to the same kernel
				// submission the `/feedback` command uses. Nothing is sent as a prompt.
				setPromptText(editor, "");
				setHasText(false);
				setUi({ slashMenu: null });
				clearModes();
				openFeedback();
			} else {
				// The kernel runs `/<command> [args]` and expands `/skill:<name> [request]`
				// into the skill's instructions on send. The pick becomes the prompt's
				// lead chip — the same chip typing that command produces.
				setPromptText(editor, "");
				stageCommandLead(editor, item.kind === "command" ? `/${item.key}` : `/skill:${item.key}`);
				syncHasText();
				setUi({ slashMenu: null });
			}
			editor.focus();
			placeCaretAtEnd(editor);
		},
		[syncHasText],
	);

	/** True from Enter until the prompt is cleared, so a second Enter while uploads finish sends nothing. */
	const sending = useRef(false);
	const submit = async (steer: boolean) => {
		const editor = prompt.current;
		if (!editor || sending.current) return;
		sending.current = true;
		try {
			// A chip has its upload id only once its upload settles; a failed one is removed.
			await waitForUploads();
			const text = promptText(editor).trim();
			const files = promptFiles(editor);
			if (!text) return;
			// A send starts from the draft, not from its render: the preview goes either way.
			dismissPreview();
			// `/btw` is a side question, not a message: it opens its own rail tab and
			// never becomes a user turn (the kernel command is the same one the CLI runs).
			const sideQuestion = /^\/btw(?:\s+([\s\S]+))?$/u.exec(text)?.[1]?.trim();
			if (sideQuestion) {
				setPromptText(editor, "");
				setHasText(false);
				setQuery(null);
				setUi({ slashMenu: null });
				// The prompt (and the mode lead in it) is gone; the mode does not survive it.
				clearModes();
				void askSideQuestion(sideQuestion);
				return;
			}
			// `/feedback` needs a dialog, not a turn: opening the product's feedback
			// dialog keeps one submission path and sends no prompt. A comment typed
			// after it rides along, so both spellings file the same report with the
			// same evidence instead of the kernel running its own wizard. The match
			// has to be tested on the whole command: a bare `/feedback` has no
			// capture group, and reading the group alone would fall through to the
			// kernel.
			const feedbackCommand = /^\/feedback(?:\s+([\s\S]+))?$/u.exec(text);
			if (feedbackCommand) {
				setPromptText(editor, "");
				setHasText(false);
				setQuery(null);
				setUi({ slashMenu: null });
				openFeedback(undefined, feedbackCommand[1]?.trim() ?? "");
				clearModes();
				openFeedback();
				return;
			}
			/*
			 * Staged chips shape the outgoing message: one command pick may lead
			 * it, and note picks plus session-context blocks ride at the tail.
			 * The lead chips' own commands ride IN the text: every chip carries
			 * its exact command line, so stacked commands keep their order.
			 */
			const lead = stagedPicks.find((pick) => pick.prefix);
			const tail = [
				...stagedPicks.filter((pick) => pick.note).map((pick) => pick.note),
				...contextPackages.map((item) => item.block),
			].join("\n\n");
			// Lead chips serialize their own commands into `text` in staged order,
			// so a stacked input (plan + skill + prompt) keeps its built order.
			const command = lead ? `${lead.prefix} ` : "";
			const outgoing = `${command}${text}${tail ? `\n\n${tail}` : ""}`;
			setQuery(null);
			setPathQuery(null);
			lastPathQuery.current = null;
			setUi({ slashMenu: null, fileCompletionOpen: false });
			const draft = snapshotPrompt(editor);
			setPromptText(editor, "");
			setHasText(false);
			const sent =
				edit && editingPrompt
					? await rewritePrompt(editingPrompt.before, outgoing, files)
					: await sendMessage(outgoing, files, steer);
			if (!sent) {
				restorePrompt(editor, draft);
				syncHasText();
			} else {
				setContextPackages([]);
				setStagedPicks([]);
				clearModes();
			}
		} finally {
			sending.current = false;
		}
	};

	const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void submit(false);
	};

	/** A mode picked in `#plusMenu`: stage it as the prompt's lead chip for the next message only. */
	const pickMode = useCallback((id: ModeId) => {
		chooseMode(id);
		prompt.current?.focus();
	}, []);

	/**
	 * A skill or plugin picked in `#plusMenu`: staged as one light-purple icon
	 * chip. A command pick (skill, plugin install) replaces the previous command
	 * pick — one slash command per message; a use-note pick (installed plugin)
	 * stacks as a tail note.
	 */
	const stagePick = useCallback((pick: StagedPick) => {
		setStagedPicks((picks) => [
			// A command pick replaces every command pick; a note pick only its twin.
			...picks.filter((item) =>
				pick.prefix ? !item.prefix : !(item.kind === pick.kind && item.name === pick.name),
			),
			pick,
		]);
		prompt.current?.focus();
	}, []);

	/** A skill picked in `#plusMenu`: the kernel expands `/skill:<name>` on send. */
	const pickSkill = useCallback(
		(name: string) => stagePick({ kind: "skill", name, icon: "wrench", prefix: `/skill:${name}` }),
		[stagePick],
	);

	/** A plugin picked in `#plusMenu`: installable ones lead with the install command, installed ones ride as a note. */
	const pickPlugin = useCallback(
		(name: string, installed: boolean) =>
			stagePick(
				installed
					? {
							kind: "plugin",
							name,
							icon: "puzzle",
							note: `（使用插件「${name}」提供的 MCP 服务器与技能完成本次任务。）`,
						}
					: { kind: "plugin", name, icon: "puzzle", prefix: `/plugin install ${name}` },
			),
		[stagePick],
	);

	/** A session picked in `#plusMenu`: package its context into a chip above the prompt. */
	const pickSession = useCallback(async (id: string) => {
		try {
			const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${id}`);
			const title = sessionTitle(snapshot);
			setContextPackages((packages) => [
				// One chip per session: picking again replaces, not stacks.
				...packages.filter((item) => item.sessionId !== id),
				{ sessionId: id, title, block: packageSessionContext(title, timelineFromEntries(snapshot.entries)) },
			]);
			prompt.current?.focus();
		} catch (error) {
			showError(errorMessage(error));
		}
	}, []);

	/** Cmd/Ctrl+Enter during a turn: steer the typed text, or with an empty prompt every queued message. */
	const steer = () => {
		const editor = prompt.current;
		if (!active || !editor) {
			form.current?.requestSubmit();
			return;
		}
		if (promptText(editor).trim()) {
			void submit(true);
			return;
		}
		if (queuedCount) void updateQueued({ kind: "steer" });
	};

	const previewHtml = useMemo(
		() => renderMarkdown(previewSource, { code: t("code"), copy: t("copy"), table: t("markdownTable") }),
		[previewSource, t],
	);
	/** In the preview, Enter sends and Cmd/Ctrl+Enter steers exactly as in the editor. */
	const onPreviewKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const mod = event.metaKey || event.ctrlKey;
		const native = event.nativeEvent;
		if (event.key === "Escape" || (mod && event.shiftKey && event.key.toLowerCase() === "m")) {
			event.preventDefault();
			closePreview();
			return;
		}
		// Only a plain Enter is a send: an IME's confirm key, Alt+Enter and other chords are not.
		if (event.key !== "Enter" || native.isComposing || native.keyCode === 229 || event.altKey) return;
		// The prompt is not accepting input while the host waits for an approval.
		if (waiting) return;
		// A link or a code block's copy button keeps its own Enter.
		if (event.target instanceof Element && event.target.closest("a, button")) return;
		if (event.shiftKey) {
			// Shift+Enter never sends: it returns to the editor and inserts the newline it asked for.
			event.preventDefault();
			newlineOnReturn.current = true;
			closePreview();
			return;
		}
		event.preventDefault();
		if (mod) steer();
		else form.current?.requestSubmit();
	};
	/** The toggle (or a click on rendered text) returns to editing; links, copy buttons and a drag-selection do not. */
	const onPreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (event.target instanceof Element && event.target.closest("a, button")) return;
		const selection = getSelection();
		if (selection && !selection.isCollapsed && selection.toString()) return;
		closePreview();
	};

	return (
		<form
			className={edit ? "composer composer--edit" : "composer"}
			id={edit ? "editComposer" : "composer"}
			ref={form}
			onSubmit={(event) => onFormSubmit(event)}
		>
			{/* The edit instance keeps the menus out: its store flags are shared with the bottom one. */}
			{edit ? null : (
				<>
					<SlashMenu handle={slash} query={query} promptRef={prompt} onPick={pickSlash} />
					<FileMenu handle={files} cwd={cwd} query={pathQuery} promptRef={prompt} onPick={pickFile} />
				</>
			)}
			{edit ? null : (
				<>
					<div className="composer-pickers" id="composerPickers">
						{workspaceControl}
						{branchControl}
					</div>
					<PlanStrip />
					<QueueDock />
				</>
			)}
			{/*
			 * The staged mode paints the card through `data-mode` (accent border, glow
			 * and sweep in composer.css). While rewriting, the edited line's own mode
			 * theme carries over, so a goal rewrite keeps the goal look.
			 */}
			<div
				className="composer-card"
				data-mode={
					(edit
						? (modeFromCommand(
								(/^\/([A-Za-z0-9][\w.:-]*)/u.exec(editingPrompt?.text ?? "")?.[1] ?? "").replace(/:$/u, ""),
							) ?? activeMode)
						: activeMode) ?? undefined
				}
			>
				<AttachmentList />
				{contextPackages.length || stagedPicks.length ? (
					<div className="attachment-list" id="contextChipList">
						{/* The mode is no chip here: it rides the prompt as its leading
						 * text (see `insertModeLead`), not the attachment row. */}
						{stagedPicks.map((pick) => (
							<span
								className={
									pick.kind === "skill"
										? "attachment-chip pick-chip pick-chip--skill"
										: "attachment-chip pick-chip"
								}
								key={`${pick.kind}:${pick.name}`}
								title={pick.note ?? pick.prefix ?? pick.name}
							>
								<Icon name={pick.icon} size="xs" />
								<span>{pick.name}</span>
								<button
									type="button"
									className="attachment-remove"
									title={t("removePick")}
									aria-label={t("removePick")}
									onClick={() =>
										setStagedPicks((picks) =>
											picks.filter((item) => !(item.kind === pick.kind && item.name === pick.name)),
										)
									}
								>
									<Icon name="close-sm" size="xs" />
								</button>
							</span>
						))}
						{contextPackages.map((item) => (
							<span className="attachment-chip context-chip" key={item.sessionId}>
								<Icon name="file" size="xs" />
								<span title={item.title}>{item.title}</span>
								<button
									type="button"
									className="attachment-remove"
									title={t("removeSessionContext")}
									aria-label={t("removeSessionContext")}
									onClick={() =>
										setContextPackages((packages) =>
											packages.filter((entry) => entry.sessionId !== item.sessionId),
										)
									}
								>
									<Icon name="close-sm" size="xs" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<div className="prompt-deck" data-preview={previewOpen ? "" : undefined}>
					<PromptInput
						promptRef={prompt}
						id={edit ? "editPrompt" : "prompt"}
						ignoreFocusRequest={edit}
						disabled={waiting}
						onSubmit={() => form.current?.requestSubmit()}
						onSteer={steer}
						placeholder={
							// The in-place editor edits one message; queue hints belong to the bottom composer.
							edit
								? t("promptEditPlaceholder")
								: // A running turn's queue hint outranks the mode's coaching text.
									active
									? t(queuedCount ? "queuePlaceholderSteerAll" : "queuePlaceholderRunning")
									: activeModeMeta
										? t(activeModeMeta.placeholderKey)
										: undefined
						}
						onValueInput={onValueInput}
						onCaretChange={syncFileQuery}
						onCompositionChange={onCompositionChange}
						onMenuKey={edit ? undefined : (key) => files.current?.key(key) || slash.current?.key(key) || false}
						onTogglePreview={edit ? undefined : togglePreview}
						onRichPaste={edit ? undefined : openPreview}
						stageFilesRef={stageFiles}
					/>
					{/* The rendered draft covers the editor, which stays mounted so the send path still reads it. */}
					{!edit && previewOpen ? (
						<MarkdownView
							ref={previewRef}
							className="prompt-preview message-body"
							html={previewHtml}
							role="region"
							aria-label={t("markdownPreview")}
							tabIndex={0}
							onCopyCode={(code) => void copyText(code)}
							onKeyDown={onPreviewKeyDown}
							onClick={onPreviewClick}
						/>
					) : null}
				</div>
				<div className="composer-controls">
					{/* The editor rewrites one message: it has no attach menu, policy picker or model switch. */}
					{edit ? null : (
						<PlusMenu
							{...menu("plus")}
							onPickMode={pickMode}
							onPickSkill={pickSkill}
							onPickPlugin={pickPlugin}
							onPickSession={(id) => void pickSession(id)}
							onFiles={(picked) => stageFiles.current?.(picked)}
						/>
					)}
					{edit ? null : <PolicyMenu {...menu("policy")} />}
					{edit ? null : (
						<Tooltip content={`${previewOpen ? t("markdownEdit") : t("markdownPreview")} (Cmd/Ctrl+Shift+M)`}>
							<IconButton
								icon={previewOpen ? "pencil" : "eye"}
								iconSize="sm"
								className="prompt-preview-toggle"
								aria-label={previewOpen ? t("markdownEdit") : t("markdownPreview")}
								aria-pressed={previewOpen}
								disabled={!hasText && !previewOpen}
								onClick={togglePreview}
							/>
						</Tooltip>
					)}
					<div className="composer-right">
						{edit ? (
							<button type="button" className="control-select" onClick={() => setUi({ editingPrompt: null })}>
								{t("promptCancel")}
							</button>
						) : null}
						{edit ? null : (
							<>
								<MicButton onTranscript={insertVoiceTranscript} />
								<ModelMenu {...menu("model")} />
							</>
						)}
						{stopMode ? (
							<button
								className="send-button send-button--stop"
								id="stopRun"
								type="button"
								title={t("stopRun")}
								aria-label={t("stopRun")}
								onClick={() => void interruptCurrent()}
							>
								<Icon name="stop" />
							</button>
						) : (
							<button
								className="send-button"
								id="sendButton"
								type="submit"
								title={!edit && active ? t("queueMessage") : t("sendMessage")}
								aria-label={!edit && active ? t("queueMessage") : t("sendMessage")}
								disabled={waiting}
							>
								<Icon name="send" />
							</button>
						)}
					</div>
				</div>
			</div>
			{/* The editor is not a run surface: the session's timing belongs to the bottom composer. */}
			{edit ? null : <PerformanceBar />}
		</form>
	);
}
