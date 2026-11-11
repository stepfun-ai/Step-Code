/**
 * Reproduction harness for near-full-context compaction behaviour.
 *
 * Drives the real AgentSession through every automatic/manual compaction path
 * with a faux provider and records the ordered model-request sequence each
 * scenario produces. Run:
 *
 *   cd packages/coding-agent && pnpm exec vitest --run test/repro/context-pressure-scenarios.test.ts
 *
 * The report is written to /tmp/step-context-pressure-scenarios.md.
 */
import { writeFileSync } from "node:fs";
import type { AgentMessage } from "@step-harness/agent-core";
import type { Message } from "@step-harness/providers";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../suite/harness.ts";

const REPORT = "/tmp/step-context-pressure-scenarios.md";
const lines: string[] = [];

type ClmPolicy = "accept" | "no-edit" | "timeout" | "invalid";
type SummaryPolicy = "ok" | "error" | "length";
type TaskPolicy = "ok" | "overflow" | "overflow-then-ok";

interface Scenario {
	title: string;
	window: number;
	ratio: number;
	mode?: "off" | "lightweight-v1" | "clm-v1";
	autoClm?: boolean;
	triggerPolicy?: "v2" | "legacy";
	clm: ClmPolicy;
	summary: SummaryPolicy;
	task: TaskPolicy;
	maxRetries?: number;
	prompts?: number;
	manualCompact?: boolean;
	/** Seed to 45% first, run one ordinary prompt, then grow past the threshold. */
	warmUp?: boolean;
	/** Seed the whole history as a single turn so the cut point lands mid-turn. */
	splitTurn?: boolean;
}

interface Recorded {
	kind: "task" | "clm-tool" | "clm-cached-json" | "summary";
	messages: number;
	tokens: number;
	ms: number;
	attempt: number;
	note?: string;
}

const active: Harness[] = [];
afterAll(() => {
	writeFileSync(REPORT, lines.join("\n"), "utf8");
	for (const h of active.splice(0)) h.cleanup();
});

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
		.join("\n");
}

function estimateTokens(context: Context): number {
	const overhead = Math.ceil(((context.systemPrompt?.length ?? 0) + JSON.stringify(context.tools ?? []).length) / 4);
	let chars = 0;
	for (const message of context.messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content))
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const block = part as { text?: string; thinking?: string; name?: string; arguments?: unknown };
				chars += (block.text ?? block.thinking ?? "").length;
				if (block.arguments !== undefined) chars += JSON.stringify(block.arguments).length;
			}
	}
	return overhead + Math.ceil(chars / 4);
}

/** Realistic history: tiny tool calls, huge tool results (read_file / run_command output). */
function seedHistory(h: Harness, window: number, ratio: number, singleTurn = false): number {
	const messages: AgentMessage[] = [...(h.session.agent.state.messages ?? [])];
	const target = Math.floor(window * ratio);
	const chunk = "observed build output: src/parser.ts:42 exit code 1, assertion failed\n".repeat(200);
	if (singleTurn && messages.length === 0) {
		for (const message of [
			{ role: "user", content: "Earlier turn: check the build", timestamp: 0 },
			fauxAssistantMessage("Earlier turn complete."),
			{ role: "user", content: "ONE HUGE TURN: investigate the build", timestamp: 1 },
		] satisfies AgentMessage[]) {
			messages.push(message);
			h.sessionManager.appendMessage(message);
		}
	}
	let i = messages.length;
	while (i < 4000) {
		const assistant: AgentMessage = {
			...fauxAssistantMessage([fauxToolCall("run_command", { command: "pnpm test" })], {
				stopReason: "toolUse",
				timestamp: 2 + i * 4,
			}),
		};
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: (assistant as { content: Array<{ id?: string }> }).content[0].id ?? `call-${i}`,
			toolName: "run_command",
			content: [{ type: "text", text: chunk }],
			isError: false,
			timestamp: 3 + i * 4,
		};
		const fresh: Message[] = [assistant, result] as Message[];
		if (!singleTurn) {
			fresh.unshift({
				role: "user",
				content: [{ type: "text", text: `STEP ${i}: inspect the failing parser build and report exact errors` }],
				timestamp: 1 + i * 4,
			});
		}
		for (const message of fresh) {
			messages.push(message);
			h.sessionManager.appendMessage(message);
		}
		h.session.agent.state.messages = messages;
		i++;
		const tokens = h.session.getContextUsage()?.tokens ?? 0;
		if (tokens >= target) return tokens;
	}
	return h.session.getContextUsage()?.tokens ?? 0;
}

function classify(context: Context): Recorded["kind"] {
	if ((context.systemPrompt ?? "").includes("context summarization assistant")) return "summary";
	const last = context.messages.at(-1);
	const text = contentText(last?.content);
	if (text.includes("Reply with only JSON")) return "clm-cached-json";
	if (context.tools?.some((tool) => tool.name === "apply_context_edit")) return "clm-tool";
	return "task";
}

function offeredIds(context: Context): string[] {
	const prompt = context.messages.map((message) => contentText(message.content)).join("\n");
	return [...prompt.matchAll(/- id=([^ ]+) role=\w+ chars=/g)].map((match) => match[1]);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(scenario: Scenario): Promise<void> {
	const h = await createHarness({
		models: [{ id: "pressure-model", contextWindow: scenario.window, maxTokens: 8192 }],
		settings: {
			compaction: {
				...(scenario.mode === undefined ? {} : { contextProjection: scenario.mode }),
				...(scenario.triggerPolicy === undefined ? {} : { triggerPolicy: scenario.triggerPolicy }),
				enabled: true,
				reserveTokens: 2048,
				keepRecentTokens: 4000,
				autoClm: {
					softThresholdRatio: 0.85,
					...(scenario.autoClm === undefined ? {} : { enabled: scenario.autoClm }),
					timeoutMs: 150,
					maxRequests: 2,
				},
			},
			retry: { enabled: true, maxRetries: scenario.maxRetries ?? 1, baseDelayMs: 0 },
		},
		tools: [],
	});
	active.push(h);

	const seeded = seedHistory(h, scenario.window, scenario.warmUp ? 0.45 : scenario.ratio, scenario.splitTurn);
	const records: Recorded[] = [];
	const started = Date.now();
	let taskCalls = 0;

	const respond = async (context: Context) => {
		const kind = classify(context);
		const record: Recorded = {
			kind,
			messages: context.messages.length,
			tokens: estimateTokens(context),
			ms: Date.now() - started,
			attempt: 0,
		};
		records.push(record);
		record.attempt = records.filter((item) => item.kind === kind).length;

		if (kind === "summary") {
			if (scenario.summary === "error")
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Headers Timeout Error" });
			if (scenario.summary === "length") return fauxAssistantMessage("partial", { stopReason: "length" });
			return fauxAssistantMessage("## User Goal\nPreserve the parser failure and remaining work.");
		}

		if (kind === "clm-tool" || kind === "clm-cached-json") {
			if (scenario.clm === "timeout") {
				await sleep(400);
				return kind === "clm-cached-json"
					? fauxAssistantMessage(JSON.stringify({ replacements: [] }))
					: fauxAssistantMessage("no edit available");
			}
			if (scenario.clm === "no-edit")
				return kind === "clm-cached-json"
					? fauxAssistantMessage(JSON.stringify({ replacements: [] }))
					: fauxAssistantMessage("no safe edit available");
			if (scenario.clm === "invalid")
				return kind === "clm-cached-json"
					? fauxAssistantMessage("not json")
					: fauxAssistantMessage(fauxToolCall("apply_context_edit", { replacements: [] }), {
							stopReason: "toolUse",
						});
			const text = "Prior investigation complete: keep the exact parser error and remaining work.";
			const ids = offeredIds(context).slice(0, 12);
			const replacements = ids.map((id) => ({ id, text }));
			if (kind === "clm-cached-json") {
				const body = JSON.stringify({ replacements });
				record.note = body.slice(0, 120);
				return fauxAssistantMessage(body);
			}
			return fauxAssistantMessage(fauxToolCall("apply_context_edit", { replacements }), {
				stopReason: "toolUse",
			});
		}

		taskCalls++;
		if (scenario.task === "overflow") {
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 61234 tokens > 60000 maximum (context_length_exceeded)",
			});
		}
		if (scenario.task === "overflow-then-ok" && taskCalls === 1) {
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 61234 tokens > 60000 maximum",
			});
		}
		return fauxAssistantMessage("done: trivial task completed");
	};

	const prompts = scenario.prompts ?? 1;
	if (scenario.warmUp) {
		h.setResponses(Array.from({ length: 10 }, () => respond));
		await h.session.prompt("WARMUP: ordinary request below the threshold");
		seedHistory(h, scenario.window, scenario.ratio);
	}
	for (let i = 0; i < prompts; i++) {
		h.setResponses(Array.from({ length: 40 }, () => respond));
		try {
			if (scenario.manualCompact) await h.session.compact();
			await h.session.prompt(`TASK ${i + 1}: say hi`);
		} catch (error) {
			records.push({
				kind: "task",
				messages: 0,
				tokens: 0,
				ms: Date.now() - started,
				attempt: -1,
			});
			lines.push(`  运行错误：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const seq = records.map((item) => `${item.kind}#${item.attempt}(${item.tokens}tok)`).join(" -> ");
	const events = h.events
		.filter((event) => ["auto_clm_start", "auto_clm_end", "compaction_start", "compaction_end"].includes(event.type))
		.map((event) => {
			if (event.type === "auto_clm_end")
				return `auto_clm_end(${event.result.reason},accepted=${event.result.accepted},transport=${event.result.transport ?? "-"})`;
			return event.type;
		})
		.join(",");
	lines.push(
		`\n### ${scenario.title}`,
		`- window=${scenario.window} 已填充≈${seeded} token (${Math.round(scenario.ratio * 100)}%) mode=${scenario.mode ?? "default"} trigger=${scenario.triggerPolicy ?? "v2"} autoClm=${scenario.autoClm ?? true}`,
		`- 请求序列（${records.length}）：${seq}`,
		`- 事件：${events || "(无)"}`,
	);
	const failures = (h.session as unknown as { _thresholdCompactionFailures: number })._thresholdCompactionFailures;
	lines.push(`- 压缩失败计数=${failures}`);
}

describe("near-full-context compaction scenarios", () => {
	it("collects the request sequence for every compaction path", async () => {
		lines.push("# 近满上下文压缩复现", "");
		const scenarios: Scenario[] = [
			{
				title: "A. CLM 接受（冷前缀，private tool 传输）",
				window: 200_000,
				ratio: 0.93,
				clm: "accept",
				summary: "ok",
				task: "ok",
			},
			{
				title: "B. CLM 接受后，第二个 prompt 复用 actor 前缀",
				window: 200_000,
				ratio: 0.93,
				clm: "accept",
				summary: "ok",
				task: "ok",
				prompts: 2,
			},
			{
				title: "C. CLM 无编辑 -> 回退原生摘要",
				window: 200_000,
				ratio: 0.93,
				clm: "no-edit",
				summary: "ok",
				task: "ok",
			},
			{
				title: "D. CLM 返回非法 JSON -> 回退原生摘要",
				window: 200_000,
				ratio: 0.93,
				clm: "invalid",
				summary: "ok",
				task: "ok",
			},
			{
				title: "E. CLM 超时（线上 90s）-> 回退原生摘要",
				window: 200_000,
				ratio: 0.93,
				clm: "timeout",
				summary: "ok",
				task: "ok",
			},
			{
				title: "F. 仅原生压缩（contextProjection=off）",
				window: 200_000,
				ratio: 0.93,
				mode: "off",
				clm: "accept",
				summary: "ok",
				task: "ok",
			},
			{
				title: "G. 原生摘要失败（可重试超时），重试 3 次",
				window: 200_000,
				ratio: 0.93,
				mode: "off",
				clm: "accept",
				summary: "error",
				task: "ok",
				maxRetries: 3,
				prompts: 2,
			},
			{
				title: "H. 原生摘要撞输出上限（stopReason=length）",
				window: 200_000,
				ratio: 0.93,
				mode: "off",
				clm: "accept",
				summary: "length",
				task: "ok",
			},
			{
				title: "I. 低于阈值时任务请求被 provider 判溢出",
				window: 200_000,
				ratio: 0.5,
				mode: "off",
				clm: "accept",
				summary: "ok",
				task: "overflow-then-ok",
			},
			{
				title: "J. 阈值附近的 lightweight-v1 投影",
				window: 200_000,
				ratio: 0.93,
				mode: "lightweight-v1",
				clm: "accept",
				summary: "ok",
				task: "ok",
			},
			{
				title: "K. legacy 触发策略，CLM 接受",
				window: 200_000,
				ratio: 0.93,
				triggerPolicy: "legacy",
				clm: "accept",
				summary: "ok",
				task: "ok",
			},
			{
				title: "L. 阈值附近手动 /compact",
				window: 200_000,
				ratio: 0.93,
				clm: "accept",
				summary: "ok",
				task: "ok",
				manualCompact: true,
			},
			{
				title: "M. 普通回合后上下文越过阈值（复用 cached actor 前缀）",
				window: 200_000,
				ratio: 0.93,
				clm: "accept",
				summary: "ok",
				task: "ok",
				warmUp: true,
			},
			{
				title: "N. split turn：一个超大回合被拆成历史摘要 + 前缀摘要",
				window: 200_000,
				ratio: 0.93,
				mode: "off",
				clm: "accept",
				summary: "ok",
				task: "ok",
				splitTurn: true,
			},
			{
				title: "O. 关闭自动 CLM -> 阈值处走原生压缩",
				window: 200_000,
				ratio: 0.93,
				autoClm: false,
				clm: "accept",
				summary: "ok",
				task: "ok",
			},
		];
		for (const scenario of scenarios) await runScenario(scenario);
		expect(lines.length).toBeGreaterThan(scenarios.length);
	}, 180_000);
});
