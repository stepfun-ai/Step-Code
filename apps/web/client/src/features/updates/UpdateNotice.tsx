/**
 * `#updateNotice`, above the account row at the foot of the sidebar: the
 * desktop app's own update, driven by `window.stepcodeDesktop.updates`.
 *
 * Hidden in a browser and while there is nothing to do (up to date, checking,
 * updates disabled). Otherwise one button that names the next step:
 *
 *   available    "New version 0.1.1" -> download, verify and install
 *   downloading  progress bar and percentage (not clickable)
 *   installing   "Installing…" (verify the SHA-512, stage the update; not clickable)
 *   ready        "Restart to update" -> `#updateRestartDialog`
 *   error        "Update failed · Retry" -> repeats the failed step
 *
 * When an install finishes, `#updateRestartDialog` opens by itself: restarting
 * stops running tasks, so the restart is always the user's call ("Later"
 * keeps the button). While any session has a running (or waiting) turn the
 * dialog says so instead (`.update-restart-dialog.busy`): "Stop tasks and update"
 * interrupts those turns first, then restarts; "Update later" keeps the button.
 * The variant follows the sessions live, so a turn that ends while it is open
 * turns it back into the plain restart prompt.
 */

import { useEffect, useRef, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { formatBytes } from "../../lib/format";
import type { DesktopUpdateState, DesktopUpdatesBridge } from "../../platform/desktop-bridge";
import { getDesktopBridge } from "../../platform/host";
import { hasRunningSessions, interruptRunningSessions, refreshSessionStatuses } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Button, Icon, IconButton, Modal, Spinner, Tooltip } from "../../ui";

function useDesktopUpdate(updates: DesktopUpdatesBridge | undefined): DesktopUpdateState | undefined {
	const [state, setState] = useState<DesktopUpdateState>();
	useEffect(() => {
		if (updates === undefined) return;
		let live = true;
		const unsubscribe = updates.subscribe((next) => setState(next));
		// A push that arrives first is newer than this answer.
		void updates.getState().then((initial) => {
			if (live) setState((current) => current ?? initial);
		});
		return () => {
			live = false;
			unsubscribe();
		};
	}, [updates]);
	return state;
}

function percent(received: number, size: number): number {
	return size > 0 ? Math.min(100, Math.floor((received / size) * 100)) : 0;
}

/** Title and detail line of the notice, or undefined when it is hidden. */
function describe(
	t: TranslateFn,
	state: DesktopUpdateState | undefined,
): { title: string; detail: string } | undefined {
	switch (state?.phase) {
		case "available":
			return { title: t("updateAvailable", { version: state.version }), detail: t("updateAvailableAction") };
		case "downloading":
			return {
				title: t("updateDownloading", { percent: percent(state.received, state.size) }),
				detail: `${formatBytes(state.received)} / ${formatBytes(state.size)}`,
			};
		case "installing":
			return { title: t("updateInstalling"), detail: t("updateVersion", { version: state.version }) };
		case "ready":
			return { title: t("updateReady"), detail: t("updateVersion", { version: state.version }) };
		case "restarting":
			return { title: t("updateRestarting"), detail: t("updateVersion", { version: state.version }) };
		case "error":
			return { title: t("updateFailed"), detail: t("updateRetry") };
		default:
			return undefined;
	}
}

export function UpdateNotice() {
	const t = useT();
	const updates = getDesktopBridge()?.updates;
	const state = useDesktopUpdate(updates);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [stopping, setStopping] = useState(false);
	const busySessions = useAppStore(hasRunningSessions);
	const previousPhase = useRef<DesktopUpdateState["phase"]>(undefined);

	// "Installed, restart?" as soon as an install the user started finishes.
	useEffect(() => {
		const phase = state?.phase;
		const previous = previousPhase.current;
		if (phase === "ready" && (previous === "installing" || previous === "downloading")) setDialogOpen(true);
		if (phase !== "ready") setDialogOpen(false);
		previousPhase.current = phase;
	}, [state?.phase]);

	// Which prompt to show depends on every session in the host, not only the rows on screen.
	useEffect(() => {
		if (dialogOpen) void refreshSessionStatuses().catch(() => undefined);
	}, [dialogOpen]);

	const text = describe(t, state);
	const busy = state?.phase === "downloading" || state?.phase === "installing" || state?.phase === "restarting";
	const onClick = () => {
		if (updates === undefined || state === undefined) return;
		if (state.phase === "available") void updates.download();
		else if (state.phase === "ready") setDialogOpen(true);
		else if (state.phase === "error") {
			if (state.operation === "check") void updates.check();
			else if (state.operation === "restart") void updates.restart().catch(() => undefined);
			else void updates.download();
		}
	};
	const restart = () => {
		setDialogOpen(false);
		// A failed restart comes back as an `error` state.
		void updates?.restart().catch(() => undefined);
	};
	const stopAndRestart = async () => {
		setStopping(true);
		try {
			await interruptRunningSessions();
		} finally {
			setStopping(false);
		}
		restart();
	};
	const progress = state?.phase === "downloading" ? percent(state.received, state.size) : undefined;
	const icon = state?.phase === "error" ? "triangleAlert" : state?.phase === "ready" ? "refresh" : "download";

	const button = (
		<button
			type="button"
			className="update-notice-button"
			data-phase={state?.phase}
			aria-disabled={busy}
			onClick={busy ? undefined : onClick}
		>
			<span className="update-notice-icon" aria-hidden="true">
				{busy ? <Spinner /> : <Icon name={icon} size="sm" />}
			</span>
			<span className="update-notice-text">
				<span className="update-notice-title">{text?.title}</span>
				<span className="update-notice-detail">{text?.detail}</span>
			</span>
			{progress !== undefined ? (
				<span
					className="update-notice-progress"
					role="progressbar"
					aria-label={t("updateDownloadProgress")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={progress}
				>
					<span style={{ width: `${progress}%` }} />
				</span>
			) : null}
		</button>
	);

	return (
		<>
			<div className="update-notice" id="updateNotice" hidden={text === undefined} aria-live="polite">
				{state?.phase === "error" ? <Tooltip content={state.message}>{button}</Tooltip> : button}
			</div>
			<Modal
				id="updateRestartDialog"
				className={busySessions ? "update-restart-dialog busy" : "update-restart-dialog"}
				open={dialogOpen && state?.phase === "ready"}
				labelledBy="updateRestartTitle"
				onClose={() => setDialogOpen(false)}
				closeOnEscape
				dialogProps={{ "aria-describedby": "updateRestartDescription" }}
			>
				{busySessions ? (
					<>
						<header>
							<h2 id="updateRestartTitle">{t("updateBusyTitle")}</h2>
							<IconButton
								id="updateRestartClose"
								icon="close"
								aria-label={t("updateBusyClose")}
								onClick={() => setDialogOpen(false)}
							/>
						</header>
						<p id="updateRestartDescription">{t("updateBusyDescription")}</p>
						<footer className="update-restart-stack">
							<Button id="updateRestartNow" disabled={stopping} onClick={() => void stopAndRestart()}>
								{t("updateBusyConfirm")}
							</Button>
							<Button id="updateRestartLater" onClick={() => setDialogOpen(false)}>
								{t("updateBusyLater")}
							</Button>
						</footer>
					</>
				) : (
					<>
						<h2 id="updateRestartTitle">
							{t("updateRestartTitle", { version: state?.phase === "ready" ? state.version : "" })}
						</h2>
						<p id="updateRestartDescription">{t("updateRestartDescription")}</p>
						<footer>
							<Button id="updateRestartLater" onClick={() => setDialogOpen(false)}>
								{t("updateRestartLater")}
							</Button>
							<Button id="updateRestartNow" onClick={restart}>
								{t("updateRestartNow")}
							</Button>
						</footer>
					</>
				)}
			</Modal>
		</>
	);
}
