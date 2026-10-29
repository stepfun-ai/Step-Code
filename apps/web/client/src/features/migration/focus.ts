import { type KeyboardEvent, useEffect, useRef } from "react";

const focusable =
	'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]';
export function trapMigrationFocus(event: KeyboardEvent<HTMLElement>): void {
	if (event.key !== "Tab" || event.defaultPrevented) return;
	const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(focusable)).filter(
		(item) => !item.closest("[hidden], [inert]") && item.getClientRects().length > 0,
	);
	const first = items[0];
	const last = items[items.length - 1];
	if (!first || !last) {
		event.preventDefault();
		event.currentTarget.focus();
		return;
	}
	if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
		event.preventDefault();
		last.focus();
	} else if (
		!event.shiftKey &&
		(document.activeElement === last || !event.currentTarget.contains(document.activeElement))
	) {
		event.preventDefault();
		first.focus();
	}
}
/** Preserve existing inert owners and return focus only to a connected trigger. */
export function useMigrationDialogFocus(open: boolean) {
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (!open || !dialog) return;
		const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const changed: HTMLElement[] = [];
		let ancestor: HTMLElement | null = dialog.parentElement;
		while (ancestor && ancestor !== document.body) {
			for (const sibling of Array.from(ancestor.parentElement?.children ?? [])) {
				if (sibling instanceof HTMLElement && sibling !== ancestor && !sibling.inert) {
					sibling.inert = true;
					changed.push(sibling);
				}
			}
			ancestor = ancestor.parentElement;
		}
		dialog.focus({ preventScroll: true });
		return () => {
			for (const item of changed) item.inert = false;
			if (trigger?.isConnected && !trigger.closest("[hidden], [inert]")) trigger.focus({ preventScroll: true });
		};
	}, [open]);
	return ref;
}
