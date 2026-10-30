import { useEffect, useRef, useState } from "react";

export const COPIED_FEEDBACK_MS = 2000;

/** `[copied, flash]`: `flash()` turns `copied` on for `COPIED_FEEDBACK_MS`. */
export function useCopiedFlag(): readonly [boolean, () => void] {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const flash = () => {
		clearTimeout(timer.current);
		setCopied(true);
		timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
	};
	return [copied, flash];
}
