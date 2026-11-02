/**
 * `.plan-strip`: plan mode, docked above the composer card like the goal strip.
 *
 * Plan mode is session state the host already projects (`snapshot.planMode`), so
 * it is drawn from that state rather than announced into the transcript. It
 * stays visible while a proposal waits for review — submitting does not leave
 * the mode — and clears when the user decides.
 *
 * The strip is also the user's way out. Leaving plan mode is the user's
 * decision — a missing or unchanged plan file is not permission for the model to
 * turn it off — so a host that only offers a composer has to give the user a
 * control that says so. The button sends `/plan off`, the same command the
 * terminal accepts: setMode routes through it too, so one command owns the
 * transition on every host.
 *
 * Stays mounted and toggles `hidden`, like every other strip here.
 */

import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Icon, Tooltip } from "../../ui";
import { sendMessage } from "./actions";

export function PlanStrip() {
	const t = useT();
	const plan = useAppStore((state) => state.current?.planMode);
	const enabled = plan?.enabled === true;
	const path = plan?.planFilePath ?? "";
	// Without a resolved path the file is named the way the kernel names it
	// (`session-<id>.md`), so the strip is never blank while planning.
	const name = path ? basename(path) : t("planStripUnnamed");
	return (
		<div className="plan-strip" id="planStrip" hidden={!enabled}>
			<span className="plan-strip-icon" aria-hidden="true">
				<Icon name="listCheck" size="xs" />
			</span>
			<Tooltip content={path || t("planStripHint")}>
				<span className="plan-strip-label">{t("planStripLabel")}</span>
			</Tooltip>
			{path ? <span className="plan-strip-path">{name}</span> : null}
			<span className="plan-strip-hint">{t("planStripHint")}</span>
			{enabled ? (
				// Leaving is the user's own decision, expressed as an absolute verb.
				// A toggle would flip whatever state the turn left behind when the
				// message is queued behind a running turn.
				<Tooltip content={t("planStripExitHint")}>
					<button
						className="plan-strip-exit"
						id="planStripExit"
						type="button"
						onClick={() => {
							void sendMessage("/plan off");
						}}
					>
						{t("planStripExit")}
					</button>
				</Tooltip>
			) : null}
		</div>
	);
}
