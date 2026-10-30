/**
 * Scenario simulations for the v2 compaction trigger policy.
 *
 * Each case drives a full AgentSession through a realistic multi-step coding flow with a scripted
 * faux model: the model answers task requests from a script and answers summarization requests
 * with a summary, so scenarios do not depend on how many summary calls a compaction needs.
 * No real provider is contacted.
 */
import type { AgentMessage, AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type Model } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.ts";
import { createHarness, type Harness } from "./harness.ts";

const SUMMARY = "## User Goal\nFix the CSV parser.\n\n## Current State\n### Done\n- Read the parser and logs.";

type TaskStep = (
	context: Context,
) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

interface Simulation {
	h: Harness;
	/** Every model request, in order, classified as task or summary. */
	requests: Array<{ kind: "task" | "summary"; tokens: number; context: Context }>;
	taskRequests(): Context[];
	script(steps: TaskStep[]): void;
	pending(): number;
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) h.cleanup();
});

function isSummaryRequest(context: Context): boolean {
	return context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT;
}

/** Estimated size of everything the provider receives: messages, system prompt and tool schemas. */
function requestTokens(context: Context): number {
	const messages = context.messages.reduce((total, message) => total + estimateTokens(message as AgentMessage), 0);
	return messages + Math.ceil(((context.systemPrompt ?? "").length + JSON.stringify(context.tools ?? []).length) / 4);
}

function text(context: Context): string {
	return JSON.stringify(context.messages);
}

async function simulate(options: {
	contextWindow: number;
	maxTokens?: number;
	tools?: AgentTool[];
	compaction?: Record<string, unknown>;
	models?: Array<{ id: string; contextWindow: number; maxTokens?: number }>;
}): Promise<Simulation> {
	const h = await createHarness({
		models: options.models ?? [
			{ id: "sim-model", contextWindow: options.contextWindow, maxTokens: options.maxTokens ?? 4096 },
		],
		settings: {
			compaction: { contextProjection: "off", keepRecentTokens: 8_000, ...options.compaction },
			retry: { enabled: false },
		},
		tools: options.tools ?? [],
	});
	harnesses.push(h);
	const requests: Simulation["requests"] = [];
	let steps: TaskStep[] = [];
	const respond = async (context: Context) => {
		if (isSummaryRequest(context)) {
			requests.push({ kind: "summary", tokens: requestTokens(context), context });
			return fauxAssistantMessage(SUMMARY);
		}
		requests.push({ kind: "task", tokens: requestTokens(context), context });
		const step = steps.shift();
		if (!step) throw new Error("scenario script exhausted");
		return step(context);
	};
	// A generous pool of responders; each consults the shared script.
	h.setResponses(Array.from({ length: 200 }, () => respond));
	const sim: Simulation = {
		h,
		requests,
		taskRequests: () => requests.filter((request) => request.kind === "task").map((request) => request.context),
		script: (next) => {
			steps = [...next];
		},
		pending: () => steps.length,
	};
	return sim;
}

function tool(name: string, output: () => string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: output() }], details: {} }),
	};
}

const reply =
	(message: string): TaskStep =>
	() =>
		fauxAssistantMessage(message);
const callTool =
	(name: string): TaskStep =>
	() =>
		fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" });
/** About `tokens` estimated tokens of tool output (chars/4). */
const output = (label: string, tokens: number) => `${label}: ${"x".repeat(tokens * 4 - label.length - 2)}`;

describe("compaction trigger simulations (faux provider)", () => {
	it("long tool-heavy task: compacts mid-loop at 90% and every request stays inside the window", async () => {
		// 32K window -> threshold 28.8K. Each read returns ~6K tokens; the task needs 8 reads.
		const reads = { count: 0 };
		const sim = await simulate({
			contextWindow: 32_000,
			tools: [tool("read_file", () => output(`file-${++reads.count}`, 6_000))],
		});
		sim.script([
			...Array.from({ length: 8 }, () => callTool("read_file")),
			reply("The parser bug is in the quote handling; fix applied."),
		]);

		await sim.h.session.prompt("Read the eight parser modules and find the CSV quoting bug.");

		expect(sim.pending()).toBe(0);
		expect(reads.count).toBe(8);
		const compactions = sim.h.eventsOfType("compaction_start").map((event) => event.reason);
		expect(compactions.length).toBeGreaterThanOrEqual(1);
		expect(compactions.every((reason) => reason === "threshold")).toBe(true);
		expect(sim.h.eventsOfType("compaction_end").every((event) => event.errorMessage === undefined)).toBe(true);
		// No task request exceeded the window, and none needed overflow recovery.
		for (const request of sim.requests.filter((entry) => entry.kind === "task")) {
			expect(request.tokens).toBeLessThan(32_000);
		}
		// Requests after the first compaction carry the summary.
		const firstSummaryIndex = sim.requests.findIndex((entry) => entry.kind === "summary");
		const afterCompaction = sim.requests.slice(firstSummaryIndex).find((entry) => entry.kind === "task");
		expect(afterCompaction && text(afterCompaction.context)).toContain("Fix the CSV parser");
		expect(sim.h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("multi-prompt conversation: final answers never compact; the next prompt compacts first", async () => {
		// 20K window -> threshold 18K. Each answer adds ~5K tokens.
		const sim = await simulate({ contextWindow: 20_000 });
		const long = (label: string) => reply(`${label} ${"detail ".repeat(2_850)}`);
		const compactionsAfter: number[] = [];
		for (let turn = 0; turn < 5; turn++) {
			sim.script([long(`answer-${turn}`)]);
			await sim.h.session.prompt(`question ${turn}`);
			expect(sim.pending()).toBe(0);
			compactionsAfter.push(sim.h.eventsOfType("compaction_start").length);
			// The session never ends a prompt with a compaction after the final answer.
			expect(sim.requests.at(-1)?.kind).toBe("task");
		}
		expect(compactionsAfter.at(-1)).toBeGreaterThanOrEqual(1);
		// Each compaction happened before the task request of the prompt that crossed the threshold.
		const summaryPositions = sim.requests.flatMap((entry, index) => (entry.kind === "summary" ? [index] : []));
		for (const position of summaryPositions) {
			expect(sim.requests.slice(position).find((entry) => entry.kind === "task")).toBeDefined();
		}
		for (const request of sim.requests.filter((entry) => entry.kind === "task")) {
			expect(request.tokens).toBeLessThan(20_000);
		}
	});

	it("user pastes a huge prompt into a nearly full session: compacts before the first request", async () => {
		const sim = await simulate({ contextWindow: 40_000 });
		sim.script([reply(`analysis ${"note ".repeat(6_400)}`)]);
		await sim.h.session.prompt("Summarize the incident timeline.");
		expect(sim.h.eventsOfType("compaction_start")).toHaveLength(0);

		// ~8K tokens of history plus ~30K pasted tokens crosses the 36K threshold before the first request.
		const pasted = `LOG DUMP\n${"2026-10-29T10:00:00Z ERROR csv quote mismatch\n".repeat(2_700)}`;
		sim.script([reply("The quote mismatch starts at 10:00.")]);
		await sim.h.session.prompt(pasted);

		expect(sim.pending()).toBe(0);
		expect(sim.h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		const lastTask = sim.requests.filter((entry) => entry.kind === "task").at(-1)!;
		expect(lastTask.tokens).toBeLessThan(40_000);
		expect(text(lastTask.context)).toContain("Fix the CSV parser");
		// The pasted prompt itself survives the compaction and reaches the model.
		expect(text(lastTask.context)).toContain("LOG DUMP");
		expect(sim.h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("user steers while a mid-loop compaction runs: the steering reaches the next request", async () => {
		const reads = { count: 0 };
		// 30K window -> threshold 27K; the fifth read pushes the next request past it.
		const sim = await simulate({
			contextWindow: 30_000,
			tools: [tool("read_file", () => output(`file-${++reads.count}`, 6_000))],
		});
		let steered = false;
		const steerOnFirstSummary = sim.h.session.agent.streamFunction;
		sim.h.session.agent.streamFunction = (model, context, options) => {
			if (!steered && isSummaryRequest(context)) {
				steered = true;
				void sim.h.session.prompt("STEER: only report the first failing line", { streamingBehavior: "steer" });
			}
			return steerOnFirstSummary(model, context, options);
		};
		let steeringSeenAt = -1;
		sim.script([
			callTool("read_file"),
			callTool("read_file"),
			callTool("read_file"),
			callTool("read_file"),
			callTool("read_file"),
			(context) => {
				if (text(context).includes("STEER: only report the first failing line"))
					steeringSeenAt = sim.taskRequests().length;
				return fauxAssistantMessage("First failing line: 42.");
			},
		]);

		await sim.h.session.prompt("Read the five parser files.");

		expect(steered).toBe(true);
		expect(sim.pending()).toBe(0);
		expect(sim.h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		// The request right after the compaction is the one that carries the steering.
		expect(steeringSeenAt).toBe(6);
		expect(sim.h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("summarizer outage: three failures pause compaction, requests still go out, and /compact resumes it", async () => {
		const sim = await simulate({ contextWindow: 20_000 });
		const realStream = sim.h.session.agent.streamFunction;
		let summarizerDown = true;
		sim.h.session.agent.streamFunction = (model, context, options) => {
			if (summarizerDown && isSummaryRequest(context)) {
				return realStream(model, { ...context, systemPrompt: "BROKEN" }, options);
			}
			return realStream(model, context, options);
		};
		// While "down", summary requests reach the task script; fail them as an outage would.
		const outage: TaskStep = (context) => {
			if (context.systemPrompt === "BROKEN") {
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 summarizer unavailable" });
			}
			return fauxAssistantMessage("unexpected");
		};
		const seedLarge = () => {
			sim.h.sessionManager.appendMessage({ role: "user", content: "earlier task", timestamp: Date.now() });
			sim.h.sessionManager.appendMessage(fauxAssistantMessage(`earlier ${"x".repeat(72_000)}`));
			sim.h.session.agent.state.messages = sim.h.sessionManager.buildSessionContext().messages;
		};
		seedLarge();
		for (let attempt = 0; attempt < 3; attempt++) {
			sim.script([outage, outage, outage, outage, reply(`answer ${attempt}`)]);
			await sim.h.session.prompt(`prompt ${attempt}`);
		}
		const failures = sim.h.eventsOfType("compaction_end").filter((event) => event.errorMessage);
		expect(failures).toHaveLength(3);
		expect(failures.at(-1)?.errorMessage).toContain("paused");

		// Paused: the next prompt sends without trying to compact.
		const before = sim.h.eventsOfType("compaction_start").length;
		sim.script([reply("answer while paused")]);
		await sim.h.session.prompt("prompt while paused");
		expect(sim.h.eventsOfType("compaction_start")).toHaveLength(before);

		// Summarizer recovers; manual /compact succeeds and automatic compaction resumes.
		summarizerDown = false;
		await sim.h.session.compact();
		seedLarge();
		sim.script([reply("answer after resume")]);
		await sim.h.session.prompt("prompt after resume");
		const reasons = sim.h.eventsOfType("compaction_start").map((event) => event.reason);
		expect(reasons.slice(-2)).toEqual(["manual", "threshold"]);
		expect(sim.h.eventsOfType("compaction_end").at(-1)?.errorMessage).toBeUndefined();
	});

	it("switching to a smaller-window model compacts before the first request on the new model", async () => {
		const sim = await simulate({
			contextWindow: 128_000,
			models: [
				{ id: "large", contextWindow: 128_000 },
				{ id: "small", contextWindow: 32_000 },
			],
		});
		// Two ~15K-token answers fit the 128K model but exceed the small model's 28.8K threshold.
		for (const topic of ["lexer", "parser"]) {
			sim.script([reply(`${topic} deep dive ${"text ".repeat(12_000)}`)]);
			await sim.h.session.prompt(`Explain the ${topic} in depth.`);
		}
		expect(sim.h.eventsOfType("compaction_start")).toHaveLength(0);

		await sim.h.session.setModel(sim.h.getModel("small") as Model<string>);
		sim.script([reply("short answer on the small model")]);
		await sim.h.session.prompt("Now give me a one-line summary.");

		expect(sim.h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		const lastTask = sim.requests.filter((entry) => entry.kind === "task").at(-1)!;
		expect(lastTask.tokens).toBeLessThan(32_000 * 0.9);
		expect(text(lastTask.context)).toContain("Fix the CSV parser");
	});

	it("per-model ratio and tokenLimit change when compaction starts", async () => {
		const run = async (compaction: Record<string, unknown>) => {
			const sim = await simulate({ contextWindow: 100_000, compaction });
			const sizes: number[] = [];
			for (let turn = 0; turn < 12; turn++) {
				sim.script([reply(`answer ${turn} ${"word ".repeat(9_000)}`)]);
				await sim.h.session.prompt(`turn ${turn}`);
				if (sim.h.eventsOfType("compaction_start").length > 0) break;
				sizes.push(sim.requests.filter((entry) => entry.kind === "task").at(-1)!.tokens);
			}
			return { compacted: sim.h.eventsOfType("compaction_start").length, largestUncompacted: Math.max(...sizes) };
		};
		const byDefault = await run({});
		const byModel = await run({ modelTriggerRatios: { "faux/sim-model": 0.6 } });
		const byLimit = await run({ tokenLimit: 40_000 });
		expect(byDefault.compacted).toBe(1);
		expect(byModel.compacted).toBe(1);
		expect(byLimit.compacted).toBe(1);
		// Earlier triggers leave smaller uncompacted requests.
		expect(byModel.largestUncompacted).toBeLessThan(byDefault.largestUncompacted);
		expect(byLimit.largestUncompacted).toBeLessThan(byModel.largestUncompacted);
		expect(byLimit.largestUncompacted).toBeLessThanOrEqual(40_000);
	});

	it("legacy policy keeps compacting right after a final answer", async () => {
		const sim = await simulate({
			contextWindow: 20_000,
			compaction: { triggerPolicy: "legacy", reserveTokens: 4_000 },
		});
		sim.script([reply(`answer ${"detail ".repeat(10_000)}`)]);
		await sim.h.session.prompt("write a long answer");
		expect(sim.h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(sim.requests.at(-1)?.kind).toBe("summary");
	});

	it("compaction disabled: no automatic compaction even far past the threshold", async () => {
		const sim = await simulate({ contextWindow: 20_000, compaction: { enabled: false } });
		for (let turn = 0; turn < 3; turn++) {
			sim.script([reply(`answer ${turn} ${"detail ".repeat(2_000)}`)]);
			await sim.h.session.prompt(`turn ${turn}`);
		}
		expect(sim.h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(sim.requests.every((entry) => entry.kind === "task")).toBe(true);
	});
});
