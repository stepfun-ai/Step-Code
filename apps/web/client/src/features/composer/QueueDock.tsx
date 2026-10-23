/**
 * `.queue-dock`: the messages sent while a turn runs, docked on top of the
 * composer card. Queued rows wait for the turn to end and can be edited,
 * removed or sent at once ("立即", see `steerQueued`). A row sent at once leaves
 * the dock: the conversation shows it while the kernel waits for the current
 * tool call to end. Stays mounted, hidden while the queue is empty.
 */

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { setUi, useAppStore } from "../../state/store";
import type { QueuedMessage } from "../../state/types";
import { Icon, Tooltip } from "../../ui";
import { turnActive, updateQueued } from "./actions";

const NO_QUEUE: readonly QueuedMessage[] = [];

/** One line of the message for the row; the full text shows on edit. */
function preview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function QueueDock() {
	const t = useT();
	const queued = useAppStore((state) => state.current?.queuedMessages ?? NO_QUEUE);
	const active = useAppStore(turnActive);
	const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const listId = useId();
	const editor = useRef<HTMLTextAreaElement | null>(null);
	const ime = useImeGuard();
	const total = queued.length;

	// A row that left the queue (dispatched, or removed elsewhere) cannot stay in edit.
	useEffect(() => {
		if (editing && !queued.some((item) => item.id === editing.id)) setEditing(null);
	}, [editing, queued]);
	useEffect(() => {
		if (total === 0) setCollapsed(false);
	}, [total]);
	const editingId = editing?.id;
	useEffect(() => {
		if (!editingId || !editor.current) return;
		editor.current.focus();
		editor.current.setSelectionRange(editor.current.value.length, editor.current.value.length);
	}, [editingId]);

	/** Leave edit mode; the editor unmounts, so focus goes back to the prompt instead of the page. */
	const stopEditing = () => {
		setEditing(null);
		setUi((ui) => ({ promptFocusRequest: ui.promptFocusRequest + 1 }));
	};
	const run = async (id: string, action: Parameters<typeof updateQueued>[0]): Promise<boolean> => {
		setBusy(id);
		try {
			return await updateQueued(action);
		} finally {
			setBusy((value) => (value === id ? null : value));
		}
	};
	const save = async () => {
		if (!editing || !editing.text.trim()) return;
		if (await run(editing.id, { kind: "edit", id: editing.id, text: editing.text })) stopEditing();
	};
	const onEditorKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			// Escape here only cancels the edit; it must not reach the shell, which stops the run.
			event.preventDefault();
			event.stopPropagation();
			stopEditing();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || ime.isComposing(event)) return;
		event.preventDefault();
		void save();
	};

	const interacting = editing !== null || busy !== null;
	const expanded = total === 1 || !collapsed || interacting;
	const sendNowTip = active ? t("queueSendNowSteer") : t("queueSendNow");

	return (
		<div className="queue-dock" data-queue-dock="" hidden={total === 0}>
			{total > 1 ? (
				<button
					type="button"
					className="queue-dock-header"
					aria-controls={listId}
					aria-expanded={expanded}
					disabled={interacting}
					onClick={() => setCollapsed((value) => !value)}
				>
					<Icon name="listCheck" size="sm" className="queue-dock-lead" />
					<span className="queue-dock-count">{t("queueCount", { n: total })}</span>
					<Icon name="chevronDown" size="sm" className={`queue-dock-chevron${expanded ? "" : " is-collapsed"}`} />
				</button>
			) : null}
			<ul className="queue-dock-list" id={listId} hidden={!expanded}>
				{queued.map((item) => {
					const isEditing = editing?.id === item.id;
					const names = [...item.files.map((file) => file.name), ...item.attachments.map((file) => file.name)];
					return (
						<li className={`queue-row${isEditing ? " is-editing" : ""}`} key={item.id} data-queue-id={item.id}>
							{total === 1 ? <Icon name="listCheck" size="sm" className="queue-dock-lead" /> : null}
							{isEditing ? (
								<textarea
									ref={editor}
									className="queue-row-editor"
									aria-label={t("queueEdit")}
									value={editing.text}
									rows={Math.min(6, editing.text.split("\n").length)}
									onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
									onKeyDown={onEditorKey}
									{...ime.handlers}
								/>
							) : (
								<span className="queue-row-text" title={item.text}>
									<span className="queue-row-preview">{preview(item.text)}</span>
									{names.map((name) => (
										<span className="queue-row-file" key={name} title={t("queueAttachment", { name })}>
											<Icon name="paperclip" size="xs" />
											{name}
										</span>
									))}
								</span>
							)}
							<div className="queue-row-actions">
								{isEditing ? (
									<>
										<Tooltip content={t("queueSave")}>
											<button
												type="button"
												className="queue-action"
												aria-label={t("queueSave")}
												disabled={busy !== null || !editing.text.trim()}
												onClick={() => void save()}
											>
												<Icon name="check" size="sm" />
											</button>
										</Tooltip>
										<Tooltip content={t("queueCancelEdit")}>
											<button
												type="button"
												className="queue-action"
												aria-label={t("queueCancelEdit")}
												disabled={busy !== null}
												onClick={stopEditing}
											>
												<Icon name="close" size="sm" />
											</button>
										</Tooltip>
									</>
								) : (
									<>
										<Tooltip content={t("queueEdit")}>
											<button
												type="button"
												className="queue-action"
												aria-label={t("queueEdit")}
												data-queue-action="edit"
												disabled={busy !== null}
												onClick={() => setEditing({ id: item.id, text: item.text })}
											>
												<Icon name="pencil" size="sm" />
											</button>
										</Tooltip>
										<Tooltip content={t("queueRemove")}>
											<button
												type="button"
												className="queue-action"
												aria-label={t("queueRemove")}
												data-queue-action="remove"
												disabled={busy !== null}
												onClick={() => void run(item.id, { kind: "remove", id: item.id })}
											>
												<Icon name="trash" size="sm" />
											</button>
										</Tooltip>
										<Tooltip content={sendNowTip}>
											<button
												type="button"
												className="queue-action queue-action--now"
												aria-label={sendNowTip}
												data-queue-action="steer"
												disabled={busy !== null}
												onClick={() => void run(item.id, { kind: "steer", id: item.id })}
											>
												<Icon name="up" size="md" />
											</button>
										</Tooltip>
									</>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
