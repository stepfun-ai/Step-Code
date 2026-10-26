import {
	type CSSProperties,
	cloneElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	useId,
	useLayoutEffect,
	useRef,
} from "react";
import { cx } from "../../lib/format";
import { useMergedRef } from "../hooks/useMergedRef";
import styles from "./Tooltip.module.css";

/** Props the tooltip sets on its trigger; the trigger element must forward them to its DOM node. */
export interface TooltipTriggerProps {
	readonly style?: CSSProperties;
	readonly "aria-describedby"?: string;
	readonly "aria-label"?: string;
	readonly ref?: Ref<HTMLElement>;
}

export interface TooltipProps {
	/** Text or elements shown above the trigger. `null`, `undefined`, `false` or `""` render the trigger alone. */
	readonly content: ReactNode;
	/** One element that forwards `style` and `aria-describedby`, e.g. a `<button>` or an `IconButton`. */
	readonly children: ReactElement<TooltipTriggerProps>;
	/** Id of the hint element; generated when omitted. */
	readonly id?: string;
	/** Extra classes on the hint element, for feature-specific surface styles. */
	readonly className?: string;
	/**
	 * Passed through to the trigger (merged with its own), so a wrapper that
	 * clones its child, such as Popover, reaches the real element.
	 */
	readonly style?: CSSProperties;
	readonly ref?: Ref<HTMLElement>;
}

/**
 * Hover and keyboard-focus hint, placement "top": centered over its trigger and
 * shifted sideways only when a viewport edge leaves no room.
 *
 * The hint is rendered as the trigger's next sibling, not inside it and with no
 * wrapper, so the trigger's own layout and the selectors on it stay unchanged;
 * the hint is `position: fixed` and out of flow. It follows the trigger through
 * a unique CSS `anchor-name` set inline on the trigger, and is shown by CSS
 * (`:hover + hint`, `:focus-visible + hint`), so hovering costs no re-render.
 * It stays mounted while `content` is set.
 *
 * The hint is a manual popover, opened on mount and again whenever its trigger
 * is hovered or focused (a DOM move closes it). That only moves it to the top
 * layer: no ancestor's stacking context, `overflow` or containment (`.main` is
 * a size container) can paint a neighbouring panel over it or clip it. The CSS
 * above still decides whether it is displayed.
 *
 * `aria-describedby` points at the hint unless the hint repeats the trigger's
 * `aria-label` word for word, which would only make a screen reader say it twice.
 */
export function Tooltip({ content, children, id, className, style, ref }: TooltipProps) {
	const autoId = useId();
	const hintId = id ?? `tooltip-${autoId}`;
	const anchorName = `--tooltip-${autoId.replace(/[^\w-]/g, "")}`;
	const shown = content !== null && content !== undefined && content !== false && content !== "";
	const repeatsLabel = typeof content === "string" && content === children.props["aria-label"];
	const describedBy = cx(children.props["aria-describedby"], shown && !repeatsLabel && hintId) || undefined;
	const triggerRef = useMergedRef(ref, children.props.ref);
	const hintRef = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const hint = hintRef.current;
		// Browsers without the Popover API keep the in-flow fixed hint.
		if (!shown || !hint || typeof hint.showPopover !== "function") return;
		const open = () => {
			if (hint.isConnected && !hint.matches(":popover-open")) hint.showPopover();
		};
		open();
		// Moving a node in the DOM (a list reorder) closes its popover; reopen it before the hint shows.
		const trigger = hint.previousElementSibling;
		trigger?.addEventListener("pointerenter", open);
		trigger?.addEventListener("focusin", open);
		return () => {
			trigger?.removeEventListener("pointerenter", open);
			trigger?.removeEventListener("focusin", open);
		};
	}, [shown]);
	const triggerStyle = { ...children.props.style, ...style };
	// The trigger may carry another anchor name (a popover anchored to it); keep both.
	const ownAnchor = triggerStyle.anchorName;
	const trigger = cloneElement(children, {
		ref: triggerRef,
		style: { ...triggerStyle, anchorName: ownAnchor ? `${ownAnchor}, ${anchorName}` : anchorName },
		"aria-describedby": describedBy,
	});
	// The array keeps one shape whether or not the hint shows, so toggling `content` never remounts the trigger.
	return (
		<>
			{trigger}
			{shown ? (
				<span
					ref={hintRef}
					className={cx(styles.root, className)}
					id={hintId}
					role="tooltip"
					popover="manual"
					style={{ positionAnchor: anchorName }}
				>
					{content}
				</span>
			) : null}
		</>
	);
}
