/**
 * Streaming polish for the live assistant message.
 *
 * Tokens arrive in bursts (the session batches `message_update` per frame and
 * the provider itself sends chunks), so drawing them as they come makes the
 * reply jump forward a line at a time. `useSmoothText` lets the shown text
 * trail the received text and catch up at a steady pace.
 */

import { useEffect, useRef, useState } from "react";

/** The shown text never trails by more than about this long. */
const CATCH_UP_MS = 240;
/** Slowest pace, in characters per millisecond, so a short tail does not crawl. */
const MIN_RATE = 0.06;

function cutAt(text: string, length: number): string {
	// Do not split a surrogate pair.
	const code = text.charCodeAt(length - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length + 1 : length);
}

/**
 * `target` revealed progressively while `live`; the whole text otherwise.
 * Text that is replaced rather than extended is shown at once.
 */
export function useSmoothText(target: string, live: boolean): string {
	const [shown, setShown] = useState(live ? "" : target);
	const shownRef = useRef(shown);
	shownRef.current = shown;
	useEffect(() => {
		if (!live || !target.startsWith(shownRef.current)) {
			setShown(target);
			return;
		}
		let frame = 0;
		let last = performance.now();
		const step = (now: number) => {
			const elapsed = Math.min(64, now - last);
			last = now;
			const current = shownRef.current;
			const backlog = target.length - current.length;
			if (backlog <= 0) return;
			const advance = Math.ceil(Math.max(backlog * (elapsed / CATCH_UP_MS), elapsed * MIN_RATE));
			const next = cutAt(target, Math.min(target.length, current.length + advance));
			shownRef.current = next;
			setShown(next);
			if (next.length < target.length) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [target, live]);
	return live ? shown : target;
}
