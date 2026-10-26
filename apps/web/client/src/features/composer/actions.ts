/**
 * Composer state changes, ported from legacy app.js. Each function updates the
 * store (and the server); the composer components re-render from the store.
 */

import { t } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import {
	DRAFT_SELECTION_ID,
	draftFullAccessQuestion,
	FULL_ACCESS_PRESET,
	FULL_ACCESS_RISK_CANCEL,
} from "../../lib/permissions";
import {
	applyQueueState,
	countUserMessages,
	createSessionIfNeeded,
	forgetSelection,
	refreshCurrent,
	renderSnapshot,
	showError,
} from "../../state/session";
import { type AppState, getState, type ModeId, setState } from "../../state/store";
import type {
	Attachment,
	ClarificationReply,
	ClarificationRequest,
	QueueState,
	SelectionRequest,
	SessionSnapshot,
	SteeringMessage,
	TextInputRequest,
	TimelineItem,
	UploadedFile,
} from "../../state/types";
import { commandLeadIcon, MODES, modeFromCommand } from "./modes";
import {
	insertCommandLead,
	insertModeLead,
	MODE_LEAD_CLASS,
	type PromptFile,
	stripLeadingCommand,
} from "./prompt-editor";

export async function replyToClarification(
	request: ClarificationRequest,
	answers: readonly ClarificationReply[],
	cancelled = false,
): Promise<boolean> {
	try {
		await apiSend(`/api/v1/sessions/${request.sessionId}/clarifications/response`, "POST", {
			id: request.id,
			answers,
			cancelled,
		});
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/* ── Permission policy (legacy renderPolicies onSelect 2534-2541, `policychange` 3509-3522) ── */

/**
 * Make `preset` the draft policy and, with a session open, apply it there.
 *
 * Full Access needs the risk acknowledgment first. A live session's kernel
 * asks it (the PATCH returns with the question pending and the tier
 * unchanged). A draft has no kernel yet, so it asks the same question itself
 * and keeps the answer for the session it creates on the first send.
 */
export async function selectPolicy(preset: string): Promise<void> {
	const state = getState();
	const current = state.current;
	if (!current) {
		if (preset === FULL_ACCESS_PRESET && preset !== state.draftPolicy && !state.draftModels?.fullAccessAcknowledged) {
			setState({ draftSelection: draftFullAccessQuestion() });
			return;
		}
		setState({ draftPolicy: preset, draftFullAccessAnswer: "", draftPolicyPicked: true });
		return;
	}
	setState({ draftPolicy: preset });
	try {
		renderSnapshot(await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/policy`, "PATCH", { preset }));
	} catch (error) {
		showError(errorMessage(error));
	}
}

/* ── Kernel selectors (the Full Access risk question) ─────────────────────── */

/** The question to show: the open session's, or the draft's own Full Access question. */
export function pendingSelection(state: AppState): SelectionRequest | undefined {
	return state.current ? state.current.pendingSelections?.[0] : (state.draftSelection ?? undefined);
}

const answeringSelections = new Set<string>();

/**
 * Answer a pending selection with one of its options, or `undefined` to
 * dismiss it. The host replies once the command that asked has applied the
 * answer, so the returned snapshot already shows the resulting permission tier.
 * The draft's own question is answered locally.
 */
export async function answerSelection(request: SelectionRequest, value: string | undefined): Promise<boolean> {
	if (request.id === DRAFT_SELECTION_ID) {
		const granted = value !== undefined && value !== FULL_ACCESS_RISK_CANCEL;
		setState(
			granted
				? {
						draftSelection: null,
						draftPolicy: FULL_ACCESS_PRESET,
						draftFullAccessAnswer: value,
						draftPolicyPicked: true,
					}
				: { draftSelection: null },
		);
		return true;
	}
	// Escape (ShellEffects) and the dialog's buttons can both answer; the second
	// would only earn a "not found" error.
	if (answeringSelections.has(request.id)) return false;
	answeringSelections.add(request.id);
	try {
		const snapshot = await apiSend<SessionSnapshot>(
			`/api/v1/sessions/${request.sessionId}/selections/response`,
			"POST",
			{ id: request.id, ...(value === undefined ? {} : { value }) },
		);
		forgetSelection(request.id);
		renderSnapshot(snapshot);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	} finally {
		answeringSelections.delete(request.id);
	}
}

/* ── Kernel text prompts (`ui.input`) ─────────────────────────────────────── */

/** The text prompt to show, if any (a `/feedback` step and other input-taking commands). */
export function pendingTextInput(state: AppState): TextInputRequest | undefined {
	return state.current?.pendingTextInputs?.[0];
}

const answeringTextInputs = new Set<string>();

/**
 * Answer a pending kernel text prompt. `undefined` dismisses it, which the
 * kernel reads as "cancelled"; an empty string is a submitted empty answer.
 * The host replies once the command has applied it.
 */
export async function answerTextInput(request: TextInputRequest, value: string | undefined): Promise<boolean> {
	// Escape (ShellEffects) and the dialog's buttons can both answer.
	if (answeringTextInputs.has(request.id)) return false;
	answeringTextInputs.add(request.id);
	try {
		const snapshot = await apiSend<SessionSnapshot>(
			`/api/v1/sessions/${request.sessionId}/text-inputs/response`,
			"POST",
			{ id: request.id, ...(value === undefined ? {} : { value }) },
		);
		renderSnapshot(snapshot);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	} finally {
		answeringTextInputs.delete(request.id);
	}
}

/* ── Model and thinking effort (legacy selectModel / selectEffort, 2746-2776) ── */

/**
 * Apply a model (`${provider}\u0000${id}`). Resolves true when the panel should
 * repaint as legacy did: the server returned a new snapshot, or a draft
 * recorded the pick for the session its first send creates.
 */
export async function selectModel(value: string): Promise<boolean> {
	const [provider, modelId] = value.split("\u0000");
	setState({ draftModel: value });
	const current = getState().current;
	if (!current) return true;
	try {
		renderSnapshot(
			await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/model`, "PATCH", { provider, modelId }),
		);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/** Apply a thinking level. Resolves true on success (the panel then closes); a draft keeps it for its first send. */
export async function selectEffort(level: string): Promise<boolean> {
	const current = getState().current;
	if (!current) {
		setState({ draftThinking: level });
		return true;
	}
	try {
		renderSnapshot(await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/thinking`, "PATCH", { level }));
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/* ── Session modes ────────────────────────────────────────────────────────── */

/**
 * Each mode applies to the next message only.
 *
 * A mode used to be a session switch: picking one typed `/ultraloop on`,
 * `/goal clear` or a bare `/plan` into the prompt and kept it on until picked
 * again. That made "turn this off" a second command the user had to send, and
 * left the input showing keywords they never typed. A mode is now staged as a
 * lead chip at the prompt's line start — part of the text line, deleted with a
 * backspace — and rides one message, dropping once that message is sent.
 *
 * The prefix is what the kernel reads for that one turn (the chip itself adds
 * no prompt text; the send prepends the prefix):
 * - `/plan ` — plan this task;
 * - `/goal ` — start a goal with the message body;
 * - the `ultracode` keyword — the kernel's own per-turn workflow opt-in
 *   (`ultraloop` is its alias; the kernel matches both).
 */
const MODE_PREFIX: Readonly<Record<ModeId, string>> = {
	goal: "/goal ",
	plan: "/plan ",
	ultraloop: "ultracode: ",
};

/** The leading text `id` contributes to the message it is staged on. */
export function modePrefix(id: ModeId): string {
	return MODE_PREFIX[id];
}

/**
 * Single-select: picking `id` makes it the only staged mode, picking it again
 * removes it. Nothing is written into the prompt here; the composer renders the
 * staged mode as the prompt's lead chip (see `insertModeLead`).
 */
export function chooseMode(id: ModeId): boolean {
	const enabled = !getState().modes[id];
	setState({ modes: { goal: false, plan: false, ultraloop: false, [id]: enabled } });
	return enabled;
}

/** Drop every staged mode; a sent message consumes them. */
export function clearModes(): void {
	setState({ modes: { goal: false, plan: false, ultraloop: false } });
}

/**
 * The staged mode renders as the prompt's leading chip, so deleting that chip
 * (a backspace over it) is how the user drops the mode — exactly like deleting
 * the command text it stands for. Call after every prompt edit.
 */
export function syncStagedModeLead(editor: HTMLElement): void {
	const staged = (Object.keys(getState().modes) as ModeId[]).some((id) => getState().modes[id]);
	// Commands stack: a mode survives while its chip is in the DOM, even beside others.
	if (staged && !editor.querySelector(`.${MODE_LEAD_CLASS}`)) clearModes();
}

/**
 * Stage `command` (with its slash or keyword form, no trailing space) as the
 * prompt's lead. The three mode commands stage their mode — the same chip and
 * theme as picking them from the ＋ menu — so typing `/goal` and picking Goal
 * look identical. Any other command replaces whatever was staged: the kernel
 * runs one leading command per message.
 */
export function stageCommandLead(editor: HTMLElement, command: string): void {
	const name = command.replace(/^\//u, "");
	const mode = modeFromCommand(name.replace(/:$/u, ""));
	const meta = mode ? MODES.find((entry) => entry.id === mode) : undefined;
	if (mode && meta) {
		chooseMode(mode);
		// Insert the chip synchronously (see the input sync note): it APPENDS to
		// any leads already staged — commands stack, one input may carry several.
		insertModeLead(editor, {
			id: mode,
			icon: meta.icon,
			label: t(meta.labelKey),
			command: modePrefix(mode).trim(),
		});
		return;
	}
	insertCommandLead(editor, { command, icon: commandLeadIcon(name) });
}

/**
 * After every prompt edit: a completed leading command (name plus its space)
 * leaves the text and becomes its lead chip, so every command line shows the
 * same icon and theme from the moment it is recognizable.
 */
export function applyLeadingCommand(editor: HTMLElement): void {
	const name = stripLeadingCommand(editor);
	if (name === null) return;
	stageCommandLead(editor, name === "ultracode" ? "ultracode:" : `/${name}`);
}

/* ── Other-session context ────────────────────────────────────────────────── */

/**
 * A skill or plugin picked from `#plusMenu`, staged as one light-purple icon
 * chip above `#prompt` (ZCode-style): `prefix` commands lead the next message
 * (one slash command per message, so a command pick replaces the previous
 * one), `note` picks ride at its tail.
 */
export interface StagedPick {
	readonly kind: "skill" | "plugin";
	readonly name: string;
	readonly icon: "wrench" | "puzzle";
	readonly prefix?: string;
	readonly note?: string;
}

/**
 * A picked other-session context: shown as one chip above `#prompt`, and its
 * packaged block rides at the tail of the next sent message.
 */
export interface ContextPackage {
	readonly sessionId: string;
	readonly title: string;
	readonly block: string;
}

/** Caps the packaged transcript, ZCode's selection limits shrunk to one pick. */
const SESSION_CONTEXT_MAX_CHARS = 4000;
const SESSION_CONTEXT_MAX_MESSAGES = 20;

/**
 * Package another session's conversation as a prompt tail block (ZCode's
 * `# userselect:` pattern): a heading naming the source session and a fenced
 * transcript of its user/assistant messages, oldest first, capped. The block
 * is ordinary prompt text — editable before sending, visible in the composer.
 */
export function packageSessionContext(title: string, entries: readonly TimelineItem[]): string {
	const messages = entries
		.filter(
			(entry): entry is Extract<TimelineItem, { kind: "message" }> =>
				entry.kind === "message" &&
				(entry.role === "user" || entry.role === "assistant") &&
				Boolean(entry.content?.trim()) &&
				!entry.error,
		)
		.slice(-SESSION_CONTEXT_MAX_MESSAGES);
	let transcript = messages
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content.trim()}`)
		.join("\n\n");
	if (transcript.length > SESSION_CONTEXT_MAX_CHARS) {
		transcript = `${transcript.slice(0, SESSION_CONTEXT_MAX_CHARS)}\n…（超出部分已截断）`;
	}
	return `# 引用会话「${title}」的上下文\n\`\`\`session-context\n${transcript}\n\`\`\``;
}

/* ── Attachments (legacy 2919-2985) ──────────────────────────────────────── */

/** Attachments staged for the next message, cleared once it is sent. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result);
			resolve(result.slice(result.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error(t("attachmentUnreadable")));
		reader.readAsDataURL(file);
	});
}

/** Read each file (up to 5 MB) and stage it; oversized or unreadable files raise a toast. */
export async function addAttachments(files: readonly File[]): Promise<void> {
	for (const file of files) {
		if (file.size > MAX_ATTACHMENT_BYTES) {
			showError(t("attachmentTooLarge"));
			continue;
		}
		try {
			const attachment: Attachment = {
				name: file.name,
				mimeType: file.type || "application/octet-stream",
				data: await readFileAsBase64(file),
				kind: file.type.startsWith("image/") ? "image" : "text",
			};
			setState((state) => ({ attachments: [...state.attachments, attachment] }));
		} catch (error) {
			showError((error instanceof Error && error.message) || t("attachmentUnreadable"));
		}
	}
}

/**
 * Copy a pasted or dropped file to the host, which answers with the path the
 * message will name. The browser never sees the file's original path.
 */
export function uploadFile(file: File): Promise<UploadedFile> {
	return api<UploadedFile>(`/api/v1/uploads?${new URLSearchParams({ name: file.name })}`, {
		method: "POST",
		body: file,
		headers: { "content-type": "application/octet-stream" },
	});
}

export function removeAttachment(index: number): void {
	setState((state) => ({ attachments: state.attachments.filter((_, position) => position !== index) }));
}

/* ── Sending (legacy `#composer` submit, 3523-3549) ──────────────────────── */

/** A turn is in progress (running, waiting on the user, or compacting), so a new message has to wait for it. */
export function turnActive(state: AppState): boolean {
	return state.compacting || state.current?.status === "running" || state.current?.status === "waiting";
}

/**
 * Send `text` with the staged attachments, creating the session first when
 * this is a draft. During a turn the message is queued on the host and shown
 * in the queue dock until the turn ends; `steer` instead hands it to the
 * running turn, which reads it before its next model call. The caller has
 * already cleared the prompt; on failure the attachments are restored here and
 * false is returned so the caller can put the text back.
 */
export async function sendMessage(text: string, files: readonly PromptFile[] = [], steer = false): Promise<boolean> {
	// Attachments are sent with the message and dropped afterwards, so a failed
	// send has to put both back.
	const state = getState();
	const { attachments, timelineItems } = state;
	const active = turnActive(state);
	// A queued or steered message waits for the turn, so only a new turn gets
	// the immediate message and thinking indicator.
	const images = attachments.filter((attachment) => attachment.kind === "image");
	// A slash command never becomes a user message — the host echoes it as a
	// command row instead — so the optimistic bubble would only flash.
	const pendingTurn =
		active || text.startsWith("/")
			? null
			: {
					text,
					files,
					images: images.map((image) => `data:${image.mimeType};base64,${image.data}`),
					userCount: countUserMessages(timelineItems),
				};
	setState({ attachments: [], pendingTurn });
	// A steered message is shown in the conversation now, though the kernel reads it only after the current tool call.
	const steering = active && steer && state.current ? (state.current.steeringMessages ?? []) : null;
	if (steering && state.current)
		setSteering(state.current.id, [
			...steering,
			{ text, images: images.map(({ mimeType, data }) => ({ mimeType, data })) },
		]);
	try {
		const session = await createSessionIfNeeded(text);
		const endpoint = !active ? "messages" : steer ? "steer" : "queue";
		// `files`: upload ids of the prompt's file chips; the host adds their content.
		const body = JSON.stringify({ text, attachments, files: files.map((file) => file.id) });
		const result = await api<QueueState | { ok: true }>(`/api/v1/sessions/${session.id}/${endpoint}`, {
			method: "POST",
			body,
		});
		if ("queued" in result) applyQueueState(session.id, result);
		// A slash command journals no user message: the host echoes it as a
		// command row through the snapshot, so pull the snapshot once the
		// command has run (commands that drive no turn push no other event).
		if (text.startsWith("/")) void refreshCurrent();
		return true;
	} catch (error) {
		setState({ attachments, pendingTurn: null });
		if (steering && state.current) setSteering(state.current.id, steering);
		showError(errorMessage(error));
		return false;
	}
}

function setSteering(sessionId: string, steering: readonly SteeringMessage[]): void {
	const current = getState().current;
	if (current?.id === sessionId)
		applyQueueState(sessionId, { queued: current.queuedMessages ?? [], steering: [...steering] });
}

/* ── Queued messages (the dock above the composer) ───────────────────────── */

/**
 * Change one queued message: edit its text, remove it, or steer it into the
 * running turn (`id` undefined with "steer": every queued message). Resolves
 * false when the host refused, e.g. the message has started meanwhile.
 */
export async function updateQueued(
	action: { kind: "edit"; id: string; text: string } | { kind: "remove"; id: string } | { kind: "steer"; id?: string },
): Promise<boolean> {
	if (action.kind === "steer") return steerQueued(action.id);
	const current = getState().current;
	if (!current) return false;
	const base = `/api/v1/sessions/${current.id}/queue`;
	try {
		const result =
			action.kind === "edit"
				? await apiSend<QueueState>(`${base}/${encodeURIComponent(action.id)}`, "PATCH", { text: action.text })
				: await apiSend<QueueState>(`${base}/${encodeURIComponent(action.id)}`, "DELETE");
		applyQueueState(current.id, result);
		return true;
	} catch {
		// It fails when the message already left the queue; the host's reason adds nothing.
		showError(t(action.kind === "edit" ? "queueEditFailed" : "queueRemoveFailed"));
		return false;
	}
}

/**
 * "立即": steer queued messages (`id`, or all of them) into the running turn.
 * The kernel reads them only after the current tool call, but they leave the
 * dock and show in the conversation before the request returns (the host's
 * queue state replaces this guess when it arrives). With no turn running the
 * host starts the first one as a new turn, so that one becomes the pending turn.
 */
async function steerQueued(id?: string): Promise<boolean> {
	const state = getState();
	const current = state.current;
	if (!current) return false;
	const queued = current.queuedMessages ?? [];
	const steering = current.steeringMessages ?? [];
	const targets = id ? queued.filter((item) => item.id === id) : queued;
	const [first] = targets;
	if (!first) return false;
	const active = turnActive(state);
	const moved = active ? targets : [first];
	applyQueueState(current.id, {
		queued: queued.filter((item) => !moved.includes(item)),
		// The queue view has no image bytes; the host's response brings them.
		steering: active ? [...steering, ...moved.map((item) => ({ text: item.text, images: [] }))] : steering,
	});
	if (!active) setState({ pendingTurn: { text: first.text, userCount: countUserMessages(state.timelineItems) } });
	const base = `/api/v1/sessions/${current.id}/queue`;
	try {
		applyQueueState(
			current.id,
			await apiSend<QueueState>(id ? `${base}/${encodeURIComponent(id)}/steer` : `${base}/steer`, "POST"),
		);
		return true;
	} catch (error) {
		applyQueueState(current.id, { queued, steering });
		if (!active) setState({ pendingTurn: null });
		showError(`${t("queueSteerFailed")} ${errorMessage(error)}`);
		return false;
	}
}
