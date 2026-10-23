import { type RefObject, useEffect, useRef } from "react";

export type DismissEvent = "pointerdown" | "click";

export interface DismissOptions {
	/** Only listen while true. */
	readonly enabled: boolean;
	/**
	 * Elements that count as "inside": a press on any of them does not dismiss.
	 * Include the trigger, or the press that opens the overlay closes it again.
	 */
	readonly insideRefs: ReadonlyArray<RefObject<Element | null>>;
	/** Called on an outside press, or on Escape when `escape` is set. */
	readonly onDismiss: (reason: "outside" | "escape") => void;
	/** Document event that counts as an outside press. Legacy popovers used pointerdown; menus used click. */
	readonly event?: DismissEvent | false;
	/** Also dismiss on Escape. */
	readonly escape?: boolean;
}

/**
 * Outside-press and Escape dismissal for overlays that stay mounted and toggle
 * `hidden`. Listeners are attached to `document` only while enabled.
 */
export function useDismiss({
	enabled,
	insideRefs,
	onDismiss,
	event = "pointerdown",
	escape: closeOnEscape = true,
}: DismissOptions): void {
	const latest = useRef({ insideRefs, onDismiss });
	latest.current = { insideRefs, onDismiss };
	useEffect(() => {
		if (!enabled) return;
		const onPress = (pressEvent: Event) => {
			const target = pressEvent.target;
			if (!(target instanceof Node)) return;
			if (latest.current.insideRefs.some((ref) => ref.current?.contains(target))) return;
			latest.current.onDismiss("outside");
		};
		// Capture phase, so the overlay hears Escape before the shell's document listener; marking the
		// event handled tells that chain this press closed a layer already and must not close the next.
		const onKeyDown = (keyEvent: KeyboardEvent) => {
			if (keyEvent.key !== "Escape") return;
			keyEvent.preventDefault();
			latest.current.onDismiss("escape");
		};
		if (event) document.addEventListener(event, onPress);
		if (closeOnEscape) document.addEventListener("keydown", onKeyDown, true);
		return () => {
			if (event) document.removeEventListener(event, onPress);
			if (closeOnEscape) document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [enabled, event, closeOnEscape]);
}
