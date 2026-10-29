/**
 * The three session modes' presentation metadata, shared by the ＋ menu's mode
 * rows, the prompt's mode lead chip and its mode placeholder. The per-mode
 * accent colour lives in composer.css (`--mode-*` on `.composer`); this file
 * carries only the icon and copy keys, so a new mode is one entry here plus one
 * accent there.
 */

import type { ModeId } from "../../state/store";
import type { IconName } from "../../ui";

export const MODES: ReadonlyArray<{
	readonly id: ModeId;
	readonly icon: IconName;
	readonly labelKey: string;
	readonly descKey: string;
	/** The prompt's placeholder while the mode is staged: coaches what to type. */
	readonly placeholderKey: string;
	/**
	 * Kept out of the picker while its interaction is unfinished; everything else
	 * about the mode (typed command, lead chip, kernel prefix, message badge) keeps
	 * working, so an existing message and a typed `ultracode:` still render.
	 */
	readonly hidden?: true;
}> = [
	{
		id: "goal",
		icon: "target",
		labelKey: "modeGoal",
		descKey: "modeGoalDesc",
		placeholderKey: "modeGoalPlaceholder",
	},
	{
		id: "plan",
		icon: "listCheck",
		labelKey: "modePlan",
		descKey: "modePlanDesc",
		placeholderKey: "modePlanPlaceholder",
	},
	{
		id: "ultraloop",
		icon: "orbit",
		labelKey: "modeUltraloop",
		descKey: "modeUltraloopDesc",
		placeholderKey: "modeUltraloopPlaceholder",
		// Ultracode is hidden in Web and Desktop for now: its interaction is not
		// finished. The mode itself, its keyword and its alias stay wired.
		hidden: true,
	},
];

/** The modes the ＋ menu offers; a hidden mode stays usable through its command. */
export const PICKABLE_MODES: ReadonlyArray<(typeof MODES)[number]> = MODES.filter((mode) => !mode.hidden);

/* ── Leading commands ─────────────────────────────────────────────────────── */

/**
 * The command names that stage a session mode when they lead the prompt. The
 * ultraloop workflow's keyword form (`ultracode:`) and its slash alias both map
 * to the same mode, so typing either renders the same lead chip as picking the
 * mode from the ＋ menu.
 */
const MODE_COMMANDS: Readonly<Record<string, ModeId>> = {
	goal: "goal",
	plan: "plan",
	ultraloop: "ultraloop",
	ultracode: "ultraloop",
};

/** The mode a leading `command` name stages, or null for every other command. */
export function modeFromCommand(command: string): ModeId | null {
	return MODE_COMMANDS[command] ?? null;
}

/**
 * The icon a leading command's chip shows. The three modes keep their own
 * icons; the long tail gets one recognizable icon per command family, with a
 * terminal-prompt icon as the default — the same command always looks the same.
 */
export function commandLeadIcon(command: string): IconName {
	if (command.startsWith("skill:")) return "wrench";
	if (command.startsWith("plugin")) return "puzzle";
	switch (command) {
		case "permissions":
			return "shield";
		case "btw":
			return "question";
		case "feedback":
			return "thumbsUp";
		default:
			return "prompt";
	}
}
