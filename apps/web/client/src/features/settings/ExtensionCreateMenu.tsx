import { useEffect, useRef, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { Button, Icon, Menu, MenuItem, Popover } from "../../ui";
import { createExtensionWithStepCode } from "./actions";

export interface UploadOutcome {
	readonly tone: "danger" | "success";
	readonly title: string;
	/** Detail under the headline; a one-line outcome carries none. */
	readonly message?: string;
}

/** Optional format error only. Successful installation feedback comes from the confirmed import API. */
export function readUploadSelection(
	kind: "plugins" | "skills",
	file: File | undefined,
	t: TranslateFn,
): UploadOutcome | undefined {
	if (!file) return undefined;
	const name = file.name.toLowerCase();
	const valid = kind === "plugins" ? name.endsWith(".zip") : /\.(zip|skill)$/.test(name) || name === "skill.md";
	return valid
		? undefined
		: {
				tone: "danger",
				title: t(
					kind === "plugins" ? "extensionManagement.uploadPluginFailed" : "extensionManagement.uploadSkillFailed",
				),
				message: t(
					kind === "plugins"
						? "extensionManagement.uploadFormatUnsupported"
						: "extensionManagement.uploadSkillMissing",
				),
			};
}

export function ExtensionCreateMenu({
	kind,
	onUpload,
	buttonClassName = "settings-btn primary",
	buttonId,
	menuId,
}: {
	readonly kind: "plugins" | "skills";
	readonly onUpload: () => void;
	readonly buttonClassName?: string;
	readonly buttonId?: string;
	readonly menuId?: string;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [open]);
	return (
		<Popover
			bare
			open={open}
			onClose={() => setOpen(false)}
			placement="bottom-end"
			className="extension-management-create-popover"
			id={menuId}
			content={
				<Menu
					role="menu"
					aria-label={t("settingsNew")}
					ref={menu}
					onKeyDown={(event) => {
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						event.preventDefault();
						const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
						const index =
							document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
						buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
					}}
				>
					<MenuItem
						role="menuitem"
						icon="open"
						data-extension-upload={kind}
						data-market-upload={kind}
						onClick={() => {
							setOpen(false);
							onUpload();
						}}
					>
						{t(`extensionManagement.upload.${kind}`)}
					</MenuItem>
					<MenuItem
						role="menuitem"
						icon="stepcode"
						data-extension-create={kind}
						onClick={() => {
							setOpen(false);
							createExtensionWithStepCode(kind);
						}}
					>
						{t("extensionManagement.createWithStepCode")}
					</MenuItem>
				</Menu>
			}
		>
			<Button
				className={buttonClassName}
				id={buttonId ?? (kind === "plugins" ? "settingsPluginNew" : "settingsSkillNew")}
				aria-controls={open ? menuId : undefined}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<Icon name="plus" size="xs" />
				{t("settingsNew")}
			</Button>
		</Popover>
	);
}
