/**
 * `.plan-strip`: plan mode, docked above the composer card like the goal strip.
 *
 * Plan mode is session state the host already projects (`snapshot.planMode`), so
 * it is drawn from that state rather than announced into the transcript. It
 * disappears by itself when `exit_plan_mode` clears the state, which is what the
 * user expects after the plan review card appears.
 *
 * Stays mounted and toggles `hidden`, like every other strip here.
 */

import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { Icon, Tooltip } from "../../ui";

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
		</div>
	);
}
