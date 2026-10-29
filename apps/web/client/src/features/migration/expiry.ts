import { useEffect, useState } from "react";

/** Re-evaluate consent gates at expiry without an interval or reads while hidden. */
export function useMigrationExpiry(visible: boolean, expiresAt: string | null): boolean {
	const [, refresh] = useState(0);
	useEffect(() => {
		if (!visible || !expiresAt) return;
		const delay = Date.parse(expiresAt) - Date.now();
		if (!Number.isFinite(delay) || delay <= 0) return;
		const timer = setTimeout(() => refresh((value) => value + 1), Math.min(delay + 1, 2_147_483_647));
		return () => clearTimeout(timer);
	}, [visible, expiresAt]);
	return !!expiresAt && !(Date.parse(expiresAt) > Date.now());
}
