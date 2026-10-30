/**
 * The row being dragged in the sidebar, for the duration of one HTML5 drag.
 *
 * A drop target may not read `DataTransfer` data while a row is over it (the
 * browser keeps the payload private until the drop), so the list the row came
 * from rides here instead. Reordering only moves an unpinned row inside its own
 * list: a row dropped on another project's row does nothing, a row dropped on a
 * pinned row does nothing (the pinned block is fixed at the top), and inside the
 * grouped view the event is left to the `GroupedSection` underneath, which
 * retags the session instead.
 */

export interface DraggedSession {
	readonly sessionId: string;
	/** The list the row was grabbed from (a project folder, Recent, or a tag section). */
	readonly listId: string;
	/** A pinned row is never draggable; the flag lets a drop target refuse it too. */
	readonly pinned: boolean;
}

let dragged: DraggedSession | null = null;

export function beginSessionDrag(sessionId: string, listId: string, pinned: boolean): void {
	dragged = { sessionId, listId, pinned };
}

export function endSessionDrag(): void {
	dragged = null;
}

export function draggedSession(): DraggedSession | null {
	return dragged;
}

/**
 * Whether `sessionId`'s row may take this drag: the same list, a different row,
 * and neither row pinned. The pinned block is a fixed area at the top — a drag
 * can neither enter it nor move a row above it.
 */
export function canReorder(
	source: DraggedSession | null,
	listId: string,
	sessionId: string,
	targetPinned: boolean,
): source is DraggedSession {
	if (source === null || source.listId !== listId || source.sessionId === sessionId) return false;
	return !source.pinned && !targetPinned;
}

/**
 * Which side of `element` a drag at `clientY` asks for: the half a released
 * pointer is over decides whether the row lands above or below it.
 */
export function dropPlaceAt(element: Element, clientY: number): "before" | "after" {
	const rect = element.getBoundingClientRect();
	return clientY < rect.top + rect.height / 2 ? "before" : "after";
}
