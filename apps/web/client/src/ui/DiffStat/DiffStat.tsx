import type { ComponentPropsWithRef } from "react";
import { cx } from "../../lib/format";
import styles from "./DiffStat.module.css";

export interface DiffStatProps extends ComponentPropsWithRef<"span"> {
	readonly additions: number;
	readonly deletions: number;
}

/** `+12 -3` in the success and danger colours. */
export function DiffStat({ additions, deletions, className, ...rest }: DiffStatProps) {
	return (
		<span className={cx(styles.root, "diff-stat", className)} {...rest}>
			{/* A zero count carries no signal, so it stays neutral rather than green or red. */}
			<span className={additions ? styles.add : styles.zero}>{`+${additions}`}</span>
			<span className={deletions ? styles.del : styles.zero}>{`-${deletions}`}</span>
		</span>
	);
}
