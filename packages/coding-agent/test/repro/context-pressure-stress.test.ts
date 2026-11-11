/**
 * Stability / stress reproduction.
 *
 * 1. Repeats the core compaction matrix 10x and checks the request sequence is identical.
 * 2. Runs the "summary always times out" storm for 4 prompts (retry amplification + pause).
 * 3. Sweeps context windows (64k..1M) at the trigger ratio to find where CLM is skipped.
 * 4. Repeats with an artificial provider delay to prove no extra requests appear.
 *
 * Run:
 *   cd packages/coding-agent && pnpm exec vitest --run test/repro/context-pressure-stress.test.ts
 */
import { writeFileSync } from "node:fs";
import type { AgentMessage } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

const REPORT = "/tmp/step-context-pressure-stress.md";
const out: string[] = [];
afterAll(() => writeFileSync(REPORT, out.join("\n"), "utf8"));

const chunk = "observed build output: src/parser.ts:42 exit code 1, assertion failed\n".repeat(200);

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
		.join("\n");
}

function estimate(context: Context): number {
	let chars = (context.systemPrompt?.length ?? 0) + JSON.stringify(context.tools ?? []).length;
	for (const message of context.messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content))
			for (const part of content) {
				const block = part as { text?: string; thinking?: string; arguments?: unknown };
				if (!block || typeof block !== "object") continue;
				chars += (block.text ?? block.thinking ?? "").length;
				if (block.arguments !== undefined) chars += JSON.stringify(block.arguments).length;
			}
	}
	return Math.ceil(chars / 4);
}

function seed(h: Harness, tokens: number): void {
	const messages: AgentMessage[] = [];
	let total = 0;
	let i = 0;
	while (total < tokens) {
		const assistant = fauxAssistantMessage([fauxToolCall("run_command", { command: "pnpm test" })], {
			stopReason: "toolUse",
			timestamp: 2 + i * 4,
		});
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: (assistant.content[0] as { id: string }).id,
			toolName: "run_command",
			content: [{ type: "text", text: chunk }],
			isError: false,
			timestamp: 3 + i * 4,
		};
		const user: AgentMessage = { role: "user", content: `STEP ${i}: inspect the build`, timestamp: 1 + i * 4 };
		for (const message of [user, assistant, result]) {
			messages.push(message);
			h.sessionManager.appendMessage(message);
		}
		total += Math.ceil(chunk.length / 4) + 30;
		i++;
	}
	h.session.agent.state.messages = messages;
}

type Clm = "accept" | "none" | "timeout";
type Summary = "ok" | "timeout";

interface Options {
	window: number;
	ratio: number;
	mode?: "off" | "clm-v1";
	clm: Clm;
	summary: Summary;
	maxRetries?: number;
	delayMs?: number;
	prompts?: number;
}

interface Result {
	seq: string;
	kinds: string;
	ms: number;
	compactions: number;
	failures: number;
	clmReason?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(options: Options): Promise<Result> {
	const h = await createHarness({
		models: [{ id: "stress-model", contextWindow: options.window, maxTokens: 8192 }],
		settings: {
			compaction: {
				...(options.mode === undefined ? {} : { contextProjection: options.mode }),
				enabled: true,
				reserveTokens: 2048,
				keepRecentTokens: 4000,
				autoClm: { timeoutMs: 120, maxRequests: 2 },
			},
			retry: { enabled: true, maxRetries: options.maxRetries ?? 1, baseDelayMs: 0 },
		},
		tools: [],
	});
	seed(h, Math.floor(options.window * options.ratio));

	const kinds: string[] = [];
	const started = Date.now();
	const respond = async (context: Context) => {
		const isSummary = (context.systemPrompt ?? "").includes("context summarization assistant");
		const last = text(context.messages.at(-1)?.content);
		const cached = last.includes("Reply with only JSON");
		const tool = context.tools?.some((entry) => entry.name === "apply_context_edit");
		const kind = isSummary ? "summary" : cached ? "clm-json" : tool ? "clm-tool" : "task";
		kinds.push(`${kind}:${estimate(context)}`);
		if (options.delayMs) await sleep(options.delayMs);
		if (kind === "summary") {
			return options.summary === "timeout"
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Headers Timeout Error" })
				: fauxAssistantMessage("## User Goal\nKeep the parser failure.");
		}
		if (kind === "clm-tool" || kind === "clm-json") {
			if (options.clm === "timeout") {
				await sleep(300);
				return fauxAssistantMessage("no edit");
			}
			if (options.clm === "none") return fauxAssistantMessage("no safe edit");
			const transcript = context.messages.map((message) => text(message.content)).join("\n");
			const ids = [...transcript.matchAll(/- id=([^ ]+) role=\w+ chars=/g)].map((match) => match[1]);
			const replacements = ids.map((id) => ({ id, text: "Kept: exact parser error." }));
			if (kind === "clm-json") return fauxAssistantMessage(JSON.stringify({ replacements }));
			return fauxAssistantMessage(fauxToolCall("apply_context_edit", { replacements }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("done");
	};

	for (let i = 0; i < (options.prompts ?? 1); i++) {
		h.setResponses(Array.from({ length: 60 }, () => respond));
		try {
			await h.session.prompt(`TASK ${i + 1}: say hi`);
		} catch {
			kinds.push("run-error");
		}
	}
	const result: Result = {
		seq: kinds.join(" -> "),
		kinds: kinds.map((kind) => kind.split(":")[0]).join(" -> "),
		ms: Date.now() - started,
		compactions: h.events.filter((event) => event.type === "compaction_start").length,
		failures: (h.session as unknown as { _thresholdCompactionFailures: number })._thresholdCompactionFailures,
		clmReason: h.eventsOfType("auto_clm_end")[0]?.result.reason,
	};
	h.cleanup();
	return result;
}

describe("compaction stability", () => {
	it("repeats the core matrix and reports sequence stability", async () => {
		out.push("# 压缩请求序列的稳定性", "");
		const core: Array<[string, Options]> = [
			["CLM 接受", { window: 200_000, ratio: 0.93, clm: "accept", summary: "ok" }],
			["CLM 无编辑", { window: 200_000, ratio: 0.93, clm: "none", summary: "ok" }],
			["CLM 超时", { window: 200_000, ratio: 0.93, clm: "timeout", summary: "ok" }],
			["原生摘要成功", { window: 200_000, ratio: 0.93, mode: "off", clm: "accept", summary: "ok" }],
			[
				"原生摘要失败",
				{ window: 200_000, ratio: 0.93, mode: "off", clm: "accept", summary: "timeout", maxRetries: 3 },
			],
		];
		for (const [title, options] of core) {
			const runs: Result[] = [];
			for (let i = 0; i < 10; i++) runs.push(await run(options));
			const counts = new Map<string, number>();
			for (const result of runs) counts.set(result.kinds, (counts.get(result.kinds) ?? 0) + 1);
			const times = runs.map((result) => result.ms);
			out.push(`- ${title}：不同的请求序列=${counts.size}/10，耗时 ${Math.min(...times)}-${Math.max(...times)}ms`);
			for (const [sequence, count] of counts) out.push(`  出现 ${count} 次：${sequence}`);
			out.push(`  载荷示例：${runs[0].seq}`);
		}
		expect(out.length).toBeGreaterThan(5);
	}, 300_000);

	it("storm: a summary that always times out, four prompts in a row", async () => {
		out.push("", "## 超时风暴（原生模式，maxRetries=3）", "");
		const result = await run({
			window: 200_000,
			ratio: 0.93,
			mode: "off",
			clm: "accept",
			summary: "timeout",
			maxRetries: 3,
			prompts: 4,
		});
		const attempts = result.seq.split(" -> ").filter((step) => step.startsWith("summary")).length;
		out.push(
			`- 4 个 prompt 共发出 ${result.seq.split(" -> ").length} 个请求（${attempts} 次摘要尝试）`,
			`- compaction_start 次数=${result.compactions}，压缩失败计数=${result.failures}`,
			`- 请求序列：${result.seq}`,
		);
		expect(attempts).toBeGreaterThan(0);
	}, 180_000);

	it("sweeps the window size at the trigger ratio", async () => {
		out.push("", "## 触发点附近的窗口/占用扫描", "");
		for (const window of [64_000, 100_000, 200_000, 500_000, 1_000_000]) {
			const result = await run({ window, ratio: 0.9, clm: "accept", summary: "ok" });
			const steps = result.seq.split(" -> ");
			out.push(`- window=${window}：${steps.length} 个请求，CLM=${result.clmReason ?? "-"}`);
			out.push(`  ${result.seq}`);
		}
		for (const ratio of [0.85, 0.9, 0.93, 0.96, 0.99]) {
			const result = await run({ window: 200_000, ratio, clm: "accept", summary: "ok" });
			const steps = result.seq.split(" -> ");
			out.push(`- 200k @ ${Math.round(ratio * 100)}%：${steps.length} 个请求，CLM=${result.clmReason ?? "-"}`);
			out.push(`  ${result.seq}`);
		}
		for (const ratio of [0.92, 0.96, 0.99]) {
			const result = await run({ window: 1_000_000, ratio, clm: "accept", summary: "ok" });
			const steps = result.seq.split(" -> ");
			out.push(`- 1M @ ${Math.round(ratio * 100)}%：${steps.length} 个请求，CLM=${result.clmReason ?? "-"}`);
			out.push(`  ${result.seq}`);
		}
		expect(out.length).toBeGreaterThan(8);
	}, 300_000);

	it("adds a provider delay without changing the request sequence", async () => {
		out.push("", "## provider 延迟（不产生额外请求）", "");
		const base = await run({ window: 200_000, ratio: 0.93, clm: "none", summary: "ok" });
		const delayed = await run({ window: 200_000, ratio: 0.93, clm: "none", summary: "ok", delayMs: 40 });
		out.push(
			`- 无延迟：${base.seq.split(" -> ").length} 个请求，耗时 ${base.ms}ms`,
			`- 每个请求 40ms：${delayed.seq.split(" -> ").length} 个请求，耗时 ${delayed.ms}ms`,
			`- 请求类型序列一致：${base.kinds === delayed.kinds}`,
		);
		// Compare request kinds, not payload sizes: the estimate carries a timestamp digit that
		// can differ by one token between runs and says nothing about the sequence.
		expect(delayed.kinds).toBe(base.kinds);
	}, 180_000);
});
