/**
 * Local, offline reproduction of the subagent event-log amplification.
 *
 * Everything below is production code except the two test doubles the repo's
 * testing policy already sanctions:
 *   - the parent model (faux provider, no network),
 *   - the child (a fake `step --mode rpc` process that only streams tokens).
 *
 * The measured path is real end to end:
 *   child stdout -> routeSubagentRpcLine -> parseJsonEvent -> onUpdate
 *   -> execute.emit -> agent-loop tool_execution_update -> AgentSession event
 *   -> sessionEventDurability -> toJsonEvent -> the JSONL a host redirects
 *      from `--mode json`.
 *
 * The point of the run is the `--mode json` default: a durable-only stream is
 * what a harness writes to disk, so the measurement applies the same filter the
 * transport does.
 *
 * Run from packages/coding-agent:
 *   node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
 *   REPRO_TURNS=40 REPRO_DELTAS=150 REPRO_TOOL_BYTES=40000 node --import tsx <same>
 *   REPRO_LIVE=1 node --import tsx <same>     # simulate --include-live-events
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { isEphemeralSessionEvent } from "../../../packages/coding-agent/src/core/session-event-durability.ts";
import { createStepSubagentExtension } from "../../../packages/coding-agent/src/features/step-subagent.ts";
import { toJsonEvent } from "../../../packages/coding-agent/src/modes/json-event.ts";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";

const childPath = fileURLToPath(new URL("./child.mjs", import.meta.url));
const includeLive = process.env.REPRO_LIVE === "1";
const workDir = mkdtempSync(join(tmpdir(), "step-amp-"));
const logPath = join(workDir, "stepcode.jsonl");

// The default runner spawns `process.argv[1]`. Point it at the fake rpc child so
// this repro works on any branch, without the host-only `cliPath` option.
process.argv[1] = childPath;
// The child is plain ESM: do not forward the parent's tsx loader into it.
process.execArgv = process.execArgv.filter((arg) => !/^(?:--import|--loader|--require|-r)$/u.test(arg));

const harness = await createHarness({
	extensionFactories: [
		{ name: "step-subagent", factory: createStepSubagentExtension({ agentDir: join(workDir, "agent") }) },
	],
});

const out = createWriteStream(logPath);
const stats = {
	byType: new Map<string, number>(),
	durableBytes: 0,
	liveBytes: 0,
	liveFrames: 0,
	largestLiveFrame: 0,
	largestDurable: 0,
	messageHashes: new Map<string, number>(),
};
let writeChain: Promise<void> = Promise.resolve();
let peakRss = 0;
const sampler = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);

harness.session.subscribe((event) => {
	// The projection decides what the record contains; the flag is the live
	// consumer's opt-in. A frame is measured on its own line either way.
	if (isEphemeralSessionEvent(event)) {
		const frameLine = JSON.stringify(toJsonEvent(event, { includeLiveEvents: true }));
		const frameBytes = Buffer.byteLength(frameLine, "utf8");
		stats.liveFrames += 1;
		stats.liveBytes += frameBytes;
		stats.largestLiveFrame = Math.max(stats.largestLiveFrame, frameBytes);
	}
	const projected = toJsonEvent(event, { includeLiveEvents: includeLive });
	if (!projected) return;
	const line = JSON.stringify(projected);
	const bytes = Buffer.byteLength(line, "utf8");
	if (!isEphemeralSessionEvent(event)) {
		stats.durableBytes += bytes;
		stats.largestDurable = Math.max(stats.largestDurable, bytes);
	}
	stats.byType.set(event.type, (stats.byType.get(event.type) ?? 0) + 1);
	writeChain = writeChain.then(
		() => new Promise<void>((resolve) => (out.write(`${line}\n`) ? resolve() : out.once("drain", () => resolve()))),
	);
	if (event.type !== "tool_execution_update") return;
	const results = event.partialResult?.details?.results;
	if (!Array.isArray(results)) return;
	for (const record of results) {
		const messages = record?.messages;
		if (!Array.isArray(messages) || messages.length === 0) continue;
		const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
		stats.messageHashes.set(hash, (stats.messageHashes.get(hash) ?? 0) + 1);
	}
});

harness.setResponses([
	fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "inspect the repository" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("parent done"),
]);

const startedAt = Date.now();
await harness.session.prompt("delegate the inspection");
await writeChain;
await new Promise<void>((resolve) => out.end(resolve));
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);

const size = statSync(logPath).size;
const mib = (n: number): number => +(n / 1024 / 1024).toFixed(3);
const pct = (part: number, whole: number): number => +((part / Math.max(1, whole)) * 100).toFixed(1);

console.log(
	JSON.stringify(
		{
			config: {
				childTurns: Number(process.env.REPRO_TURNS ?? 20),
				deltasPerTurn: Number(process.env.REPRO_DELTAS ?? 60),
				childToolBytes: Number(process.env.REPRO_TOOL_BYTES ?? 20_000),
				includeLive,
			},
			logMiB: mib(size),
			durableMiB: mib(stats.durableBytes),
			liveFrames: stats.liveFrames,
			liveFramesWritten: includeLive,
			liveMiB: mib(stats.liveBytes),
			liveShareOfTotalPct: pct(stats.liveBytes, stats.durableBytes + stats.liveBytes),
			largestDurableMiB: mib(stats.largestDurable),
			largestLiveFrameMiB: mib(stats.largestLiveFrame),
			liveFramesCarryingTranscript: [...stats.messageHashes.values()].reduce((a, b) => a + b, 0),
			peakRssMiB: mib(peakRss),
			elapsedMs: Date.now() - startedAt,
			eventsByType: Object.fromEntries([...stats.byType.entries()].sort((a, b) => b[1] - a[1])),
		},
		null,
		2,
	),
);

harness.cleanup();
rmSync(workDir, { recursive: true, force: true });
