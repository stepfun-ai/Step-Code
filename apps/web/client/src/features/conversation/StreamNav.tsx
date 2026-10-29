import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { splitAttachedFiles } from "../../lib/attached-files";
import { cx } from "../../lib/format";
import { skillInvocation } from "../../lib/markdown";
import { setUi, useAppStore } from "../../state/store";
import type { TimelineItem } from "../../state/types";

/**
 * The conversation locator: a thin rail
 * on the right of the middle column with one tick per user query. Clicking a
 * tick scrolls the stream to that message (through `ui.revealEntry`, like a
 * search hit), the tick of the query the viewport is on stays dark, and
 * hovering shows what the query and its reply said.
 *
 * The rail is not virtualised: the stream itself renders every row, so a few
 * dozen small buttons cost nothing next to it.
 */

/** One tick: a user query and a summary of the reply that followed it. */
interface NavTick {
	readonly entryId: string;
	readonly userText: string;
	readonly assistantText: string;
	readonly isRunning: boolean;
}

const USER_PREVIEW_MAX = 160;
const ASSISTANT_PREVIEW_MAX = 220;
/** Below this middle-column width the rail would crowd the message column. */
const RAIL_MIN_WIDTH = 860;

function clipText(text: string, max: number): string {
	const flat = text.trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A query as shown elsewhere (sidebar search's `skillPreview`): a skill invocation reads `name · request`. */
function queryPreview(content: string): string {
	const text = splitAttachedFiles(content).text;
	const skill = text ? skillInvocation(text) : null;
	if (!skill) return text;
	return skill.request ? `${skill.name} · ${skill.request}` : skill.name;
}

/**
 * One tick per recorded user message; the live pending bubble and steering
 * rows carry no entry id and stay out until the host has recorded them.
 */
function buildTicks(items: readonly TimelineItem[], running: boolean): NavTick[] {
	const ticks: Array<{ tick: Omit<NavTick, "assistantText" | "isRunning">; parts: string[] }> = [];
	for (const item of items) {
		if (item.kind !== "message") continue;
		if (item.role === "user") {
			if (!item.entryId) continue;
			ticks.push({
				tick: {
					entryId: item.entryId,
					userText: clipText(queryPreview(item.content), USER_PREVIEW_MAX),
				},
				parts: [],
			});
		} else if (item.role === "assistant" && ticks.length && item.content.trim()) {
			ticks[ticks.length - 1].parts.push(item.content.trim());
		}
	}
	return ticks.map(({ tick, parts }, index) => ({
		...tick,
		assistantText: clipText(parts.join("\n"), ASSISTANT_PREVIEW_MAX),
		// Only the last query can be the one a running turn answers.
		isRunning: running && index === ticks.length - 1,
	}));
}

/**
 * The query the viewport is on: the first tick whose row still intersects the
 * viewport, or — when the top edge sits inside a reply — the
 * last tick entirely above it. Rows and ticks are in the same order.
 */
function resolveActiveTick(stream: HTMLElement, ticks: readonly NavTick[]): number {
	const inner = stream.querySelector<HTMLElement>("#streamInner");
	const view = stream.getBoundingClientRect();
	let lastAbove = 0;
	for (const [index, { entryId }] of ticks.entries()) {
		const row = (inner ?? stream).querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
		if (!row) continue;
		const box = row.getBoundingClientRect();
		if (box.top < view.bottom && box.bottom > view.top) return index;
		if (box.bottom <= view.top) lastAbove = index;
	}
	return lastAbove;
}

/** Hover/focus "mountain": bars shrink and fade with distance from the focused tick. */
function barVisual(
	index: number,
	focusIndex: number | undefined,
): { readonly scaleX: number; readonly opacity: number; readonly strong: boolean } {
	if (focusIndex === undefined) return { scaleX: 1, opacity: 0.58, strong: false };
	const distance = Math.abs(index - focusIndex);
	if (distance === 0) return { scaleX: 2.6, opacity: 1, strong: true };
	if (distance === 1) return { scaleX: 1.7, opacity: 0.86, strong: false };
	if (distance === 2) return { scaleX: 1.25, opacity: 0.72, strong: false };
	return { scaleX: 1, opacity: 0.58, strong: false };
}

function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return reduced;
}

export function StreamNav() {
	const t = useT();
	const items = useAppStore((state) => state.timelineItems);
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	const running = useAppStore((state) => state.current?.status === "running");
	const [activeIndex, setActiveIndex] = useState(0);
	// The tick under the pointer or keyboard focus; undefined lets the scroll position own the colour.
	const [interactionIndex, setInteractionIndex] = useState<number | undefined>(undefined);
	// The open preview card: which tick it explains, placed from that tick's viewport box.
	const [preview, setPreview] = useState<{
		readonly index: number;
		readonly left: number;
		readonly top: number;
	} | null>(null);
	// Whether the middle column is wide enough for the rail. Measured on `main`
	// by hand: a CSS container query would need `container-type` on `.main`,
	// whose layout containment changes how `position: fixed` descendants inside
	// it (e.g. the composer's full-window drag overlay) are contained.
	const [wide, setWide] = useState(false);
	// The terminal dock's height: the rail stays over the conversation, never over the dock below it.
	const [dockHeight, setDockHeight] = useState(0);
	const railRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const reducedMotion = usePrefersReducedMotion();
	const ticks = useMemo(() => buildTicks(items, running), [items, running]);

	useEffect(() => {
		const main = document.querySelector("main.main");
		if (!main) return;
		const dock = document.getElementById("terminalDock");
		const update = () => {
			setWide(main.clientWidth >= RAIL_MIN_WIDTH);
			// A hidden dock measures 0.
			setDockHeight(dock?.offsetHeight ?? 0);
		};
		const observer = new ResizeObserver(update);
		observer.observe(main);
		if (dock) observer.observe(dock);
		update();
		return () => observer.disconnect();
	}, []);

	// The listeners read the ticks through a ref so a streaming re-projection
	// re-syncs without re-attaching them.
	const ticksRef = useRef(ticks);
	useEffect(() => {
		ticksRef.current = ticks;
	});
	const syncRef = useRef<() => void>(() => {});
	useEffect(() => {
		const stream = document.getElementById("stream");
		if (!stream) return;
		let frame = 0;
		const sync = () => {
			frame = 0;
			const next = resolveActiveTick(stream, ticksRef.current);
			setActiveIndex((current) => (current === next ? current : next));
		};
		const request = () => {
			if (!frame) frame = requestAnimationFrame(sync);
		};
		syncRef.current = sync;
		sync();
		stream.addEventListener("scroll", request, { passive: true });
		// The panel widths resize the viewport without a scroll event.
		const resize = new ResizeObserver(request);
		resize.observe(stream);
		return () => {
			stream.removeEventListener("scroll", request);
			resize.disconnect();
			if (frame) cancelAnimationFrame(frame);
			syncRef.current = () => {};
		};
	}, []);
	// Rows appeared or grew: the viewport may sit on another query now.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ticks changes are the trigger; the sync reads them through its ref.
	useEffect(() => {
		syncRef.current();
	}, [ticks]);

	// Keep the active tick inside the rail's own window, by hand: scrollIntoView
	// may also scroll the stream the rail floats over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ticks.length re-runs it once the tick rows exist.
	useLayoutEffect(() => {
		const rail = railRef.current;
		const item = listRef.current?.querySelector<HTMLElement>(`.stream-nav-tick[data-index="${activeIndex}"]`);
		if (!rail || !item) return;
		const top = item.offsetTop;
		const bottom = top + item.offsetHeight;
		if (top < rail.scrollTop) rail.scrollTop = top;
		else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
	}, [activeIndex, ticks.length]);

	if (!wide || ticks.length < 2 || !sessionId) return null;
	const shown = preview ? ticks[preview.index] : undefined;
	const openPreview = (button: HTMLElement, index: number) => {
		setInteractionIndex(index);
		const box = button.getBoundingClientRect();
		setPreview({ index, left: box.left, top: box.top + box.height / 2 });
	};
	const closePreview = () => {
		setInteractionIndex(undefined);
		setPreview(null);
	};
	return (
		<nav
			className="stream-nav"
			aria-label={t("streamNavLabel")}
			style={dockHeight ? { bottom: dockHeight } : undefined}
		>
			<div className="stream-nav-rail" ref={railRef} onPointerLeave={closePreview} onScroll={closePreview}>
				<div className="stream-nav-list" ref={listRef}>
					{ticks.map((tick, index) => {
						const active = index === activeIndex;
						const visual = barVisual(index, interactionIndex);
						// Without an interaction, the active tick owns the strong colour.
						const strong = interactionIndex === undefined ? active : visual.strong;
						const opacity =
							interactionIndex === undefined && active
								? 0.9
								: tick.isRunning
									? Math.max(visual.opacity, 0.72)
									: visual.opacity;
						return (
							<button
								type="button"
								className="stream-nav-tick"
								key={tick.entryId}
								aria-current={active ? "location" : undefined}
								aria-label={t("streamNavJump", { index: index + 1 })}
								aria-describedby={preview?.index === index ? "streamNavPreview" : undefined}
								data-index={index}
								data-active={active ? "true" : "false"}
								onClick={() =>
									setUi({
										revealEntry: {
											sessionId,
											entryId: tick.entryId,
											// The jump lands the query at the viewport top, so the
											// tick that owns the viewport after the jump is the clicked one.
											behavior: reducedMotion ? "auto" : "smooth",
											block: "start",
										},
									})
								}
								onFocus={(event) => openPreview(event.currentTarget, index)}
								onBlur={closePreview}
								onPointerEnter={(event) => openPreview(event.currentTarget, index)}
								onPointerLeave={closePreview}
							>
								<span
									className={cx("stream-nav-bar", strong && "stream-nav-bar--strong")}
									style={{ opacity, transform: `scaleX(${visual.scaleX})` }}
								/>
							</button>
						);
					})}
				</div>
			</div>
			{shown && preview
				? createPortal(
						// Placed by geometry, not CSS anchor positioning: the anchor() form
						// intermittently failed to resolve in this scrolling, transformed rail,
						// which left the card unpositioned and clipped at the viewport edge.
						<div
							className="stream-nav-card"
							id="streamNavPreview"
							role="tooltip"
							style={{ right: window.innerWidth - preview.left + 10, top: preview.top }}
						>
							<p className="stream-nav-card-user">{shown.userText || t("streamNavNoText")}</p>
							<p className="stream-nav-card-reply">
								{shown.isRunning ? t("streamNavRunning") : shown.assistantText || t("streamNavNoReply")}
							</p>
						</div>,
						document.body,
					)
				: null}
		</nav>
	);
}
