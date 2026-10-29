/**
 * The right rail's context entry: a ring whose ink arc is how much of the
 * model's context window the open session fills, clockwise from twelve
 * o'clock. Unknown (a draft, or no reading yet) draws the empty track only,
 * never a made-up zero. The track and arc use theme tokens, so it reads in the
 * dark theme too. Drawn at the sprite icons' 18px.
 */

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({ percent }: { readonly percent?: number }) {
	const fill = percent === undefined ? 0 : Math.min(100, Math.max(0, percent));
	// A non-zero reading always shows a sliver, so 0.4% does not look like "unknown".
	const arc = fill > 0 ? Math.max(fill / 100, 0.04) * CIRCUMFERENCE : 0;
	return (
		<svg className="context-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
			<circle className="context-ring-track" cx="9" cy="9" r={RADIUS} />
			{arc > 0 ? (
				<circle
					className="context-ring-fill"
					cx="9"
					cy="9"
					r={RADIUS}
					strokeDasharray={`${arc} ${CIRCUMFERENCE}`}
					transform="rotate(-90 9 9)"
				/>
			) : null}
		</svg>
	);
}
