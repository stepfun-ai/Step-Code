/**
 * `#plusMenu`: the composer's add menu behind one `+` trigger. Holds everything
 * that used to sit in the control row or only in Settings: staging attachments,
 * the session modes (goal / plan / ultracode, single-select, moved here from
 * `#modeMenu`), and three entries with ZCode-style secondary panels — plugins,
 * skills and other sessions' context. The permission preset stays a sibling
 * button, not an entry here.
 *
 * Picking a mode is single-select and stages it as the prompt's lead chip (see
 * `chooseMode` + `insertModeLead`); the goal text itself is typed after it.
 * The 更多 rows open their panel on hover or click; the panel closes with the
 * menu.
 */

import { type ChangeEvent, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { type ModeId, useAppStore } from "../../state/store";
import { Icon, IconButton, type IconName, Popover } from "../../ui";
import { ControlOption, PopoverGroupLabel } from "./ControlOption";
import { MODES } from "./modes";
import { PluginsPanel, SessionsPanel, SkillsPanel } from "./PlusSubPanels";
import type { ComposerMenuProps } from "./PolicyMenu";

/** The 更多 entries that carry a secondary panel. */
type SubKey = "plugins" | "skills" | "sessions";

const SUB_ENTRIES: ReadonlyArray<{ key: SubKey; labelKey: string; icon: IconName }> = [
	{ key: "plugins", labelKey: "settingsPlugins", icon: "puzzle" },
	{ key: "skills", labelKey: "slashSkills", icon: "wand" },
	{ key: "sessions", labelKey: "otherSessionContext", icon: "layers" },
];

export interface PlusMenuProps extends ComposerMenuProps {
	/** Stages the mode's command line in `#prompt` and focuses it (see `Composer`). */
	readonly onPickMode: (id: ModeId) => void;
	/** Stages `/skill:<name> ` in `#prompt` (see `Composer`). */
	readonly onPickSkill: (name: string) => void;
	/** Stages a plugin pick in the composer; `installed` picks ride as a note (see `Composer`). */
	readonly onPickPlugin: (name: string, installed: boolean) => void;
	/** Packages the picked session's context into `#prompt` (see `Composer`). */
	readonly onPickSession: (id: string) => void;
	/** Stages files picked through `#attachInput` the same way as pasted or dropped ones (see `PromptInput`). */
	readonly onFiles: (files: readonly File[]) => void;
}

export function PlusMenu({
	open,
	onOpen,
	onClose,
	onPickMode,
	onPickSkill,
	onPickPlugin,
	onPickSession,
	onFiles: stageFiles,
}: PlusMenuProps) {
	const t = useT();
	const input = useRef<HTMLInputElement | null>(null);
	const modes = useAppStore((state) => state.modes);
	/** The panel open in the 更多 row, opened by hover or click; the menu's own rows clear it. */
	const [sub, setSub] = useState<SubKey | null>(null);
	/**
	 * The panel's top offset inside the popover: aligned with the hovered row, so
	 * the mouse reaches the panel with a short horizontal move that crosses no
	 * other row (crossing one would switch or close the panel mid-move).
	 */
	const [subTop, setSubTop] = useState(-1);
	/** `subTop` after the clamp below; the slot renders with this value. */
	const [panelTop, setPanelTop] = useState(-1);
	const slotRef = useRef<HTMLDivElement | null>(null);
	const openSub = (key: SubKey, row: HTMLElement) => {
		setSub(key);
		const pop = row.closest(".control-popover");
		const top = pop ? row.getBoundingClientRect().top - pop.getBoundingClientRect().top : -1;
		setSubTop(Math.round(top));
		setPanelTop(Math.round(top));
	};
	/*
	 * Keep the panel's bottom inside the viewport: align with the row first, then
	 * shift up by the measured overflow (the panel's own height changes when its
	 * data arrives, so re-measure through a ResizeObserver).
	 */
	useLayoutEffect(() => {
		if (!sub) return;
		const slot = slotRef.current;
		const pop = slot?.closest(".control-popover");
		if (!slot || !pop) return;
		const clamp = () => {
			const popTop = pop.getBoundingClientRect().top;
			const height = slot.getBoundingClientRect().height;
			const room = window.innerHeight - 8 - popTop - height;
			setPanelTop(Math.round(Math.max(-1, Math.min(subTop, room))));
		};
		clamp();
		const observer = new ResizeObserver(clamp);
		observer.observe(slot);
		return () => observer.disconnect();
	}, [sub, subTop]);
	const closeAll = () => {
		setSub(null);
		onClose();
	};

	// Reset so choosing the same file again still fires `change`.
	const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
		const files = [...(event.target.files ?? [])];
		event.target.value = "";
		if (files.length) stageFiles(files);
	};

	return (
		<div className="control-menu" id="plusMenu">
			<Popover
				bare
				className="control-popover"
				id="plusPopover"
				role="listbox"
				placement="top-start"
				open={open}
				onClose={closeAll}
				content={
					<>
						{/*
						 * The list scrolls inside `.plus-menu-scroll` so `.control-popover`
						 * itself can stop clipping (see composer.css): the secondary panel
						 * is this popover's child but must paint outside its box.
						 */}
						<div className="plus-menu-scroll">
							{/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only convenience; the rows carry the click and keyboard path. */}
							<div onMouseEnter={() => setSub(null)}>
								<PopoverGroupLabel>{t("plusGroupAdd")}</PopoverGroupLabel>
								<ControlOption
									id="attach"
									icon="paperclip"
									title={t("attach")}
									selected={false}
									onSelect={() => {
										closeAll();
										input.current?.click();
									}}
								/>
								<PopoverGroupLabel>{t("modes")}</PopoverGroupLabel>
								{MODES.map((mode) => (
									<ControlOption
										key={mode.id}
										id={mode.id}
										// The per-mode class carries the row's accent (`--mode-*` in composer.css).
										className={`control-option--mode control-option--${mode.id}`}
										icon={mode.icon}
										title={t(mode.labelKey)}
										description={t(mode.descKey)}
										selected={Boolean(modes[mode.id])}
										onSelect={(id) => {
											onPickMode(id);
											closeAll();
										}}
									/>
								))}
							</div>
							<PopoverGroupLabel>{t("plusGroupMore")}</PopoverGroupLabel>
							{SUB_ENTRIES.map((entry) => (
								<button
									key={entry.key}
									type="button"
									className={sub === entry.key ? "plus-row plus-row--open" : "plus-row"}
									role="option"
									aria-selected={sub === entry.key ? "true" : "false"}
									onClick={(event) =>
										sub === entry.key ? setSub(null) : openSub(entry.key, event.currentTarget)
									}
									onMouseEnter={(event) => openSub(entry.key, event.currentTarget)}
								>
									<Icon name={entry.icon} className="control-option-icon" />
									<span className="plus-row-title">{t(entry.labelKey)}</span>
									<Icon name="chevronRight" size="2xs" className="plus-row-chevron" />
								</button>
							))}
						</div>
						{sub ? (
							<>
								{/* biome-ignore lint/a11y/noStaticElementInteractions: keeps the panel open while the mouse crosses the 8px gap; no action happens here. */}
								<div
									ref={slotRef}
									className="plus-sub-slot"
									style={{ top: `${panelTop}px` }}
									onMouseEnter={() => setSub(sub)}
								>
									{sub === "plugins" ? (
										<PluginsPanel
											onPick={(name, installed) => {
												onPickPlugin(name, installed);
												closeAll();
											}}
										/>
									) : null}
									{sub === "skills" ? (
										<SkillsPanel
											onPick={(name) => {
												onPickSkill(name);
												closeAll();
											}}
										/>
									) : null}
									{sub === "sessions" ? (
										<SessionsPanel
											onPick={(id) => {
												onPickSession(id);
												closeAll();
											}}
										/>
									) : null}
								</div>
							</>
						) : null}
					</>
				}
			>
				<IconButton
					id="plusTrigger"
					className="plus-control"
					title={t("plusTitle")}
					aria-label={t("plusTitle")}
					aria-haspopup="listbox"
					aria-expanded={open ? "true" : "false"}
					icon="plus"
					onClick={() => (open ? closeAll() : onOpen())}
				/>
			</Popover>
			<input type="file" id="attachInput" multiple hidden ref={input} onChange={onFiles} />
		</div>
	);
}
