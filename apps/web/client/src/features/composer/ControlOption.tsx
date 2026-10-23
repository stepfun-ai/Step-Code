/** Building blocks shared by the composer popovers (legacy app.js 2354-2478: `setupPopover`, `controlOption`, `hint`, `note`, `groupLabel`). */

import type { KeyboardEvent, ReactNode } from "react";
import { useT } from "../../i18n";
import { Icon, type IconName, Popover, type PopoverPlacement } from "../../ui";

export interface ControlOptionProps<T extends string> {
	readonly id: T;
	readonly icon?: IconName;
	readonly title: string;
	readonly description?: string;
	readonly meta?: readonly string[];
	readonly selected: boolean;
	/** Favourite (pin) toggle state; only meaningful with `onPin`. */
	readonly pinned?: boolean;
	readonly onPin?: () => void;
	readonly onSelect: (id: T) => void;
	/** Extra classes next to `control-option`, e.g. a per-mode accent carrier. */
	readonly className?: string;
}

/** One row in a composer popover: icon, title, description, optional trailing slot. */
export function ControlOption<T extends string>({
	id,
	icon,
	title,
	description,
	meta,
	selected,
	pinned = false,
	onPin,
	onSelect,
	className,
}: ControlOptionProps<T>) {
	const t = useT();
	// Legacy nested a <button> here. A button inside a button is invalid HTML
	// (React warns about it), so the pin is a focusable role=button span with
	// the same class, attributes and click/keyboard behaviour.
	const pin = (event: { stopPropagation(): void }) => {
		event.stopPropagation();
		onPin?.();
	};
	const pinKey = (event: KeyboardEvent<HTMLSpanElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		pin(event);
	};
	return (
		<button
			type="button"
			className={className ? `control-option ${className}` : "control-option"}
			role="option"
			aria-selected={selected ? "true" : "false"}
			onClick={() => onSelect(id)}
		>
			{icon ? <Icon name={icon} className="control-option-icon" /> : null}
			<span className="control-option-body">
				<span className="control-option-title">{title}</span>
				{description ? <span className="control-option-desc">{description}</span> : null}
				{meta?.length ? <span className="control-option-meta">{meta.join(" · ")}</span> : null}
			</span>
			{selected ? <Icon name="check" size="sm" className="control-option-check" /> : null}
			{onPin ? (
				// biome-ignore lint/a11y/useSemanticElements: a <button> cannot nest inside the option <button>; see above.
				<span
					className="control-option-pin"
					role="button"
					tabIndex={0}
					aria-pressed={pinned ? "true" : "false"}
					title={pinned ? t("unpin") : t("pin")}
					onClick={pin}
					onKeyDown={pinKey}
				>
					<Icon name="star" size="xs" />
				</span>
			) : null}
		</button>
	);
}

/** An empty-state row for a popover that has nothing to show (legacy `hint`). */
export function PopoverHint({ children }: { readonly children: ReactNode }) {
	return <div className="control-popover-empty">{children}</div>;
}

/** A small section heading inside a popover (legacy `groupLabel`). */
export function PopoverGroupLabel({ children }: { readonly children: ReactNode }) {
	return <div className="control-popover-group">{children}</div>;
}

export interface ControlMenuProps {
	/** `.control-menu` id: `policyMenu`, `modeMenu`, `modelMenu`. */
	readonly id: string;
	readonly triggerId: string;
	/** Extra trigger class next to `control-select` (`permission-control`, ...). */
	readonly triggerClassName: string;
	/** Hard-coded legacy trigger title (`执行权限`, `模式`, `模型与思考强度`). */
	readonly title: string;
	readonly icon: IconName;
	readonly labelId: string;
	readonly label: ReactNode;
	readonly popoverId: string;
	/** Above the trigger; `top-end` for a trigger at the composer's right edge. Default `top-start`. */
	readonly placement?: PopoverPlacement;
	readonly open: boolean;
	/** Trigger clicked while closed (legacy `open()`: render, then show). */
	readonly onOpen: () => void;
	readonly onClose: () => void;
	readonly children: ReactNode;
}

/**
 * `div.control-menu` with its `.control-select` trigger and `.control-popover`
 * listbox (legacy `setupPopover`): the trigger toggles, an outside pointerdown
 * or Escape closes, and Escape returns focus to the trigger.
 */
export function ControlMenu({
	id,
	triggerId,
	triggerClassName,
	title,
	icon,
	labelId,
	label,
	popoverId,
	placement = "top-start",
	open,
	onOpen,
	onClose,
	children,
}: ControlMenuProps) {
	return (
		<div className="control-menu" id={id}>
			<Popover
				bare
				className="control-popover"
				id={popoverId}
				role="listbox"
				aria-label={title}
				placement={placement}
				open={open}
				onClose={onClose}
				content={children}
			>
				<button
					className={`control-select ${triggerClassName}`}
					id={triggerId}
					type="button"
					aria-haspopup="listbox"
					aria-expanded={open ? "true" : "false"}
					title={title}
					onClick={() => (open ? onClose() : onOpen())}
				>
					<Icon name={icon} />
					<span id={labelId}>{label}</span>
					<Icon name="chevron" size="2xs" className="chevron" />
				</button>
			</Popover>
		</div>
	);
}
