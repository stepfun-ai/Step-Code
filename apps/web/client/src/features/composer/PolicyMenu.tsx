/**
 * `#policyMenu`: the permission preset picker (legacy app.js 2489-2556,
 * `policychange` 3509-3522).
 */

import { tOr, useT } from "../../i18n";
import { shallowEqual, useAppStore } from "../../state/store";
import type { IconName } from "../../ui";
import { selectPolicy } from "./actions";
import { ControlMenu, ControlOption, PopoverHint } from "./ControlOption";

/**
 * Icons for each permission preset, keyed by the kernel's preset id. The wand
 * belongs to skills, so automatic approval wears its own check mark.
 */
const POLICY_ICONS: Readonly<Record<string, IconName>> = {
	ask: "shield",
	"approve-for-me": "circleCheck",
	"full-access": "zap",
};

export interface ComposerMenuProps {
	readonly open: boolean;
	readonly onOpen: () => void;
	readonly onClose: () => void;
}

export function PolicyMenu({ open, onOpen, onClose }: ComposerMenuProps) {
	const t = useT();
	// Legacy rendered from `state.current ?? { policies: policiesCache, permissionPreset: draftPolicy }`.
	const { presets, current } = useAppStore(
		(state) =>
			state.current
				? { presets: state.current.policies ?? [], current: state.current.permissionPreset ?? state.draftPolicy }
				: { presets: state.policiesCache ?? [], current: state.draftPolicy },
		shallowEqual,
	);
	return (
		<ControlMenu
			id="policyMenu"
			triggerId="policyTrigger"
			triggerClassName={
				current === "full-access" ? "permission-control permission-control--danger" : "permission-control"
			}
			title={t("policyTitle")}
			icon={POLICY_ICONS[current] ?? "shield"}
			labelId="policyLabel"
			label={tOr(`policy.${current}.label`, t(current))}
			popoverId="policyPopover"
			open={open}
			onOpen={onOpen}
			onClose={onClose}
		>
			{presets.length ? (
				presets.map((preset) => (
					<ControlOption
						key={preset.id}
						id={preset.id}
						icon={POLICY_ICONS[preset.id]}
						title={tOr(`policy.${preset.id}.label`, preset.label)}
						description={tOr(`policy.${preset.id}.description`, preset.description)}
						selected={preset.id === current}
						onSelect={(id) => {
							void selectPolicy(id);
							onClose();
						}}
					/>
				))
			) : (
				<PopoverHint>{t("noPolicies")}</PopoverHint>
			)}
		</ControlMenu>
	);
}
