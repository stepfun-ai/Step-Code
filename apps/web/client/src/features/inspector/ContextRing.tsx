/**
 * The right rail's context entry: a pie whose solid wedge is how much of the
 * model's context window the open session fills, clockwise from twelve
 * o'clock, inside a thin outline with a gap between them. Unknown (a draft, or
 * no reading yet) draws the outline only, never a made-up zero. Both take the
 * rail button's colour like the other rail icons, so it follows hover and both
 * themes. Drawn at the sprite icons' 18px.
 */

const CENTER = 9;
const OUTLINE_RADIUS = 7.25;
const WEDGE_RADIUS = 5;

/** The wedge for `fill` percent (0 < fill < 100), as a path from the centre. */
function wedgePath(fill: number): string {
	const angle = (fill / 100) * 2 * Math.PI;
	const x = CENTER + WEDGE_RADIUS * Math.sin(angle);
	const y = CENTER - WEDGE_RADIUS * Math.cos(angle);
	const largeArc = angle > Math.PI ? 1 : 0;
	return `M${CENTER} ${CENTER}V${CENTER - WEDGE_RADIUS}A${WEDGE_RADIUS} ${WEDGE_RADIUS} 0 ${largeArc} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}

export function ContextRing({ percent }: { readonly percent?: number }) {
	const fill = percent === undefined ? 0 : Math.min(100, Math.max(0, percent));
	// A non-zero reading always shows a sliver, so 0.4% does not look like "unknown".
	const shown = fill > 0 ? Math.max(fill, 4) : 0;
	return (
		<svg className="context-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
			<circle className="context-ring-track" cx={CENTER} cy={CENTER} r={OUTLINE_RADIUS} />
			{shown >= 100 ? (
				<circle className="context-ring-fill" cx={CENTER} cy={CENTER} r={WEDGE_RADIUS} />
			) : shown > 0 ? (
				<path className="context-ring-fill" d={wedgePath(shown)} />
			) : null}
		</svg>
	);
}
