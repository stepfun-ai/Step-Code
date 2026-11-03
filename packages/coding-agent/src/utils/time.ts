/**
 * Compact elapsed-time format shared by the CLI chrome (working row, turn-done
 * marker, thinking summary) and extension status texts, so every elapsed
 * readout uses the same scale ("90s" never shows next to "1m 30s").
 */
export function formatElapsedTime(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}
