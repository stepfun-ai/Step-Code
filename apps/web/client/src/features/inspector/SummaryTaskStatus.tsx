import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../ui";
import type { InspectorTaskStatus } from "./model";

export function SummaryTaskStatus({ status }: { readonly status: InspectorTaskStatus }) {
	const slot = useRef<HTMLSpanElement>(null);
	const spinner = useRef<HTMLSpanElement>(null);
	const result = useRef<HTMLSpanElement>(null);
	const mark = useRef<HTMLSpanElement>(null);
	const previous = useRef(status);
	const [settling, setSettling] = useState(false);
	const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
	useEffect(() => {
		const media = matchMedia("(prefers-reduced-motion: reduce)");
		const change = () => setReduced(media.matches);
		media.addEventListener("change", change);
		return () => media.removeEventListener("change", change);
	}, []);
	useLayoutEffect(() => {
		const completed = previous.current !== "completed" && status === "completed";
		previous.current = status;
		setSettling(false);
		if (!completed || reduced || !slot.current || !spinner.current || !result.current || !mark.current) return;
		setSettling(true);
		const cubicOut = "cubic-bezier(.215,.61,.355,1)";
		const animations = [
			slot.current.animate(
				[
					{ transform: "scale(1)", offset: 0, easing: cubicOut },
					{ transform: "scale(.18)", offset: 180 / 660, easing: "linear" },
					{ transform: "scale(.18)", offset: 250 / 660, easing: "cubic-bezier(.55,.055,.675,.19)" },
					{ transform: "scale(1)", offset: 460 / 660 },
					{ transform: "scale(1)", offset: 1 },
				],
				{ duration: 660, fill: "both" },
			),
			spinner.current.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 180, duration: 70, fill: "both" }),
			result.current.animate([{ opacity: 0 }, { opacity: 1 }], { delay: 180, duration: 70, fill: "both" }),
			mark.current.animate([{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], {
				delay: 460,
				duration: 200,
				easing: cubicOut,
				fill: "both",
			}),
		];
		let cancelled = false;
		void Promise.all(animations.map((animation) => animation.finished))
			.then(() => {
				if (!cancelled) setSettling(false);
			})
			.catch(() => {
				// Cleanup cancels these owned animations when the row or preference changes.
			});
		return () => {
			cancelled = true;
			for (const animation of animations) animation.cancel();
		};
	}, [status, reduced]);
	return (
		<span ref={slot} className="sb-status" data-state={status} data-settling={settling} aria-hidden="true">
			{status === "pending" || status === "aborted" ? (
				<Icon name={status === "pending" ? "circle" : "triangleAlert"} size="xs" />
			) : null}
			<span ref={spinner} className="sb-status-spinner">
				<Icon name="loaderCircle" size="sm" />
			</span>
			<span ref={result} className="sb-status-result">
				<Icon name="summaryRing" size="sm" />
				<span ref={mark} className="sb-status-mark">
					<Icon name="summaryCheck" size="sm" />
				</span>
			</span>
		</span>
	);
}
