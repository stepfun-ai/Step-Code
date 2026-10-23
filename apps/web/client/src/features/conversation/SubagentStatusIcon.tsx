import { useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import type { SubagentStatus } from "../../state/types";
import { Icon, type IconName } from "../../ui";

const STATUS_ICON: Readonly<Record<SubagentStatus, IconName>> = {
	queued: "circle",
	running: "loaderCircle",
	completed: "circleCheck",
	failed: "circleX",
	// Stopped on request is not a fault: a neutral stop mark, not a warning triangle.
	aborted: "circleMinus",
	skipped: "circleMinus",
	unknown: "circle",
};

/** Fixed DFSC status slot: the bot icon and trailing disclosure never change identity. */
export function SubagentStatusIcon({ status }: { readonly status: SubagentStatus }) {
	const t = useT();
	const slot = useRef<HTMLSpanElement>(null);
	const previous = useRef(status);
	useLayoutEffect(() => {
		const wasActive = previous.current === "queued" || previous.current === "running";
		previous.current = status;
		if (
			!wasActive ||
			!["completed", "failed", "aborted"].includes(status) ||
			matchMedia("(prefers-reduced-motion: reduce)").matches
		)
			return;
		const animation = slot.current?.animate(
			[
				{ transform: "scale(1)", offset: 0, easing: "cubic-bezier(.215,.61,.355,1)" },
				{ transform: "scale(.18)", offset: 180 / 660 },
				{ transform: "scale(.18)", offset: 250 / 660, easing: "cubic-bezier(.55,.055,.675,.19)" },
				{ transform: "scale(1)", offset: 460 / 660 },
				{ transform: "scale(1)", offset: 1 },
			],
			{ duration: 660 },
		);
		return () => animation?.cancel();
	}, [status]);
	return (
		<span
			ref={slot}
			className="subagent-status-icon"
			data-state={status}
			role="img"
			aria-label={t(`subagentStatus.${status}`)}
			data-tooltip={t(`subagentStatus.${status}`)}
		>
			<Icon name={STATUS_ICON[status]} size="xs" />
		</span>
	);
}
