import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	type CronDelivery,
	CronFileStore,
	type CronJob,
	createStepCronExtension,
	SimpleCronExpression,
	StepCronRuntime,
} from "../src/extensions/step-cron.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "step-cron-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("SimpleCronExpression", () => {
	test("parses five-field steps and computes the next local minute", () => {
		const expression = SimpleCronExpression.parse("*/5 * * * *");
		const noon = new Date(2026, 0, 1, 12, 1, 30).getTime();
		const fivePast = new Date(2026, 0, 1, 12, 5).getTime();
		expect(expression.next(noon)).toBe(fivePast);
		const eight = new Date(2026, 0, 1, 8, 0).getTime();
		expect(SimpleCronExpression.parse("0 9 * * *").next(eight)).toBe(new Date(2026, 0, 1, 9, 0).getTime());
	});

	test("rejects six-field, malformed, and out-of-range expressions", () => {
		for (const expression of ["0 0 0 * * *", "*/0 * * * *", "61 * * * *", "foo * * * *"]) {
			expect(() => SimpleCronExpression.parse(expression)).toThrow();
		}
	});
});

describe("CronFileStore", () => {
	test("round-trips versioned JSONL records and skips malformed rows", () => {
		const directory = makeDirectory();
		const filePath = path.join(directory, ".step-cli", "cron", "tasks.json");
		mkdirSync(path.dirname(filePath), { recursive: true });
		const warnings: string[] = [];
		const store = new CronFileStore(filePath, { warn: (message) => warnings.push(message) });
		const job: CronJob = {
			schemaVersion: 1,
			id: "job-1",
			cron: "0 9 * * *",
			prompt: "audit",
			recurring: true,
			durable: true,
			createdAt: 1,
			nextFireAt: 2,
		};
		store.save([job]);
		const loaded = store.load();
		expect(loaded).toEqual([job]);
		for (const line of readFileSync(filePath, "utf8").trim().split("\n")) {
			expect(JSON.parse(line).schemaVersion).toBe(1);
		}
		// Append a bad row; valid state remains readable.
		const current = readFileSync(filePath, "utf8");
		writeFileSync(filePath, `${current}{"schemaVersion":99}\nnot-json\n`);
		expect(store.load()).toEqual([job]);
		expect(warnings).toHaveLength(2);
	});
});

describe("StepCronRuntime", () => {
	test("fires one-shot jobs once and advances recurring jobs", () => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		const oneShot = runtime.create("* * * * *", "one", false, false).job;
		const recurring = runtime.create("* * * * *", "repeat", true, false).job;
		now = Math.max(oneShot.nextFireAt, recurring.nextFireAt);
		runtime.tick();
		expect(deliveries).toHaveLength(2);
		expect(runtime.list().map((job) => job.id)).toEqual([recurring.id]);
		expect(runtime.list()[0]?.nextFireAt).toBeGreaterThan(now);
	});

	test("defers while busy and delivers at turn end", () => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		let idle = false;
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			isIdle: () => idle,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		runtime.create("* * * * *", "deferred", false, false);
		now += 60_000;
		runtime.tick();
		expect(deliveries).toHaveLength(0);
		idle = true;
		runtime.onTurnEnd();
		expect(deliveries).toHaveLength(1);
	});

	test("loads durable jobs and surfaces a missed one-shot after restart", () => {
		const directory = makeDirectory();
		const filePath = path.join(directory, ".step-cli", "cron", "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const first = new StepCronRuntime({ now: () => now, storagePath: filePath, jitterRatio: 0 });
		const created = first.create("* * * * *", "missed", false, true).job;
		expect(created.durable).toBe(true);
		first.stop();
		now = created.nextFireAt + 1;
		const deliveries: CronDelivery[] = [];
		const second = new StepCronRuntime({
			now: () => now,
			storagePath: filePath,
			jitterRatio: 0,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		second.start(directory, true);
		expect(deliveries).toEqual([{ kind: "missed", jobs: [expect.objectContaining({ id: created.id })] }]);
		expect(second.list()).toEqual([]);
		second.stop();
	});

	test("applies bounded jitter when enabled", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, random: () => 1, jitterRatio: 0.1 });
		const job = runtime.create("* * * * *", "jitter", false, false).job;
		expect(job.nextFireAt).toBeGreaterThanOrEqual(now + 60_000);
		expect(job.nextFireAt).toBeLessThanOrEqual(now + 66_000);
	});

	test("removes a recurring job at the seven-day expiry boundary", () => {
		let now = new Date(2026, 0, 1, 12, 0).getTime();
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		const job = runtime.create("* * * * *", "last check", true, false).job;
		now = job.createdAt + 7 * 24 * 60 * 60 * 1000 - 60_000;
		runtime.tick();
		now = job.createdAt + 7 * 24 * 60 * 60 * 1000;
		runtime.tick();
		expect(deliveries).toHaveLength(2);
		expect(runtime.list()).toEqual([]);
	});
});

interface Harness {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	ctx: ExtensionContext;
}

function createHarness(): Harness {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const ctx = {
		mode: "rpc",
		hasUI: false,
		cwd: makeDirectory(),
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "cron-session", getEntries: () => [] },
	} as unknown as ExtensionContext;
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			sent.push({ message, options });
		},
		sendUserMessage: () => {},
		appendEntry: () => {},
		getFlag: () => false,
	} as unknown as ExtensionAPI;
	return { api, tools, handlers, sent, ctx };
}

test("cron extension exposes three tools and steer delivery", async () => {
	vi.useFakeTimers();
	const harness = createHarness();
	createStepCronExtension({ enabled: true })(harness.api);
	expect([...harness.tools.keys()].sort()).toEqual(["cron_create", "cron_delete", "cron_list"]);
	for (const handler of harness.handlers.get("session_start") ?? [])
		await handler({ type: "session_start" } as never, harness.ctx);
	const create = harness.tools.get("cron_create")!;
	const result = (await create.execute(
		"create",
		{ cron: "* * * * *", prompt: "audit", recurring: false, durable: false } as never,
		undefined,
		undefined,
		harness.ctx,
	)) as { details: CronJob };
	expect(result.details.cron).toBe("* * * * *");
	vi.advanceTimersByTime(120_000);
	expect(harness.sent[0]).toMatchObject({
		message: { customType: "step-cron", content: "[cron] audit" },
		options: { deliverAs: "steer", triggerTurn: true },
	});
	for (const handler of harness.handlers.get("session_shutdown") ?? [])
		await handler({ type: "session_shutdown" } as never, harness.ctx);
});

test("durable creation is rejected in an untrusted project", async () => {
	const harness = createHarness();
	Object.assign(harness.ctx, { isProjectTrusted: () => false });
	createStepCronExtension({ enabled: true })(harness.api);
	await expect(
		harness.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "audit", durable: true } as never,
				undefined,
				undefined,
				harness.ctx,
			),
	).rejects.toThrow("trusted project");
});
