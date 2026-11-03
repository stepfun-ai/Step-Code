/**
 * Sleep helper that respects abort signal.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	// Node turns delays larger than int32 into a 1ms timer. A long Retry-After
	// must wait (or be cancelled), rather than accidentally hammering the server.
	let remaining = ms;
	do {
		const delay = Math.min(2_147_483_647, remaining);
		await sleepChunk(delay, signal);
		remaining -= delay;
	} while (remaining > 0);
}

function sleepChunk(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
