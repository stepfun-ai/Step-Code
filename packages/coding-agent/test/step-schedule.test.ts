import type { AgentMessage } from "@step-harness/agent-core";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	continuationPrompt,
	createStepGoalExtension,
	type StepGoalRecord,
	StepGoalRuntime,
	type StepGoalSnapshot,
} from "../src/features/step-schedule.ts";
import type { StepTelemetryReporter } from "../src/step/telemetry.ts";

function assistant(
	stopReason = "stop",
	totalTokens = 0,
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {},
): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "work" }],
		stopReason,
		usage: { totalTokens, ...usage },
	} as unknown as AgentMessage;
}

function runtimeHarness(options: { idle?: boolean; pending?: boolean; now?: () => number } = {}) {
	let idle = options.idle ?? false;
	let pending = options.pending ?? false;
	const persisted: Array<StepGoalSnapshot | undefined> = [];
	const continuations: Array<{ goal: StepGoalRecord; delivery: "queued" | "immediate" }> = [];
	const runtime = new StepGoalRuntime({
		now: options.now ?? (() => 1_000),
		idFactory: () => "goal-1",
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		persist: (snapshot) => persisted.push(snapshot),
		requestContinuation: (continuation) => continuations.push(continuation),
	});
	return {
		runtime,
		persisted,
		continuations,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean) => {
			pending = value;
		},
	};
}

describe("StepGoalRuntime", () => {
	test("creates one explicit goal and rejects an unfinished replacement", () => {
		const { runtime } = runtimeHarness();
		const goal = runtime.start("Finish the failing tests", "session-1", 10_000);
		expect(goal).toMatchObject({
			id: "goal-1",
			objective: "Finish the failing tests",
			status: "active",
			tokenBudget: 10_000,
		});
		expect(() => runtime.start("another objective", "session-1")).toThrow("unfinished");
	});

	test("rejects empty and oversize objectives without silent truncation", () => {
		const { runtime } = runtimeHarness();
		expect(() => runtime.start("   ", "session-1")).toThrow("Goal objective cannot be empty");
		expect(() => runtime.start("x".repeat(16_001), "session-1")).toThrow(/exceeds 16000 characters/);
		// After a rejected create, no goal is committed.
		expect(runtime.get()).toBeUndefined();
		// setObjective rejects the same way once a goal exists.
		runtime.start("initial", "session-1");
		expect(() => runtime.setObjective("y".repeat(16_001))).toThrow(/exceeds 16000 characters/);
		expect(runtime.get()?.objective).toBe("initial");
	});

	test("continues a goal created during the current agent run", () => {
		const harness = runtimeHarness({ idle: true });
		harness.runtime.onAgentStart();
		harness.runtime.start("Finish the requested migration", "session-1");
		harness.runtime.onAgentEnd([assistant("stop", 5)]);
		harness.runtime.onAgentSettled();
		expect(harness.runtime.get()).toMatchObject({ tokensUsed: 5, iteration: 1, status: "active" });
		expect(harness.continuations).toHaveLength(1);
	});

	test("only accepts complete or blocked from the model", () => {
		const { runtime, continuations } = runtimeHarness({ idle: true });
		runtime.start("Verify the build", "session-1");
		runtime.onAgentStart();
		runtime.onAgentEnd([assistant()]);
		expect(continuations).toHaveLength(0);
		runtime.onAgentSettled();
		expect(continuations).toHaveLength(1);

		runtime.onAgentStart();
		expect(() => runtime.update("active" as never)).toThrow();
		runtime.update("complete");
		runtime.onAgentEnd([assistant()]);
		runtime.onAgentSettled();
		expect(runtime.get()).toMatchObject({ status: "complete" });
		expect(continuations).toHaveLength(1);
	});

	test("does not infer a disposition from assistant prose", () => {
		const { runtime, continuations } = runtimeHarness({ idle: true });
		runtime.start("Verify the build", "session-1");
		runtime.onAgentStart();
		runtime.onAgentEnd([assistant()]);
		expect(runtime.get()?.status).toBe("active");
		runtime.onAgentSettled();
		expect(continuations).toHaveLength(1);
	});

	test("continues only after Pi reports agent_settled", () => {
		const harness = runtimeHarness();
		harness.runtime.start("Keep checking CI", "session-1");
		harness.runtime.onAgentStart();
		harness.runtime.onAgentEnd([assistant()]);
		expect(harness.continuations).toHaveLength(0);
		harness.setIdle(true);
		expect(harness.runtime.onAgentSettled()).toMatchObject({ delivery: "immediate" });
		expect(harness.continuations).toHaveLength(1);
	});

	test("accounts retries as one run and increments after settlement", () => {
		let now = 1_000;
		const harness = runtimeHarness({ idle: true, now: () => now });
		harness.runtime.start("Track the run", "session-1");
		harness.runtime.onAgentStart();
		now = 1_600;
		harness.runtime.onAgentEnd([assistant("toolUse", 3), assistant("stop", 4)]);
		harness.runtime.onAgentEnd([assistant("stop", 99)]);
		expect(harness.runtime.get()).toMatchObject({
			tokensUsed: 7,
			iteration: 1,
			timeUsedSeconds: 0,
		});

		harness.runtime.onAgentSettled();
		harness.runtime.onAgentStart();
		now = 2_400;
		harness.runtime.onAgentEnd([assistant("stop", 1)]);
		expect(harness.runtime.get()).toMatchObject({ tokensUsed: 8, iteration: 2, timeUsedSeconds: 1 });
	});

	test("does not charge tokens emitted before a goal is created", () => {
		let now = 1_000;
		const harness = runtimeHarness({ idle: true, now: () => now });
		harness.runtime.onAgentStart();
		harness.runtime.onMessageEnd(assistant("toolUse", 20));
		harness.runtime.start("Track only the goal run", "session-1");
		now = 2_500;
		const afterCreation = assistant("stop", 7);
		harness.runtime.onMessageEnd(afterCreation);
		harness.runtime.onAgentEnd([afterCreation]);
		harness.runtime.onAgentSettled();
		expect(harness.runtime.get()).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 1, iteration: 1 });
	});

	test("uses uncached input plus output for the token budget", () => {
		const harness = runtimeHarness({ idle: true });
		harness.runtime.start("Count billable usage", "session-1");
		harness.runtime.onAgentStart();
		harness.runtime.onAgentEnd([assistant("stop", 999, { input: 10, output: 3, cacheRead: 80, cacheWrite: 5 })]);
		harness.runtime.onAgentSettled();
		expect(harness.runtime.get()?.tokensUsed).toBe(13);
	});

	test("accounts progress before accepting a terminal model update", () => {
		const harness = runtimeHarness();
		harness.runtime.start("Verify the release", "session-1");
		harness.runtime.onAgentStart();
		harness.runtime.onMessageEnd(assistant("toolUse", 9));
		const goal = harness.runtime.update("complete");
		expect(goal).toMatchObject({ status: "complete", tokensUsed: 9 });
	});

	test("leaves a native user queue ahead of goal continuation", () => {
		const harness = runtimeHarness({ pending: true, idle: true });
		harness.runtime.start("Wait for the queued request", "session-1");
		harness.runtime.onAgentStart();
		harness.runtime.onAgentEnd([assistant()]);
		harness.runtime.onAgentSettled();
		expect(harness.continuations).toHaveLength(0);
		harness.setPending(false);
		harness.runtime.onAgentSettled();
		expect(harness.continuations).toHaveLength(1);
	});

	test("supports user pause, resume, and clear", () => {
		const harness = runtimeHarness({ idle: true });
		harness.runtime.start("Ship the change", "session-1");
		harness.runtime.setUserStatus("paused");
		expect(harness.runtime.get()?.status).toBe("paused");
		harness.runtime.setUserStatus("active");
		expect(harness.runtime.get()?.status).toBe("active");
		expect(harness.continuations).toHaveLength(1);
		expect(harness.runtime.clear()).toBe(true);
		expect(harness.runtime.get()).toBeUndefined();
	});

	test("edits terminal goals back to active and preserves resumable statuses", () => {
		const harness = runtimeHarness({ idle: true });
		harness.runtime.start("Initial objective", "session-1");
		harness.runtime.update("complete");
		expect(harness.runtime.setObjective("Revised objective")).toMatchObject({
			objective: "Revised objective",
			status: "active",
		});
		harness.runtime.onSessionReady();
		harness.runtime.update("blocked");
		harness.runtime.setObjective("Blocked objective");
		expect(harness.runtime.get()).toMatchObject({ objective: "Blocked objective", status: "blocked" });
	});

	test("accounts token/time usage and stops at a requested budget", () => {
		let now = 1_000;
		const harness = runtimeHarness({ idle: true, now: () => now });
		harness.runtime.start("Build the release", "session-1", 5);
		harness.runtime.onAgentStart();
		now = 4_500;
		harness.runtime.onAgentEnd([assistant("stop", 6)]);
		harness.runtime.onAgentSettled();
		expect(harness.runtime.get()).toMatchObject({
			status: "budget_limited",
			tokensUsed: 6,
			timeUsedSeconds: 3,
		});
		expect(harness.continuations).toHaveLength(0);
	});

	test("accounts active wall-clock time at idle boundaries", () => {
		let now = 1_000;
		const harness = runtimeHarness({ idle: true, now: () => now });
		harness.runtime.start("Track elapsed goal time", "session-1");
		now = 2_500;
		harness.runtime.onSessionReady();
		expect(harness.runtime.get()).toMatchObject({ timeUsedSeconds: 1 });
		harness.runtime.setUserStatus("paused");
		now = 8_000;
		harness.runtime.setUserStatus("active");
		expect(harness.runtime.get()).toMatchObject({ timeUsedSeconds: 1 });
	});

	test("keeps budget and provider-limit statuses distinct", () => {
		const budget = runtimeHarness({ idle: true });
		budget.runtime.start("Finish within budget", "session-1", 1);
		budget.runtime.onAgentStart();
		budget.runtime.onAgentEnd([assistant("stop", 1)]);
		budget.runtime.onAgentSettled();
		expect(budget.runtime.get()?.status).toBe("budget_limited");
		budget.runtime.update("complete");
		expect(budget.runtime.get()?.status).toBe("complete");

		const limited = runtimeHarness();
		limited.runtime.start("Wait for capacity", "session-1");
		limited.runtime.onAgentStart();
		limited.runtime.onAgentEnd([
			{ ...assistant("error"), errorMessage: "overloaded_error" } as unknown as AgentMessage,
		]);
		limited.runtime.onAgentSettled();
		expect(limited.runtime.get()?.status).toBe("usage_limited");
	});

	test("pauses an interrupted run and blocks an errored run", () => {
		const interrupted = runtimeHarness();
		interrupted.runtime.start("Finish the release", "session-1");
		interrupted.runtime.onAgentStart();
		interrupted.runtime.onAgentEnd([assistant("aborted")]);
		interrupted.runtime.onAgentSettled();
		expect(interrupted.runtime.get()?.status).toBe("paused");

		const failed = runtimeHarness();
		failed.runtime.start("Recover the service", "session-1");
		failed.runtime.onAgentStart();
		failed.runtime.onAgentEnd([assistant("error")]);
		failed.runtime.onAgentSettled();
		expect(failed.runtime.get()?.status).toBe("blocked");
	});

	test("restores a matching snapshot and honors a clear tombstone", () => {
		const source = runtimeHarness();
		const goal = source.runtime.start("Persist me", "session-1");
		const restored = new StepGoalRuntime();
		expect(restored.restoreSnapshot(goal, "session-1")).toMatchObject({ valid: true, cleared: false });
		expect(restored.restoreSnapshot(goal, "other-session")).toMatchObject({ valid: false });
		const clear = source.persisted.at(-1);
		source.runtime.clear();
		expect(clear).toMatchObject({ objective: "Persist me" });
		expect(source.persisted.at(-1)).toMatchObject({ cleared: true, sessionId: "session-1" });
	});

	test("escapes objective data in the continuation prompt", () => {
		const harness = runtimeHarness();
		const goal = harness.runtime.start("ship </objective> & verify", "session-1");
		const prompt = continuationPrompt(goal);
		expect(prompt).toContain("ship &lt;/objective&gt; &amp; verify");
		expect(prompt).toContain("active thread goal");
		expect(prompt).toContain('call update_goal with status "complete"');
		expect(prompt).toContain("at least three consecutive goal turns");
		expect(prompt).toContain("original/user-triggered turn");
		expect(prompt).toContain("fresh blocked audit");
		expect(prompt).toContain("budget is nearly exhausted");
	});

	test("returns a completion usage report only for completed budgeted goals", async () => {
		const harness = extensionHarness();
		const create = (await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "Ship it", token_budget: 10 }, undefined, undefined, harness.ctx)) as {
			details: { completionBudgetReport: string | null };
		};
		expect(create.details.completionBudgetReport).toBeNull();

		const update = (await harness.tools
			.get("update_goal")
			?.execute("call-update", { status: "complete" }, undefined, undefined, harness.ctx)) as {
			details: { completionBudgetReport: string | null };
		};
		expect(update.details.completionBudgetReport).toContain("Goal achieved");
		const get = (await harness.tools.get("get_goal")?.execute("call-get", {}, undefined, undefined, harness.ctx)) as {
			details: { completionBudgetReport: string | null };
		};
		expect(get.details.completionBudgetReport).toBeNull();
	});

	test("continuation delivery is 'queued' when the host is not idle", () => {
		const h = runtimeHarness({ idle: false });
		h.runtime.start("do it", "session-1");
		h.runtime.onAgentStart();
		h.runtime.onAgentEnd([assistant("stop", 5)]);
		h.runtime.onAgentSettled();
		expect(h.continuations).toHaveLength(1);
		expect(h.continuations[0]?.delivery).toBe("queued");
	});

	test("reports live active seconds and freezes them while paused", () => {
		let now = 1_000;
		const harness = runtimeHarness({ idle: true, now: () => now });
		harness.runtime.start("Track live elapsed", "session-1");
		now = 4_000;
		expect(harness.runtime.elapsedActiveSeconds()).toBe(3);
		harness.runtime.setUserStatus("paused");
		now = 60_000;
		// Paused goals freeze at the persisted counter; the pause span never counts.
		expect(harness.runtime.elapsedActiveSeconds()).toBe(3);
		harness.runtime.setUserStatus("active");
		now = 62_000;
		expect(harness.runtime.elapsedActiveSeconds()).toBe(5);
		expect(harness.runtime.get()?.timeUsedSeconds).toBe(3);
		harness.runtime.onAgentStart();
		now = 65_000;
		// During a participating run the readout follows the run baseline.
		expect(harness.runtime.elapsedActiveSeconds()).toBe(8);
	});

	test("a throwing continuation request does not crash and retries on the next completed run", () => {
		let throwOnce = true;
		const persisted: Array<StepGoalSnapshot | undefined> = [];
		const continuations: Array<{ goal: StepGoalRecord; delivery: "queued" | "immediate" }> = [];
		const runtime = new StepGoalRuntime({
			now: () => 1_000,
			idFactory: () => "goal-1",
			isIdle: () => true,
			hasPendingMessages: () => false,
			persist: (snapshot) => persisted.push(snapshot),
			requestContinuation: (continuation) => {
				if (throwOnce) {
					throwOnce = false;
					throw new Error("simulated delivery failure");
				}
				continuations.push(continuation);
			},
		});
		runtime.start("do it", "session-1");
		runtime.onAgentStart();
		runtime.onAgentEnd([assistant("stop", 5)]);
		runtime.onAgentSettled();
		// First settle: sendMessage threw, no continuation delivered, runtime stays alive.
		expect(continuations).toHaveLength(0);
		expect(runtime.get()?.status).toBe("active");
		// TODO(B1): there is no auto-retry trigger yet; a new agent cycle is
		// required to retry. This assertion pins the current behaviour so a
		// future retry-on-idle fix is a strict improvement.
		runtime.onAgentStart();
		runtime.onAgentEnd([assistant("stop", 3)]);
		runtime.onAgentSettled();
		expect(continuations).toHaveLength(1);
	});
});

interface ExtensionHarness {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	entries: Array<{ type: "custom"; customType: "step-goal"; data: unknown }>;
	handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>;
	ctx: ExtensionContext;
	setIdle: (value: boolean) => void;
}

function extensionHarness(options: { telemetry?: StepTelemetryReporter; idle?: boolean } = {}): ExtensionHarness {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const entries: Array<{ type: "custom"; customType: "step-goal"; data: unknown }> = [];
	let idle = options.idle ?? true;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace",
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: vi.fn(),
		ui: { notify: vi.fn(), input: vi.fn(async () => undefined), setStatus: vi.fn() },
		sessionManager: { getSessionId: () => "session-1", getEntries: () => entries, getBranch: () => entries },
	} as unknown as ExtensionContext;
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry(_type: string, data: unknown) {
			entries.push({ type: "custom", customType: "step-goal", data });
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	createStepGoalExtension({ telemetry: options.telemetry })(api);
	return {
		tools,
		commands,
		sent,
		entries,
		handlers,
		ctx,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

async function emit(harness: ExtensionHarness, event: string, payload: Record<string, unknown> = {}): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) await handler({ type: event, ...payload }, harness.ctx);
}

describe("Step goal extension", () => {
	test("registers only Codex goal tools and uses hidden native continuation", async () => {
		const harness = extensionHarness();
		expect([...harness.tools.keys()]).toEqual(["create_goal", "get_goal", "update_goal"]);
		expect(harness.handlers.has("message_end")).toBe(true);
		await emit(harness, "session_start");
		const result = (await harness.tools
			.get("create_goal")
			?.execute("call-1", { objective: "Run the tests", token_budget: 4 }, undefined, undefined, harness.ctx)) as {
			details: { goal: StepGoalRecord };
		};
		expect(result.details.goal).toMatchObject({ status: "active", objective: "Run the tests", tokenBudget: 4 });
		await emit(harness, "agent_start");
		await emit(harness, "agent_end", { messages: [assistant()] });
		await emit(harness, "agent_settled");
		expect(harness.sent[0]).toMatchObject({
			message: { customType: "step-goal", display: false },
			options: { triggerTurn: true },
		});
	});

	test("uses message_end as the token baseline when a tool creates a goal", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await emit(harness, "agent_start");
		const beforeGoal = assistant("toolUse", 20);
		await emit(harness, "message_end", { message: beforeGoal });
		await harness.tools
			.get("create_goal")
			?.execute("call-1", { objective: "Track only new work" }, undefined, undefined, harness.ctx);
		const afterGoal = assistant("stop", 7);
		await emit(harness, "message_end", { message: afterGoal });
		await emit(harness, "agent_end", { messages: [beforeGoal, afterGoal] });
		await emit(harness, "agent_settled");

		const result = (await harness.tools
			.get("get_goal")
			?.execute("call-2", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord } };
		expect(result.details.goal).toMatchObject({ tokensUsed: 7, iteration: 1 });
	});

	test("restores the newest valid session snapshot and clear marker", async () => {
		const source = runtimeHarness();
		const goal = source.runtime.start("Resume this goal", "session-1");
		const harness = extensionHarness();
		harness.entries.push({ type: "custom", customType: "step-goal", data: goal });
		source.runtime.clear();
		harness.entries.push({ type: "custom", customType: "step-goal", data: source.persisted.at(-1) });
		await emit(harness, "session_start");
		const result = (await harness.tools
			.get("get_goal")
			?.execute("call-1", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord | null } };
		expect(result.details.goal).toBeNull();
	});

	test("supports /goal status and disables cleanly", async () => {
		const harness = extensionHarness();
		await harness.commands.get("goal")?.("status", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("No goal is currently set.", "info");
		const disabled = { tools: new Map(), commands: new Map(), handlers: new Map() };
		const api = {
			registerTool: (tool: ToolDefinition) => disabled.tools.set(tool.name, tool),
			registerCommand: (name: string) => disabled.commands.set(name, true),
			on: (event: string) => disabled.handlers.set(event, true),
		} as unknown as ExtensionAPI;
		createStepGoalExtension({ enabled: false })(api);
		expect(disabled.tools.size).toBe(0);
		expect(disabled.commands.size).toBe(0);
	});

	test("accepts an inline objective for headless goal edits", async () => {
		const harness = extensionHarness();
		await harness.tools
			.get("create_goal")
			?.execute("call-1", { objective: "old objective" }, undefined, undefined, harness.ctx);
		await harness.commands.get("goal")?.("edit new objective", harness.ctx);
		const result = (await harness.tools
			.get("get_goal")
			?.execute("call-2", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord } };
		expect(result.details.goal.objective).toBe("new objective");
	});

	test("keeps objective text out of goal command telemetry", async () => {
		const track = vi.fn();
		const harness = extensionHarness({ telemetry: { track } });
		await harness.commands.get("goal")?.("customer-secret migration", harness.ctx);

		const goalCommand = track.mock.calls.find(([event]) => event === "goal_command_used");
		expect(goalCommand?.[1]).toEqual({ subcommand: "start" });
		expect(JSON.stringify(track.mock.calls)).not.toContain("customer-secret");
	});

	test("restoring an active snapshot at session_start fires exactly one continuation", async () => {
		const harness = extensionHarness();
		harness.entries.push({
			type: "custom",
			customType: "step-goal",
			data: {
				id: "goal-restored",
				sessionId: "session-1",
				objective: "resume overnight audit",
				status: "active",
				tokensUsed: 100,
				timeUsedSeconds: 60,
				createdAt: new Date(500).toISOString(),
				updatedAt: new Date(600).toISOString(),
				iteration: 3,
			},
		});
		await emit(harness, "session_start");
		const goalMessages = harness.sent.filter((m) => m.message.customType === "step-goal");
		expect(goalMessages).toHaveLength(1);
		expect(goalMessages[0]?.message).toMatchObject({ display: false });
		expect(goalMessages[0]?.message.details).toMatchObject({ goalId: "goal-restored", iteration: 3 });
	});

	test("restoring an over-budget snapshot persists budget_limited without a continuation", async () => {
		const harness = extensionHarness();
		harness.entries.push({
			type: "custom",
			customType: "step-goal",
			data: {
				id: "goal-overbudget",
				sessionId: "session-1",
				objective: "resume this",
				status: "active",
				tokenBudget: 50,
				tokensUsed: 100,
				timeUsedSeconds: 60,
				createdAt: new Date(500).toISOString(),
				updatedAt: new Date(600).toISOString(),
				iteration: 3,
			},
		});
		await emit(harness, "session_start");
		const goalMessages = harness.sent.filter((m) => m.message.customType === "step-goal");
		expect(goalMessages).toHaveLength(0);
		const latestGoalSnapshot = harness.entries
			.map((entry) => entry.data as Record<string, unknown>)
			.reverse()
			.find((data) => !("cleared" in data));
		expect(latestGoalSnapshot).toMatchObject({ id: "goal-overbudget", status: "budget_limited" });
	});

	test("goal creation lists the companion commands", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship the release", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining(
				"Goal commands: /goal status · /goal pause · /goal resume · /goal budget <tokens|none> · /goal clear",
			),
			"info",
		);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("step-goal", undefined);
	});

	test("pause explains how to resume", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship the release", harness.ctx);
		await harness.commands.get("goal")?.("pause", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Goal paused. Run /goal resume to continue.", "info");
	});

	test("formats status time with minute and hour units", async () => {
		const harness = extensionHarness();
		harness.entries.push({
			type: "custom",
			customType: "step-goal",
			data: {
				id: "goal-timed",
				sessionId: "session-1",
				objective: "time me",
				status: "paused",
				tokensUsed: 0,
				timeUsedSeconds: 3505,
				createdAt: new Date(500).toISOString(),
				updatedAt: new Date(600).toISOString(),
				iteration: 1,
			},
		});
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("status", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Time: 58m 25s"), "info");
	});

	test("starting over an unfinished goal points at the next commands", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("first objective", harness.ctx);
		await harness.commands.get("goal")?.("pause", harness.ctx);
		await harness.commands.get("goal")?.("second objective", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("An unfinished goal is already paused"),
			"warning",
		);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Run /goal resume to continue it"),
			"warning",
		);
		const result = (await harness.tools
			.get("get_goal")
			?.execute("call-1", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord } };
		expect(result.details.goal.objective).toBe("first objective");
	});

	test("an aborted run pauses the goal and tells the user how to resume", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship it", harness.ctx);
		await emit(harness, "agent_start");
		await emit(harness, "agent_end", { messages: [assistant("aborted")] });
		await emit(harness, "agent_settled");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Goal paused (run interrupted). Run /goal resume to continue.",
			"warning",
		);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("step-goal", expect.stringContaining("Goal: paused"));
	});

	test("hints once per pause that a plain message does not resume the goal", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship it", harness.ctx);
		await harness.commands.get("goal")?.("pause", harness.ctx);
		const notify = harness.ctx.ui.notify as ReturnType<typeof vi.fn>;
		notify.mockClear();
		await emit(harness, "input", { text: "继续", source: "interactive" });
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Run /goal resume to continue it, or /goal clear to end it."),
			"warning",
		);
		// Repeats within the same pause episode and slash commands stay silent.
		await emit(harness, "input", { text: "继续", source: "interactive" });
		await emit(harness, "input", { text: "/help", source: "interactive" });
		expect(notify).toHaveBeenCalledTimes(1);
		await harness.commands.get("goal")?.("resume", harness.ctx);
		notify.mockClear();
		await emit(harness, "input", { text: "继续", source: "interactive" });
		expect(notify).not.toHaveBeenCalled();
	});

	test("clear interrupts the current goal continuation after persisting its tombstone", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship it", harness.ctx);
		harness.setIdle(false);
		await emit(harness, "agent_start");
		vi.mocked(harness.ctx.abort).mockImplementation(() => {
			expect(harness.entries.at(-1)?.data).toMatchObject({ cleared: true });
		});

		await harness.commands.get("goal")?.("clear", harness.ctx);

		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("step-goal", undefined);
		await emit(harness, "agent_end", { messages: [assistant("aborted")] });
		harness.setIdle(true);
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(1);
		const result = (await harness.tools
			.get("get_goal")
			?.execute("call-get", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord | null } };
		expect(result.details.goal).toBeNull();
	});

	test("clear interrupts a turn that created its goal before any continuation", async () => {
		const harness = extensionHarness({ idle: false });
		await emit(harness, "session_start");
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "mid-run goal" }, undefined, undefined, harness.ctx);

		await harness.commands.get("goal")?.("clear", harness.ctx);

		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		await emit(harness, "agent_end", { messages: [assistant("aborted")] });
		harness.setIdle(true);
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(0);
	});

	test("clear leaves an idle session idle", async () => {
		const harness = extensionHarness();
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "idle goal" }, undefined, undefined, harness.ctx);
		await harness.commands.get("goal")?.("clear", harness.ctx);
		expect(harness.ctx.abort).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Goal cleared.", "info");
		expect(harness.entries.at(-1)?.data).toMatchObject({ cleared: true });
	});

	test("clear does not interrupt a busy session without a goal", async () => {
		const harness = extensionHarness({ idle: false });
		await emit(harness, "agent_start");
		await harness.commands.get("goal")?.("clear", harness.ctx);
		expect(harness.ctx.abort).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("No goal is currently set.", "info");
	});

	test("clear reports a persistence failure without interrupting the run", async () => {
		const harness = extensionHarness({ idle: false });
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "persist me" }, undefined, undefined, harness.ctx);
		const persist = vi.spyOn(harness.entries, "push").mockImplementation(() => {
			throw new Error("disk full");
		});
		try {
			await harness.commands.get("goal")?.("clear", harness.ctx);
			expect(harness.ctx.abort).not.toHaveBeenCalled();
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Unable to clear goal state.", "warning");
			const result = (await harness.tools
				.get("get_goal")
				?.execute("call-get", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord } };
			expect(result.details.goal.objective).toBe("persist me");
		} finally {
			persist.mockRestore();
		}
	});

	test("clear preserves the goal when accounting succeeds but the tombstone cannot persist", async () => {
		const harness = extensionHarness({ idle: false });
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "persist me" }, undefined, undefined, harness.ctx);
		const persist = vi.spyOn(harness.entries, "push").mockImplementation((...entries) => {
			if (entries.some((entry) => entry.data && typeof entry.data === "object" && "cleared" in entry.data))
				throw new Error("disk full");
			return Array.prototype.push.apply(harness.entries, entries);
		});
		try {
			await harness.commands.get("goal")?.("clear", harness.ctx);
			expect(harness.ctx.abort).not.toHaveBeenCalled();
			expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Unable to clear goal state.", "warning");
			const result = (await harness.tools
				.get("get_goal")
				?.execute("call-get", {}, undefined, undefined, harness.ctx)) as { details: { goal: StepGoalRecord } };
			expect(result.details.goal.objective).toBe("persist me");
		} finally {
			persist.mockRestore();
		}
	});

	test("clear reports an unavailable abort hook while keeping the goal cleared", async () => {
		const harness = extensionHarness({ idle: false });
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "stop me" }, undefined, undefined, harness.ctx);
		vi.mocked(harness.ctx.abort).mockImplementation(() => {
			throw new Error("abort unavailable");
		});
		await harness.commands.get("goal")?.("clear", harness.ctx);
		expect(harness.entries.at(-1)?.data).toMatchObject({ cleared: true });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("step-goal", undefined);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Goal cleared, but the current run could not be interrupted. Press Escape to stop it.",
			"warning",
		);
	});

	test("stops a queued goal continuation that starts after clear", async () => {
		const harness = extensionHarness({ idle: false });
		await emit(harness, "session_start");
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-create", { objective: "queued goal" }, undefined, undefined, harness.ctx);
		await emit(harness, "agent_end", { messages: [assistant()] });
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.options).toMatchObject({ deliverAs: "followUp" });
		harness.setIdle(true);
		await harness.commands.get("goal")?.("clear", harness.ctx);
		expect(harness.ctx.abort).not.toHaveBeenCalled();
		harness.setIdle(false);
		await emit(harness, "agent_start");
		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Stopped a queued goal turn (no goal is set).", "info");
		await emit(harness, "agent_end", { messages: [assistant("aborted")] });
		harness.setIdle(true);
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(1);
	});

	test("pause interrupts an in-flight goal continuation turn", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")?.("ship it", harness.ctx);
		await emit(harness, "agent_start");
		await harness.commands.get("goal")?.("pause", harness.ctx);
		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Goal paused; interrupted the in-flight goal turn. Run /goal resume to continue.",
			"info",
		);
	});

	test("pause does not interrupt a user-initiated turn", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-1", { objective: "mid-run goal" }, undefined, undefined, harness.ctx);
		await harness.commands.get("goal")?.("pause", harness.ctx);
		expect(harness.ctx.abort).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Goal paused. Run /goal resume to continue.", "info");
	});

	test("stops a queued goal continuation that starts after pause", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await emit(harness, "agent_start");
		await harness.tools
			.get("create_goal")
			?.execute("call-1", { objective: "grind" }, undefined, undefined, harness.ctx);
		harness.setIdle(false);
		await emit(harness, "agent_end", { messages: [assistant()] });
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.options).toMatchObject({ deliverAs: "followUp" });
		await harness.commands.get("goal")?.("pause", harness.ctx);
		expect(harness.ctx.abort).not.toHaveBeenCalled();
		await emit(harness, "agent_start");
		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Stopped a queued goal turn (goal is paused). Run /goal resume to continue it.",
			"info",
		);
	});
});

describe("Goal UX guidance (T1-T6)", () => {
	test("start, pause, and paused-input messages carry next-step pointers", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")!("finish the migration", harness.ctx);
		// Not "last": goal creation now follows the echo with the commands hint.
		expect(vi.mocked(harness.ctx.ui.notify)).toHaveBeenCalledWith(
			expect.stringContaining("Goal set:"),
			"info",
			expect.anything(),
		);

		await harness.commands.get("goal")!("pause", harness.ctx);
		expect(vi.mocked(harness.ctx.ui.notify)).toHaveBeenLastCalledWith(
			"Goal paused. Run /goal resume to continue.",
			"info",
		);
		expect(vi.mocked(harness.ctx.ui.setStatus)).toHaveBeenLastCalledWith("step-goal", "Goal: paused");

		// Ordinary prompts while paused get a recovery pointer (T4).
		await emit(harness, "input", { text: "继续", source: "interactive" });
		expect(vi.mocked(harness.ctx.ui.notify)).toHaveBeenLastCalledWith(
			expect.stringContaining("/goal resume to continue"),
			"warning",
		);

		await harness.commands.get("goal")!("resume", harness.ctx);
		expect(vi.mocked(harness.ctx.ui.notify)).toHaveBeenLastCalledWith("Goal resumed.", "info");
	});

	test("footer stays quiet while a goal is active", async () => {
		const harness = extensionHarness();
		await emit(harness, "session_start");
		await harness.commands.get("goal")!("finish the migration", harness.ctx);
		// Active goals leave the footer alone; only a pause earns a slot.
		expect(vi.mocked(harness.ctx.ui.setStatus)).toHaveBeenLastCalledWith("step-goal", undefined);
	});

	test("starting over an unfinished goal points at resume/clear", async () => {
		const runtime = new StepGoalRuntime({
			now: () => 1_000,
			idFactory: () => "goal-1",
			isIdle: () => true,
			hasPendingMessages: () => false,
			persist: () => true,
			requestContinuation: () => {},
		});
		runtime.start("first", "session-1");
		runtime.setUserStatus("paused");
		expect(() => runtime.start("second", "session-1")).toThrowError(
			/\/goal resume to continue.*\/goal clear to end/s,
		);
	});
});

describe("Goal command reliability", () => {
	test.each(["stop", "off", "reset", "none", "cancel"])(
		"/goal %s clears and stops the current goal",
		async (alias) => {
			const harness = extensionHarness();
			await harness.commands.get("goal")!("finish the audit", harness.ctx);
			harness.setIdle(false);
			await emit(harness, "agent_start");
			await harness.commands.get("goal")!(alias, harness.ctx);
			expect(harness.entries.at(-1)?.data).toMatchObject({ cleared: true });
			expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
			await emit(harness, "agent_end", { messages: [assistant("aborted")] });
			harness.setIdle(true);
			await emit(harness, "agent_settled");
			expect(harness.sent).toHaveLength(1);
		},
	);

	test("clear aliases without a goal do not create a new goal", async () => {
		const harness = extensionHarness();
		await harness.commands.get("goal")!("off", harness.ctx);
		expect(harness.entries).toEqual([]);
		expect(harness.sent).toEqual([]);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("No goal is currently set.", "info");
	});

	test("an objective starting with a clear alias still starts a goal", async () => {
		const harness = extensionHarness();
		await harness.commands.get("goal")!("stop flaky tests from failing", harness.ctx);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			objective: "stop flaky tests from failing",
			status: "active",
		});
	});

	test("pause reports a failed interruption while keeping the goal paused", async () => {
		const harness = extensionHarness();
		await harness.commands.get("goal")!("finish the audit", harness.ctx);
		await emit(harness, "agent_start");
		vi.mocked(harness.ctx.abort).mockImplementation(() => {
			throw new Error("abort unavailable");
		});
		await harness.commands.get("goal")!("pause", harness.ctx);
		expect(harness.entries.at(-1)?.data).toMatchObject({ status: "paused" });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("step-goal", "Goal: paused");
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
			"Goal paused, but the current run could not be interrupted. Press Escape to stop it.",
			"warning",
		);
	});

	test.each(["20", "none"])(
		"/goal budget %s lets a budget-limited goal resume without losing progress",
		async (amount) => {
			const harness = extensionHarness();
			await harness.tools
				.get("create_goal")!
				.execute("create", { objective: "finish the audit", token_budget: 10 }, undefined, undefined, harness.ctx);
			await emit(harness, "agent_start");
			await emit(harness, "agent_end", { messages: [assistant("stop", 10)] });
			await emit(harness, "agent_settled");
			expect(harness.entries.at(-1)?.data).toMatchObject({ status: "budget_limited" });

			await harness.commands.get("goal")!(`budget ${amount}`, harness.ctx);
			const updated = harness.entries.at(-1)?.data as StepGoalRecord;
			expect(updated).toMatchObject({ status: "paused", tokensUsed: 10, iteration: 1 });
			if (amount === "none") expect(updated).not.toHaveProperty("tokenBudget");
			else expect(updated.tokenBudget).toBe(20);
			expect(harness.sent).toEqual([]);
			await harness.commands.get("goal")!("resume", harness.ctx);
			expect(harness.sent).toHaveLength(1);
			expect(harness.sent[0]?.message.content).toContain("Tokens used: 10");
		},
	);

	test("a budget update that cannot persist leaves the previous limit authoritative", async () => {
		const harness = extensionHarness();
		await harness.tools
			.get("create_goal")!
			.execute("create", { objective: "persist budget", token_budget: 10 }, undefined, undefined, harness.ctx);
		const persist = vi.spyOn(harness.entries, "push").mockImplementation(() => {
			throw new Error("disk full");
		});
		try {
			await harness.commands.get("goal")!("budget 20", harness.ctx);
			expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith("Unable to persist goal state", "warning");
			const current = await harness.tools.get("get_goal")!.execute("get", {}, undefined, undefined, harness.ctx);
			expect(current.details).toMatchObject({ goal: { tokenBudget: 10 } });
		} finally {
			persist.mockRestore();
		}
	});

	test("unbounded status still reports token spend", async () => {
		const harness = extensionHarness();
		await harness.tools
			.get("create_goal")!
			.execute("create", { objective: "track spend" }, undefined, undefined, harness.ctx);
		await emit(harness, "agent_start");
		await emit(harness, "agent_end", { messages: [assistant("stop", 123)] });
		await emit(harness, "agent_settled");
		await harness.commands.get("goal")!("status", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("Tokens: 123 (unbounded)"),
			"info",
		);
	});
});

describe("goal budget boundaries", () => {
	test.each(["0", "-1", "1.5", "1e3", "9007199254740992", "20 extra"])(
		"rejects budget %s without changing the goal",
		async (amount) => {
			const harness = extensionHarness();
			await harness.tools
				.get("create_goal")!
				.execute(
					"create",
					{ objective: "keep the original budget", token_budget: 10 },
					undefined,
					undefined,
					harness.ctx,
				);
			await harness.commands.get("goal")!(`budget ${amount}`, harness.ctx);
			const current = await harness.tools.get("get_goal")!.execute("get", {}, undefined, undefined, harness.ctx);
			expect(current.details).toMatchObject({ goal: { tokenBudget: 10, status: "active" } });
			expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
		},
	);

	test("lowering a budget accounts current usage and interrupts a goal continuation", async () => {
		const harness = extensionHarness();
		await harness.commands.get("goal")!("finish the audit", harness.ctx);
		await emit(harness, "agent_start");
		await emit(harness, "message_end", { message: assistant("toolUse", 10) });
		await harness.commands.get("goal")!("budget 5", harness.ctx);
		expect(harness.entries.at(-1)?.data).toMatchObject({ tokenBudget: 5, tokensUsed: 10, status: "budget_limited" });
		expect(harness.ctx.abort).toHaveBeenCalledTimes(1);
		await emit(harness, "agent_end", { messages: [assistant("aborted")] });
		await emit(harness, "agent_settled");
		expect(harness.sent).toHaveLength(1);
	});

	test("an insufficient replacement budget stays limited and a completed goal stays complete", () => {
		const { runtime } = runtimeHarness({ idle: true });
		runtime.start("finish within budget", "session-1", 10);
		runtime.onAgentStart();
		runtime.onAgentEnd([assistant("stop", 10)]);
		runtime.onAgentSettled();
		expect(runtime.setTokenBudget(5)).toMatchObject({ status: "budget_limited", tokensUsed: 10 });
		expect(() => runtime.setUserStatus("active")).toThrow("/goal budget");
		runtime.update("complete");
		expect(runtime.setTokenBudget(null)).toMatchObject({ status: "complete", tokensUsed: 10 });
	});
});
