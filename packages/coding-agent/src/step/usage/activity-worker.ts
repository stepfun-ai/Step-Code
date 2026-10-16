import { parentPort, workerData } from "node:worker_threads";
import { type ActivityScanOptions, scanActivity } from "./activity-engine.ts";

if (parentPort) {
	const controller = new AbortController();
	parentPort.on("message", (message) => {
		if (message?.cancel === true) controller.abort();
	});
	void scanActivity(workerData as ActivityScanOptions, controller.signal)
		.then((overview) => parentPort!.postMessage({ overview }))
		.catch(() => parentPort!.postMessage({ error: "Local activity scan unavailable. Retry to rebuild its cache." }));
}
