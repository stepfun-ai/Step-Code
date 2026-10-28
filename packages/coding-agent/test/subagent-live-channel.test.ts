import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, afterEach, expect, test } from "vitest";
import { createStepSubagentExtension } from "../src/features/step-subagent.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Subagent channel split, on the real path.
 *
 * A real `--mode rpc` child is spawned through the production rpc adapter,
 * parsed by the production projection, executed by the production orchestrator,
 * dispatched by the real Agent Loop, and serialized by `toJsonEvent`. Only the
 * parent's model (faux) and the child's tokens are test doubles.
 *
 * Two properties matter and they pull in opposite directions, which is exactly
 * why the transport has to distinguish them:
 *   - the parent must still see live progress (it renders the lane list), and
 *   - the child's stdout is a pipe, not a log, so it must be asked for them.
 */

const childPath = fileURLToPath(new URL("./fixtures/subagent-stream-child.mjs", import.meta.url));
const agentRoot = mkdtempSync(join(tmpdir(), "step-subagent-durability-"));
const harnesses: Harness[] = [];
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
/** The fixture reads these from the environment, so each case must not leak into the next. */
const CHILD_ENV_KEYS = ["STREAM_TURNS", "STREAM_DELTAS", "STREAM_TOOL_BYTES", "STREAM_DELAY_MS", "STREAM_FINAL_BYTES"];
const originalChildEnv = Object.fromEntries(CHILD_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	for (const key of CHILD_ENV_KEYS) {
		const value = originalChildEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

afterAll(() => {
	rmSync(agentRoot, { recursive: true, force: true });
});

interface RunStats {
	updateCount: number;
	updatesWithMessages: number;
	/**
	 * Text that can only have come from a live frame.
	 *
	 * The fixture marks its tool progress with a counter the final tool result
	 * does not contain, so a parent that only read durable events would leave
	 * this empty even though `activeText`/`activeToolOutput` still got filled
	 * from `message_end`/`tool_execution_end`.
	 */
	liveOnlyTexts: string[];
	finalHasMessages: boolean;
	finalTextLength: number;
	finalActiveTextLength: number;
}

async function runAgainstRealChild(env: Record<string, string> = {}): Promise<RunStats> {
	Object.assign(process.env, env, { STEP_CODING_AGENT_DIR: agentRoot });
	// The default runner spawns `process.argv[1]`; point it at the fake rpc child
	// and keep the parent's TS loader out of a plain-ESM child process.
	process.argv[1] = childPath;
	process.execArgv = process.execArgv.filter((arg) => !/^(?:--import|--loader|--require|-r)$/u.test(arg));

	const harness = await createHarness({
		extensionFactories: [{ name: "step-subagent", factory: createStepSubagentExtension({ agentDir: agentRoot }) }],
	});
	harnesses.push(harness);

	const stats: RunStats = {
		updateCount: 0,
		updatesWithMessages: 0,
		liveOnlyTexts: [],
		finalHasMessages: false,
		finalTextLength: 0,
		finalActiveTextLength: 0,
	};
	harness.session.subscribe((event) => {
		// Serialize every event the way the parent's live pipe does — the subagent
		// runner passes `--include-live-events` to its child — so a payload that
		// could not be written is visible here too.
		const line = JSON.stringify(toJsonEvent(event, { includeLiveEvents: true }));
		if (Buffer.byteLength(line, "utf8") > 512 * 1024) {
			throw new Error(`event ${event.type} exceeded the wire budget`);
		}
		if (event.type === "tool_execution_update") {
			stats.updateCount += 1;
			const results = event.partialResult?.details?.results;
			for (const record of Array.isArray(results) ? results : []) {
				const row = record as { activeText?: unknown; activeToolOutput?: unknown };
				for (const value of [row.activeText, row.activeToolOutput]) {
					if (typeof value === "string" && value.includes("tool-progress-marker")) {
						stats.liveOnlyTexts.push(value);
					}
				}
			}
			if (
				Array.isArray(results) &&
				results.some((record) => Array.isArray(record?.messages) && record.messages.length > 0)
			) {
				stats.updatesWithMessages += 1;
			}
		}
		if (event.type === "tool_execution_end") {
			const records: unknown[] = Array.isArray(event.result?.details?.results) ? event.result.details.results : [];
			const rows = records.filter(
				(record): record is Record<string, unknown> => typeof record === "object" && record !== null,
			);
			stats.finalHasMessages = rows.some((record) => Array.isArray(record.messages) && record.messages.length > 0);
			stats.finalActiveTextLength = rows.reduce(
				(sum, record) => sum + (typeof record.activeText === "string" ? record.activeText.length : 0),
				0,
			);
			const content: unknown[] = Array.isArray(event.result?.content) ? event.result.content : [];
			stats.finalTextLength = content.reduce<number>(
				(sum, part) =>
					sum +
					(part !== null &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string"
						? (part as { text: string }).text.length
						: 0),
				0,
			);
		}
	});

	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "inspect" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("parent done"),
	]);
	await harness.session.prompt("delegate");
	return stats;
}

test("the parent still sees live-only child progress from a real rpc child", async () => {
	// 160ms of streaming per turn outlives the parent's 100ms repaint window, so
	// an intermediate frame is published.
	const stats = await runAgainstRealChild({ STREAM_TURNS: "2", STREAM_DELTAS: "4", STREAM_DELAY_MS: "40" });

	// `tool-progress-marker` exists only in a `tool_execution_update` payload.
	// It cannot arrive through a durable event, so this fails if the runner stops
	// passing `--include-live-events` to its child (see the runner's argv) or if a
	// transport drops frames — even though `agent_settled` and the final result
	// keep arriving.
	expect(stats.liveOnlyTexts.length).toBeGreaterThan(0);
	// ...and a frame is a replacement snapshot, never the transcript.
	expect(stats.updatesWithMessages).toBe(0);
});

test("the final result is a summary and never carries the child transcript", async () => {
	const stats = await runAgainstRealChild({ STREAM_TURNS: "4", STREAM_DELTAS: "10" });

	expect(stats.finalHasMessages).toBe(false);
	// The outcome is still readable, and the model-facing text is complete.
	expect(stats.finalActiveTextLength).toBeGreaterThan(0);
	expect(stats.finalTextLength).toBeGreaterThan(0);
});
