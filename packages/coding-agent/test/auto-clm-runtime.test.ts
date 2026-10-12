import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@step-harness/agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@step-harness/providers";
import { streamSimple } from "@step-harness/providers/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoClmController } from "../src/core/compaction/live-context/auto-compaction.ts";
import { resolveAutoClmSettings } from "../src/core/compaction/live-context/auto-options.ts";
import { LiveContextManager } from "../src/core/compaction/live-context/manager.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getAutoClmUsage } from "../src/core/usage-totals.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(history?: AgentMessage[]) {
	const root = mkdtempSync(join(tmpdir(), "auto-clm-runtime-"));
	roots.push(root);
	const session = SessionManager.inMemory();
	const raw: AgentMessage[] = history ?? [
		{ role: "user", content: "Keep exact parser errors and public API", timestamp: 1 },
		fauxAssistantMessage("Successful old observation. ".repeat(6000), { timestamp: 2 }),
		fauxAssistantMessage("Current task: implement parser", { timestamp: 3 }),
	];
	for (const message of raw)
		if (message.role === "user" || message.role === "assistant") session.appendMessage(message);
	const live = new LiveContextManager(session, { directory: root });
	const model = { provider: "faux", id: "automatic-clm", contextWindow: 64000, maxTokens: 8192 } as Model<any>;
	return { session, live, raw, controller: new AutoClmController(session, live), model };
}
function input(state: ReturnType<typeof setup>, stream: StreamFn) {
	return {
		context: { systemPrompt: "Task instructions", messages: state.raw, tools: [] },
		canonical: state.raw,
		model: state.model,
		thinkingLevel: "off" as ThinkingLevel,
		settings: resolveAutoClmSettings({ softThresholdRatio: 0.6 }),
		reserveTokens: 8192,
		stream,
		controller: new AbortController(),
		isInterrupted: () => false,
		currentCanonical: () => state.raw,
		onStart: () => {},
	};
}
function completed(message = fauxAssistantMessage("No edit")) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}
const usage = {
	input: 100,
	output: 25,
	cacheRead: 30,
	cacheWrite: 0,
	totalTokens: 155,
	cost: { input: 1, output: 1, cacheRead: 0.3, cacheWrite: 0, total: 2.3 },
};

describe("bounded automatic CLM requests", () => {
	it("uses a matching actor prefix for JSON edits without changing system or tools", async () => {
		const state = setup();
		const cached = {
			systemPrompt: "Original actor instructions",
			messages: convertToLlm(state.raw),
			tools: [
				{
					name: "project_write",
					description: "Actor-only write tool",
					parameters: { type: "object", properties: {} },
				},
			],
		};
		const result = await state.controller.run({
			...input(state, (_model, context, options) => {
				expect(context.systemPrompt).toBe(cached.systemPrompt);
				expect(context.tools).toEqual(cached.tools);
				expect(context.messages.slice(0, cached.messages.length)).toEqual(cached.messages);
				expect(options?.toolChoice).toBeUndefined();
				return completed(
					fauxAssistantMessage(
						JSON.stringify({
							replacements: [
								{ id: "2", text: "Prior observations complete. Preserve parser errors and the public API." },
							],
						}),
					),
				);
			}),
			cachedContext: cached,
		});
		expect(result).toMatchObject({ transport: "cached-json", accepted: true, fallback: false, requests: 1 });
		expect(JSON.stringify(state.raw)).toContain("Successful old observation.");
		expect(JSON.stringify(state.live.project(state.raw))).toContain("Prior observations complete");
	});

	it("never dispatches project tool calls returned during cached maintenance", async () => {
		const state = setup();
		const result = await state.controller.run({
			...input(state, () =>
				completed(fauxAssistantMessage(fauxToolCall("project_write", { path: "file" }), { stopReason: "toolUse" })),
			),
			cachedContext: { systemPrompt: "Actor instructions", messages: convertToLlm(state.raw), tools: [] },
		});
		expect(result).toMatchObject({
			transport: "cached-json",
			accepted: false,
			fallback: true,
			reason: "unexpected-tool",
		});
		expect(state.live.project(state.raw)).toEqual(state.raw);
	});

	it("discards a cached JSON edit when its canonical source changes in flight", async () => {
		const state = setup();
		const result = await state.controller.run({
			...input(state, () => {
				state.raw[0] = { role: "user", content: "New requirements take priority.", timestamp: 100 };
				return completed(fauxAssistantMessage(JSON.stringify({ replacements: [{ id: "2", text: "stale" }] })));
			}),
			cachedContext: { systemPrompt: "Actor instructions", messages: convertToLlm(state.raw), tools: [] },
		});
		expect(result).toMatchObject({ accepted: false, fallback: false, reason: "context-changed" });
	});

	it("does not prepare a correction after the branch changes during draft validation", async () => {
		const state = setup();
		const root = state.session.getBranch()[0].id;
		const prepare = vi.spyOn(state.live, "prepare");
		vi.spyOn(state.live, "replace").mockImplementationOnce(async () => {
			state.session.branch(root);
			return { accepted: false, revision: 0, reason: "The source branch changed." };
		});
		const result = await state.controller.run(
			input(state, () =>
				completed(
					fauxAssistantMessage(
						fauxToolCall("apply_context_edit", { replacements: [{ id: "2", text: "Old summary" }] }),
						{ stopReason: "toolUse" },
					),
				),
			),
		);
		expect(result).toMatchObject({ accepted: false, fallback: false, reason: "context-changed", requests: 1 });
		expect(prepare).toHaveBeenCalledTimes(1);
	});
	it("reports an already committed edit accurately if the branch moves afterward", async () => {
		const state = setup();
		const root = state.session.getBranch()[0].id;
		const replace = state.live.replace.bind(state.live);
		vi.spyOn(state.live, "replace").mockImplementationOnce(async (...args) => {
			const outcome = await replace(...args);
			state.session.branch(root);
			return outcome;
		});
		const result = await state.controller.run(
			input(state, () =>
				completed(
					fauxAssistantMessage(
						fauxToolCall("apply_context_edit", {
							replacements: [{ id: "2", text: "Keep exact parser errors and public API" }],
						}),
						{ stopReason: "toolUse" },
					),
				),
			),
		);
		expect(result).toMatchObject({ accepted: true, fallback: false, reason: "accepted", requests: 1 });
		expect(state.live.project(state.raw)).toEqual(state.raw);
	});
	it("does not rebase an in-flight edit after a working-context reset", async () => {
		const state = setup();
		const result = await state.controller.run(
			input(state, () => {
				state.live.reset();
				return completed({
					...fauxAssistantMessage(
						fauxToolCall("apply_context_edit", { replacements: [{ id: "2", text: "Stale summary" }] }),
						{ stopReason: "toolUse" },
					),
					usage,
				});
			}),
		);
		expect(result).toMatchObject({ accepted: false, fallback: false, reason: "context-changed", requests: 1 });
		expect(state.live.project(state.raw)).toEqual(state.raw);
	});
	it("keeps the dispatched maintenance messages immutable when source objects change", async () => {
		const state = setup();
		const result = await state.controller.run(
			input(state, (_model, context) => {
				const sent = structuredClone(context.messages);
				if (state.raw[0].role !== "user") throw new Error("invalid fixture");
				state.raw[0].content = "Changed requirements";
				expect(context.messages).toEqual(sent);
				return completed();
			}),
		);
		expect(result).toMatchObject({ accepted: false, fallback: false, reason: "context-changed", requests: 1 });
	});
	it("does not send an old-session request after authentication switches sessions", async () => {
		const state = setup();
		let calls = 0;
		const options = {
			...input(state, () => {
				calls++;
				return completed();
			}),
			resolveAuth: async () => {
				state.session.newSession();
				return { model: state.model };
			},
		};
		expect(await state.controller.run(options)).toMatchObject({
			accepted: false,
			fallback: false,
			reason: "context-changed",
			requests: 0,
		});
		expect(calls).toBe(0);
		expect(
			state.session.getEntries().filter((e) => e.type === "custom" && e.customType.startsWith("step-auto-clm")),
		).toHaveLength(0);
	});
	it("does not attempt maintenance when the offered blocks cannot satisfy minimum savings", async () => {
		const state = setup([
			{ role: "user", content: "Preserve all requirements", timestamp: 1 },
			...Array.from({ length: 500 }, () => fauxAssistantMessage("x".repeat(100))),
			fauxAssistantMessage("Current task"),
		]);
		state.model.contextWindow = 32000;
		let requests = 0;
		const options = input(state, () => {
			requests++;
			return completed();
		});
		options.reserveTokens = 20000;
		const result = await state.controller.run(options);
		expect(result).toMatchObject({ attempted: false, reason: "no-reducible-context", requests: 0 });
		expect(requests).toBe(0);
	});
	it("does not prepare or send an edit after the branch changes during authentication", async () => {
		const state = setup();
		const root = state.session.getBranch()[0].id;
		let requests = 0;
		const options = {
			...input(state, () => {
				requests++;
				return completed(
					fauxAssistantMessage(
						fauxToolCall("apply_context_edit", { replacements: [{ id: "2", text: "Old summary" }] }),
						{ stopReason: "toolUse" },
					),
				);
			}),
			resolveAuth: async () => {
				state.session.branch(root);
				return { model: state.model };
			},
		};
		const result = await state.controller.run(options);
		expect(result).toMatchObject({
			attempted: true,
			accepted: false,
			fallback: false,
			reason: "context-changed",
			requests: 0,
		});
		expect(requests).toBe(0);
		expect(state.live.status().revision).toBe(0);
	});
	it("discards a response for a changed branch without applying edits or inheriting its cooldown", async () => {
		const state = setup();
		const originalLeaf = state.session.getLeafId();
		const root = state.session.getBranch()[0].id;
		const result = await state.controller.run(
			input(state, () => {
				state.session.branch(root);
				return completed({
					...fauxAssistantMessage(
						fauxToolCall("apply_context_edit", { replacements: [{ id: "2", text: "Old summary" }] }),
						{ stopReason: "toolUse" },
					),
					usage,
				});
			}),
		);
		expect(result).toMatchObject({ accepted: false, fallback: false, reason: "context-changed", requests: 1 });
		expect(state.live.status().revision).toBe(0);
		const row = state.session.getEntries().find((e) => e.type === "custom" && e.customType === "step-auto-clm-usage");
		expect(row).toMatchObject({ data: { sourceLeafId: originalLeaf, usage } });
		for (const message of state.raw.slice(1)) if (message.role === "assistant") state.session.appendMessage(message);
		const next = await new AutoClmController(state.session, state.live).run(input(state, () => completed()));
		expect(next).toMatchObject({ attempted: true, requests: 1 });
	});
	it("discards an edit when canonical input changes even without a queue signal", async () => {
		const state = setup();
		let canonical = state.raw;
		const options = input(state, () => {
			canonical = [...state.raw, { role: "user", content: "NEW REQUIREMENT: keep the old capture", timestamp: 99 }];
			return completed({
				...fauxAssistantMessage(
					fauxToolCall("apply_context_edit", { replacements: [{ id: "2", text: "Old summary" }] }),
					{ stopReason: "toolUse" },
				),
				usage,
			});
		});
		options.currentCanonical = () => canonical;
		expect(await state.controller.run(options)).toMatchObject({
			accepted: false,
			fallback: false,
			reason: "context-changed",
			requests: 1,
		});
		expect(state.live.status().revision).toBe(0);
		expect(canonical.at(-1)).toMatchObject({ role: "user", content: "NEW REQUIREMENT: keep the old capture" });
	});
	it("allows unrelated metadata appends while keeping the same canonical input and branch", async () => {
		const state = setup();
		const result = await state.controller.run(
			input(state, () => {
				state.session.appendCustomEntry("other-extension", { progress: "unchanged context" });
				return completed(
					fauxAssistantMessage(
						fauxToolCall("apply_context_edit", {
							replacements: [{ id: "2", text: "Keep exact parser errors and public API" }],
						}),
						{ stopReason: "toolUse" },
					),
				);
			}),
		);
		expect(result).toMatchObject({ accepted: true, requests: 1 });
	});
	it.each(["2", 2])("accepts the exact request-local short ID %j without a correction call", async (id) => {
		const state = setup();
		const original = structuredClone(state.raw);
		const result = await state.controller.run(
			input(state, () =>
				completed({
					...fauxAssistantMessage(
						fauxToolCall("apply_context_edit", {
							replacements: [{ id, text: "Prior checks passed. Keep exact parser errors and public API." }],
						}),
						{ stopReason: "toolUse" },
					),
					usage,
				}),
			),
		);
		expect(result).toMatchObject({ accepted: true, fallback: false, requests: 1 });
		expect(state.live.project(state.raw)[1]).toMatchObject({
			content: [{ type: "text", text: "Prior checks passed. Keep exact parser errors and public API." }],
		});
		expect(state.live.project(state.raw)[0]).toEqual(original[0]);
		expect(state.live.project(state.raw).at(-1)).toEqual(original.at(-1));
		expect(state.raw).toEqual(original);
		expect(state.session.getEntries().flatMap((entry) => getAutoClmUsage(entry) ?? [])).toEqual([usage]);
	});
	it("corrects only the rejected draft without replaying maintenance reasoning or signed assistant data", async () => {
		const state = setup();
		state.model.contextWindow = 48000;
		const taskReasoning = "TASK_REASONING_MUST_REMAIN";
		const task = fauxAssistantMessage([
			{ type: "thinking", thinking: taskReasoning, thinkingSignature: "task-signature" },
			{ type: "text", text: "The parser still needs implementation and verification." },
		]);
		state.raw.push(task);
		state.session.appendMessage(task);
		const maintenanceReasoning = "MAINTENANCE_REASONING_DISCARD ".repeat(330);
		let calls = 0;
		let firstCap = 0;
		let validId = "";
		const result = await state.controller.run(
			input(state, (_model, context, options) => {
				calls++;
				if (calls === 1) {
					firstCap = options!.maxTokens!;
					validId = /- id=([^ ]+) role=assistant chars=/.exec(JSON.stringify(context.messages))![1];
					return completed({
						...fauxAssistantMessage(
							[
								{
									type: "thinking",
									thinking: maintenanceReasoning,
									thinkingSignature: "maintenance-signature",
								},
								fauxToolCall("apply_context_edit", {
									replacements: [
										{ id: "unknown", text: "Keep exact parser errors and implement csv.reader." },
									],
								}),
							],
							{ stopReason: "toolUse" },
						),
						usage,
					});
				}
				const serialized = JSON.stringify(context.messages);
				expect(serialized).toContain(taskReasoning);
				expect(serialized).toContain("task-signature");
				expect(serialized).not.toContain("MAINTENANCE_REASONING_DISCARD");
				expect(serialized).not.toContain("maintenance-signature");
				expect(serialized).toContain("Edit rejected:");
				expect(serialized).toContain("Keep exact parser errors and implement csv.reader.");
				expect(context.messages.at(-1)).toMatchObject({ role: "user" });
				expect(options!.maxTokens!).toBeGreaterThan(firstCap - 512);
				return completed({
					...fauxAssistantMessage(
						fauxToolCall("apply_context_edit", {
							replacements: [{ id: validId, text: "Keep exact parser errors and implement csv.reader." }],
						}),
						{ stopReason: "toolUse" },
					),
					usage,
				});
			}),
		);
		expect(result).toMatchObject({ accepted: true, fallback: false, requests: 2 });
		expect(calls).toBe(2);
		expect(state.session.getEntries().flatMap((entry) => getAutoClmUsage(entry) ?? [])).toEqual([usage, usage]);
		expect(JSON.stringify(state.raw)).not.toContain("MAINTENANCE_REASONING_DISCARD");
	});
	it("falls back before sending a maintenance request that has insufficient output headroom", async () => {
		const state = setup();
		state.model.contextWindow = 46000;
		let requests = 0;
		const runInput = input(state, () => {
			requests++;
			return completed();
		});
		delete runInput.settings.softThresholdRatio;
		const result = await state.controller.run(runInput);
		expect(result).toMatchObject({
			attempted: true,
			accepted: false,
			fallback: true,
			reason: "insufficient-headroom",
			requests: 0,
		});
		expect(requests).toBe(0);
	});
	it("accounts a late response even when async stream acquisition exceeds the deadline", async () => {
		const state = setup();
		vi.useFakeTimers();
		try {
			let release!: () => void;
			let started!: () => void;
			const acquired = new Promise<void>((resolve) => {
				release = resolve;
			});
			const requested = new Promise<void>((resolve) => {
				started = resolve;
			});
			const runInput = input(state, async () => {
				started();
				await acquired;
				return completed({ ...fauxAssistantMessage("Late response"), usage });
			});
			runInput.settings.timeoutMs = 100;
			const pending = state.controller.run(runInput);
			await requested;
			await vi.advanceTimersByTimeAsync(100);
			expect(await pending).toMatchObject({
				attempted: true,
				accepted: false,
				fallback: true,
				reason: "timeout",
				requests: 1,
			});
			release();
			await vi.advanceTimersByTimeAsync(0);
			const usages = state.session.getEntries().flatMap((entry) => getAutoClmUsage(entry) ?? []);
			expect(usages).toEqual([usage]);
			expect(state.live.status().revision).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("bounds correction requests and records rejected attempts exactly once", async () => {
		const state = setup();
		let requests = 0;
		const result = await state.controller.run(
			input(state, (_model, context, options) => {
				requests++;
				expect(options?.maxTokens).toBeLessThanOrEqual(8192);
				expect(context.tools?.map((tool) => tool.name)).toEqual(["apply_context_edit"]);
				return completed({
					...fauxAssistantMessage(
						fauxToolCall("apply_context_edit", { replacements: [{ id: "invalid", text: "summary" }] }),
						{ stopReason: "toolUse" },
					),
					usage,
				});
			}),
		);
		expect(result).toMatchObject({ accepted: false, fallback: true, requests: 2 });
		expect(requests).toBe(2);
		expect(state.session.getEntries().flatMap((entry) => getAutoClmUsage(entry) ?? [])).toEqual([usage, usage]);
	});
	it("does not spend a request on immutable replay metadata", async () => {
		const state = setup();
		Object.assign(state.raw[1], { reasoning_content: "Opaque provider replay" });
		let requests = 0;
		const result = await state.controller.run(
			input(state, () => {
				requests++;
				return completed();
			}),
		);
		expect(result).toMatchObject({ attempted: false, reason: "no-reducible-context" });
		expect(requests).toBe(0);
	});
	it("reconstructs cooldown from completed task turns while ignoring failed responses", async () => {
		const state = setup();
		state.session.appendCustomEntry("step-auto-clm", { version: 1, attempted: true, accepted: false });
		for (const stopReason of ["error", "aborted", "length"] as const)
			state.session.appendMessage(fauxAssistantMessage("Failed response", { stopReason }));
		const result = await new AutoClmController(state.session, state.live).run(input(state, () => completed()));
		expect(result).toMatchObject({ attempted: false, reason: "cooldown" });
	});
	it("caps actual provider output including legacy Anthropic thinking", async () => {
		const state = setup();
		state.model = {
			...state.model,
			name: "Test",
			api: "anthropic-messages",
			baseUrl: "http://127.0.0.1:9",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 32768,
		};
		let payload: { max_tokens: number; thinking?: { budget_tokens: number } } | undefined;
		const runInput = input(state, (model, context, options) =>
			streamSimple(model, context, {
				...options,
				apiKey: "fake-key",
				onPayload: (body) => {
					payload = body as typeof payload;
					throw new Error("Capture before HTTP dispatch");
				},
			}),
		);
		runInput.thinkingLevel = "high";
		runInput.settings.maxRequests = 1;
		await state.controller.run(runInput);
		expect(payload).toBeDefined();
		expect(payload!.max_tokens).toBeLessThanOrEqual(8192);
		expect(payload!.thinking!.budget_tokens).toBeLessThan(payload!.max_tokens);
	});
	it("budgets system instructions, index and tool schema when clamping a maintenance request", async () => {
		const state = setup();
		state.model.contextWindow = 48000;
		let estimate = 0;
		let cap = 0;
		const runInput = input(state, (model, context, options) => {
			estimate = context.estimatedInputTokens!;
			cap = options!.maxTokens!;
			expect(context.systemPrompt).toContain("maintaining");
			expect(context.messages.at(-1)).toMatchObject({ role: "user" });
			expect(model.maxTokens).toBe(cap);
			return completed();
		});
		runInput.reserveTokens = 2048;
		const result = await state.controller.run(runInput);
		expect(result.requests).toBe(1);
		expect(cap).toBeGreaterThanOrEqual(512);
		expect(cap).toBeLessThan(8192);
		expect(estimate + cap + 4096).toBeLessThanOrEqual(state.model.contextWindow);
	});
	it("rebuilds cooldown on resume and uses only the selected branch", async () => {
		const state = setup();
		const branchRoot = state.session.getLeafId()!;
		const marker = state.session.appendCustomEntry("step-auto-clm", { version: 1, attempted: true, accepted: false });
		for (let turn = 0; turn < 2; turn++) state.session.appendMessage(fauxAssistantMessage("Completed normal turn"));
		const resumed = new AutoClmController(state.session, state.live);
		expect(await resumed.run(input(state, () => completed()))).toMatchObject({
			attempted: false,
			reason: "cooldown",
		});
		state.session.appendMessage(fauxAssistantMessage("Third completed turn"));
		expect(await resumed.run(input(state, () => completed()))).toMatchObject({ attempted: true, requests: 1 });
		state.session.branch(marker);
		expect(await resumed.run(input(state, () => completed()))).toMatchObject({
			attempted: false,
			reason: "cooldown",
		});
		state.session.branch(branchRoot);
		expect(await resumed.run(input(state, () => completed()))).toMatchObject({ attempted: true, requests: 1 });
	});
	it("counts a parallel tool turn only once after every result is persisted", async () => {
		const state = setup();
		state.session.appendCustomEntry("step-auto-clm", { version: 1, attempted: true, accepted: false });
		state.session.appendMessage(
			fauxAssistantMessage(
				[fauxToolCall("first", {}, { id: "first-id" }), fauxToolCall("second", {}, { id: "second-id" })],
				{ stopReason: "toolUse" },
			),
		);
		const result = (id: string) => ({
			role: "toolResult" as const,
			toolCallId: id,
			toolName: id === "first-id" ? "first" : "second",
			content: [{ type: "text" as const, text: "complete" }],
			isError: false,
			timestamp: 4,
		});
		state.session.appendMessage(result("first-id"));
		const runInput = input(state, () => completed());
		runInput.settings.cooldownTurns = 1;
		expect(await state.controller.run(runInput)).toMatchObject({ attempted: false, reason: "cooldown" });
		state.session.appendMessage(result("second-id"));
		expect(await state.controller.run(runInput)).toMatchObject({ attempted: true, requests: 1 });
	});
});
