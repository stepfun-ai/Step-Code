import { memo, useEffect, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { cx } from "../../lib/format";
import type { RetryTimelineItem, SessionRetry } from "../../state/types";
import { Icon } from "../../ui";

/** Whole seconds until the backoff ends, then seconds spent waiting on the retried request. */
function retryTimer(retry: SessionRetry, now: number, t: TranslateFn): string {
	const resumeAt = retry.startedAt + retry.delayMs;
	if (now < resumeAt) return t("modelRetryIn", { seconds: Math.ceil((resumeAt - now) / 1000) });
	return t("modelRetryWaiting", { seconds: Math.floor((now - resumeAt) / 1000) });
}

/** The clock, ticking once a second while `active`. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

/**
 * Failed model requests the kernel retried (state/session.ts folds them into
 * one item). While a retry is under way the row says which attempt runs and
 * counts down the backoff, then the time spent on the retried request: a
 * gateway timeout can take a minute per attempt, and without it the page sat
 * still. Expanding the row lists each attempt's error.
 */
export const RetryRow = memo(function RetryRow({ item }: { readonly item: RetryTimelineItem }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const live = item.live;
	const now = useNow(live !== undefined);
	const label = live
		? t(live.reason === "rate_limit" ? "modelRetryingRateLimit" : "modelRetrying", {
				attempt: live.attempt,
				max: live.maxAttempts,
			})
		: t("modelRetried", { count: item.errors.length });
	const timer = live ? retryTimer(live, now, t) : "";
	return (
		<div className={cx("tool-call retry-call", live && "live", open && "open")}>
			<div className={cx("tool-row", live ? "pending" : "completed", open && "open")}>
				<button
					type="button"
					className="tool-toggle"
					aria-label={label}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				></button>
				<span className="tool-glyph" aria-hidden="true">
					<Icon className="tool-kind-icon" name="refresh" size="xs" />
					<Icon className="tool-twisty" name="chevronRight" size="2xs" />
				</span>
				{/* Only the live row is a status region, so a screen reader hears each new attempt but not history. */}
				{live ? (
					<output className="tool-verb">
						{label}
						<span className="tool-pending" data-label={label} aria-hidden="true" />
					</output>
				) : (
					<span className="tool-verb">{label}</span>
				)}
				{timer ? (
					<>
						<span className="tool-dot" aria-hidden="true">
							·
						</span>
						<span className="retry-timer">{timer}</span>
					</>
				) : null}
			</div>
			{open ? (
				<div className="tool-cx retry-errors">
					<div className="tool-cx-head">
						<span className="tool-cx-summary">{t("modelRetryErrors")}</span>
					</div>
					<ol className="retry-error-list">
						{item.errors.map((error, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the list only grows at the end; equal texts are interchangeable.
							<li key={index}>{error}</li>
						))}
					</ol>
				</div>
			) : null}
		</div>
	);
});
