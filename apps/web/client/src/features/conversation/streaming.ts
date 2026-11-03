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
/**
 * Shortest time between two revealed steps (about 30 a second). Each step
 * re-parses and re-lays out the whole Markdown message, so following a 120 Hz
 * display frame by frame cost four times the work for no visible difference.
 */
export const REVEAL_STEP_MS = 33;

function cutAt(text: string, length: number): string {
	// Do not split a surrogate pair.
	const code = text.charCodeAt(length - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length + 1 : length);
}

/**
 * `target` revealed progressively while `live`; the whole text otherwise.
 * Text that is replaced rather than extended is shown at once. A view that
 * mounts in the middle of a stream (a thought opened while it runs) passes
 * `shownAtMount`: what had arrived by then shows at once, and only what
 * arrives later is revealed.
 */
export function useSmoothText(target: string, live: boolean, shownAtMount = ""): string {
	const [shown, setShown] = useState(live ? shownAtMount : target);
	const shownRef = useRef(shown);
	shownRef.current = shown;
	// The step clock outlives each target: new text arriving more often than a
	// step would otherwise restart the wait every time and never reveal anything.
	const lastStep = useRef(0);
	useEffect(() => {
		if (!live || !target.startsWith(shownRef.current)) {
			setShown(target);
			return;
		}
		let frame = 0;
		// After a pause, the first step counts from one step ago, not from the pause's
		// start: the reveal resumes at its usual pace instead of jumping ahead.
		lastStep.current = Math.max(lastStep.current, performance.now() - REVEAL_STEP_MS);
		const step = (now: number) => {
			const since = now - lastStep.current;
			// Frames in between only wait; the pace below is per elapsed time, so it is unchanged.
			if (since < REVEAL_STEP_MS) {
				frame = requestAnimationFrame(step);
				return;
			}
			const elapsed = Math.min(64, since);
			lastStep.current = now;
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
