import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { UsageOverview } from "./types.ts";

export function overviewDates(now = new Date()): string[] {
	const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const dates: string[] = [];
	for (let i = 364; i >= 0; i--) {
		const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() - i);
		dates.push(
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
		);
	}
	return dates;
}

export function scanUsageOverview(
	roots: string[],
	cacheDir: string,
	cwd: string,
	scope: "all" | "project",
	signal: AbortSignal,
): Promise<UsageOverview> {
	const dates = overviewDates(),
		timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const key = createHash("sha256")
		.update(JSON.stringify([roots, cwd, scope, dates[0], dates.at(-1), timezone, 1]))
		.digest("hex");
	const workerData = { roots, cwd, scope, dates, timezone, key, cachePath: join(cacheDir, `activity-${key}.jsonl`) };
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Activity scan cancelled"));
			return;
		}
		const url = new URL(
			import.meta.url.endsWith(".ts") ? "./activity-worker.ts" : "./activity-worker.js",
			import.meta.url,
		);
		const worker = new Worker(
			typeof process.versions.bun === "string" ? "./src/step/usage/activity-worker.ts" : url,
			{ workerData, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } },
		);
		let settled = false;
		const finish = (error?: Error, overview?: UsageOverview, cooperative = false): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (cooperative) {
				worker.postMessage({ cancel: true });
				const kill = setTimeout(() => {
					void worker.terminate();
				}, 200);
				worker.once("exit", () => clearTimeout(kill));
			} else void worker.terminate();
			if (error) reject(error);
			else if (overview) resolve(overview);
			else reject(new Error("Invalid activity worker result"));
		};
		const abort = (): void => finish(new Error("Activity scan cancelled"), undefined, true);
		const timer = setTimeout(() => finish(new Error("Activity scan resource limit reached")), 30000);
		signal.addEventListener("abort", abort, { once: true });
		worker.once("message", (message: { overview?: UsageOverview; error?: string }) =>
			finish(message.error ? new Error(message.error) : undefined, message.overview),
		);
		worker.once("error", () => finish(new Error("Activity scan unavailable or resource limited")));
		worker.once("exit", () => {
			if (!settled) finish(new Error("Activity worker exited before completion"));
		});
	});
}
