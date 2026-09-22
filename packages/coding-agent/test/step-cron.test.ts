import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "../src/features/step-cron.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
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
		const filePath = path.join(directory, ".stepcode", "cron", "tasks.json");
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
		const filePath = path.join(directory, ".stepcode", "cron", "tasks.json");
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
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	ctx: ExtensionContext;
}

function createHarness(): Harness {
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const ctx = {
		mode: "rpc",
		hasUI: false,
		cwd: makeDirectory(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => "cron-session", getEntries: () => [] },
	} as unknown as ExtensionContext;
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
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
	return { api, tools, handlers, sent, ctx, commands };
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

async function emitCron(harness: Harness, type: string): Promise<void> {
	for (const handler of harness.handlers.get(type) ?? []) await handler({ type } as never, harness.ctx);
}

describe("cron reliability", () => {
	test.each([
		"*/2junk * * * *",
		"*/1.5 * * * *",
		"*/1e2 * * * *",
		"*/ * * * *",
		"1-2-3 * * * *",
		"*/9007199254740992 * * * *",
	])("rejects the entire malformed expression %s", (expression) => {
		expect(() => SimpleCronExpression.parse(expression)).toThrow();
	});

	test("walks elapsed minutes through both occurrences of a repeated DST hour", () => {
		vi.stubEnv("TZ", "America/New_York");
		const beforeFallback = Date.parse("2026-11-01T01:59:30-04:00");
		expect(SimpleCronExpression.parse("* * * * *").next(beforeFallback)).toBe(
			Date.parse("2026-11-01T01:00:00-05:00"),
		);
		expect(SimpleCronExpression.parse("30 1 * * *").next(beforeFallback)).toBe(
			Date.parse("2026-11-01T01:30:00-05:00"),
		);
	});

	test("concurrent runtimes preserve each other's creates and deletes", () => {
		const filePath = path.join(makeDirectory(), "tasks.json");
		const first = new StepCronRuntime({ storagePath: filePath, jitterRatio: 0, idFactory: () => "first" });
		const second = new StepCronRuntime({ storagePath: filePath, jitterRatio: 0, idFactory: () => "second" });
		const left = first.create("* * * * *", "left", false, true).job;
		const right = second.create("* * * * *", "right", false, true).job;
		expect(
			new CronFileStore(filePath)
				.load()
				.map((job) => job.id)
				.sort(),
		).toEqual([left.id, right.id]);
		expect(first.delete(right.id)).toBe(true);
		expect(second.list().map((job) => job.id)).toEqual([left.id]);
		expect(second.delete(left.id)).toBe(true);
		expect(first.list()).toEqual([]);
	});

	test("two active runtimes dispatch a shared one-shot only once", () => {
		vi.useFakeTimers();
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const sendMessage = vi.fn();
		const first = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage });
		const second = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage });
		first.start(directory, true);
		const job = first.create("* * * * *", "shared reminder", false, true).job;
		second.start(directory, true);
		now = job.nextFireAt;
		first.tick();
		second.tick();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(new CronFileStore(storagePath).load()).toEqual([]);
		first.stop();
		second.stop();
	});

	test("preserves unknown and malformed rows during another durable creation", () => {
		const storagePath = path.join(makeDirectory(), "tasks.json");
		const unknown = '{"schemaVersion":99,"id":"future","payload":"retain"}\nnot-json\n';
		writeFileSync(storagePath, unknown);
		const warn = vi.fn();
		const runtime = new StepCronRuntime({ storagePath, jitterRatio: 0, warn });
		runtime.create("* * * * *", "new reminder", false, true);
		expect(readFileSync(storagePath, "utf8")).toContain(unknown);
		expect(new CronFileStore(storagePath, { warn }).load()).toHaveLength(1);
	});

	test("storage read errors do not masquerade as an empty schedule", () => {
		const store = new CronFileStore(makeDirectory());
		expect(() => store.load()).toThrow();
	});

	test("a failed durable create leaves no phantom job in memory", () => {
		const storagePath = path.join(makeDirectory(), "tasks.json");
		writeFileSync(`${storagePath}.lock`, "held");
		const runtime = new StepCronRuntime({ storagePath, jitterRatio: 0 });
		expect(() => runtime.create("* * * * *", "must persist", false, true)).toThrow("lock");
		expect(runtime.list()).toEqual([]);
	});

	test.each([false, true])("retries failed delivery without consuming a recurring=%s job", (recurring) => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const warn = vi.fn();
		const sendMessage = vi.fn().mockImplementationOnce(() => {
			throw new Error("queue unavailable");
		});
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0, sendMessage, warn });
		const job = runtime.create("* * * * *", "retry reminder", recurring).job;
		now = job.nextFireAt;
		runtime.tick();
		expect(runtime.list()).toEqual([job]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("queue unavailable"));
		runtime.tick();
		expect(sendMessage).toHaveBeenCalledTimes(2);
		if (recurring) expect(runtime.list()[0]?.nextFireAt).toBeGreaterThan(now);
		else expect(runtime.list()).toEqual([]);
	});

	test("retains missed one-shots on disk until their notice is delivered", () => {
		vi.useFakeTimers();
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const first = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		const job = first.create("* * * * *", "missed but recoverable", false, true).job;
		now = job.nextFireAt + 1;
		const sendMessage = vi.fn().mockImplementationOnce(() => {
			throw new Error("queue unavailable");
		});
		const resumed = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage, warn: vi.fn() });
		resumed.start(directory, true);
		expect(new CronFileStore(storagePath).load()).toEqual([job]);
		resumed.tick();
		expect(sendMessage).toHaveBeenLastCalledWith({ kind: "missed", jobs: [job] });
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(new CronFileStore(storagePath).load()).toEqual([]);
		resumed.stop();
	});

	test("loads all durable records before an expired job can dispatch", () => {
		vi.useFakeTimers();
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		const now = Date.UTC(2026, 0, 10, 12, 0);
		const expired: CronJob = {
			schemaVersion: 1,
			id: "expired",
			cron: "* * * * *",
			prompt: "last check",
			recurring: true,
			durable: true,
			createdAt: now - 8 * 86_400_000,
			nextFireAt: now - 60_000,
			autoExpireAt: now - 86_400_000,
		};
		const future: CronJob = {
			...expired,
			id: "future",
			recurring: false,
			nextFireAt: now + 60_000,
			autoExpireAt: undefined,
		};
		const store = new CronFileStore(storagePath);
		store.save([expired, future]);
		const resumed = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		resumed.start(directory, true);
		expect(store.load()).toEqual([future]);
		resumed.stop();
	});

	test("recurring jitter is stable and never early or greater than half an interval", () => {
		let now = new Date(2026, 0, 1, 12, 0, 30).getTime();
		const expression = SimpleCronExpression.parse("*/5 * * * *");
		const nominal = expression.next(now);
		const runtime = new StepCronRuntime({ now: () => now, idFactory: () => "stable-jitter" });
		const job = runtime.create("*/5 * * * *", "repeat").job;
		const offset = job.nextFireAt - nominal;
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(offset).toBeLessThanOrEqual(150_000);
		now = job.nextFireAt;
		runtime.tick();
		expect(runtime.list()[0]?.nextFireAt).toBe(expression.next(now) + offset);
	});

	test("distant recurring tasks have at most thirty minutes of positive jitter", () => {
		const now = new Date(2026, 0, 1, 12, 0).getTime();
		const nominal = SimpleCronExpression.parse("0 9 1 12 *").next(now);
		const runtime = new StepCronRuntime({ now: () => now, idFactory: () => "distant-jitter" });
		const job = runtime.create("0 9 1 12 *", "annual").job;
		expect(job.nextFireAt).toBeGreaterThanOrEqual(nominal);
		expect(job.nextFireAt).toBeLessThanOrEqual(nominal + 30 * 60_000);
	});

	test.each(["0", "30", "3"])("one-shot minute %s uses only the documented early jitter", (minute) => {
		const now = new Date(2026, 0, 1, 8, 0).getTime();
		const cron = `${minute} 9 * * *`;
		const nominal = SimpleCronExpression.parse(cron).next(now);
		const runtime = new StepCronRuntime({ now: () => now, idFactory: () => "oneshot-jitter" });
		const job = runtime.create(cron, "reminder", false).job;
		if (minute === "3") expect(job.nextFireAt).toBe(nominal);
		else {
			expect(job.nextFireAt).toBeLessThanOrEqual(nominal);
			expect(job.nextFireAt).toBeGreaterThanOrEqual(nominal - 90_000);
		}
	});

	test("a session without durable jobs never attaches storage or reads it per tick", () => {
		const directory = makeDirectory();
		const stores: CronFileStore[] = [];
		const runtime = new StepCronRuntime({
			storagePath: path.join(directory, "tasks.json"),
			jitterRatio: 0,
			storeFactory: (filePath) => {
				const store = new CronFileStore(filePath);
				stores.push(store);
				return store;
			},
		});
		runtime.start(directory, true);
		runtime.create("* * * * *", "session only", true);
		for (let index = 0; index < 120; index++) runtime.tick();
		expect(stores).toEqual([]);
		expect(existsSync(path.join(directory, "tasks.json"))).toBe(false);
		runtime.stop();
	});

	test("a durable session re-reads the shared store on a bounded cadence", () => {
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const owner = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		owner.create("0 3 * * *", "nightly report", true, true);
		const store = new CronFileStore(storagePath);
		const load = vi.spyOn(store, "load");
		const reader = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, storeFactory: () => store });
		reader.start(directory, true);
		expect(reader.list()).toHaveLength(1);
		const afterStart = load.mock.calls.length;
		for (let index = 0; index < 20; index++) {
			now += 1_000;
			reader.tick();
		}
		expect(load.mock.calls.length).toBe(afterStart);
		now += 30_000;
		reader.tick();
		expect(load.mock.calls.length).toBe(afterStart + 1);
		reader.stop();
	});

	test("a durable job another runtime created later is still picked up", () => {
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const sendMessage = vi.fn();
		const reader = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage });
		reader.start(directory, true);
		const writer = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		const job = writer.create("* * * * *", "added by another session", false, true).job;
		// Past the bounded cross-process refresh cadence.
		now = job.nextFireAt + 30_000;
		reader.tick();
		expect(sendMessage).toHaveBeenCalledWith({ kind: "fire", job });
		reader.stop();
	});

	test("a busy host defers due jobs without touching the shared store", () => {
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const owner = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		const job = owner.create("* * * * *", "waits for the user", false, true).job;
		const store = new CronFileStore(storagePath);
		const update = vi.spyOn(store, "update");
		const sendMessage = vi.fn();
		let idle = false;
		const busy = new StepCronRuntime({
			now: () => now,
			storagePath,
			jitterRatio: 0,
			storeFactory: () => store,
			isIdle: () => idle,
			sendMessage,
		});
		busy.start(directory, true);
		now = job.nextFireAt;
		for (let index = 0; index < 20; index++) busy.tick();
		expect(update).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		idle = true;
		busy.tick();
		expect(sendMessage).toHaveBeenCalledWith({ kind: "fire", job });
		busy.stop();
	});

	test("enforces a fifty-job limit without losing existing schedules", () => {
		const runtime = new StepCronRuntime({ jitterRatio: 0 });
		for (let index = 0; index < 50; index++) runtime.create("* * * * *", `reminder ${index}`, false);
		expect(() => runtime.create("* * * * *", "overflow", false)).toThrow("50");
		expect(runtime.list()).toHaveLength(50);
	});

	test("rechecks idle before each delivery, including missed notices", () => {
		vi.useFakeTimers();
		const directory = makeDirectory();
		const storagePath = path.join(directory, "tasks.json");
		let now = Date.UTC(2026, 0, 1, 12, 0);
		let idle = false;
		const first = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0 });
		const missed = first.create("* * * * *", "offline", false, true).job;
		now = missed.nextFireAt + 1;
		const sendMessage = vi.fn(() => {
			idle = false;
		});
		const resumed = new StepCronRuntime({
			now: () => now,
			storagePath,
			jitterRatio: 0,
			isIdle: () => idle,
			sendMessage,
		});
		resumed.start(directory, true);
		const live = resumed.create("* * * * *", "online", false).job;
		now = live.nextFireAt;
		idle = true;
		resumed.onTurnEnd();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		idle = true;
		resumed.onTurnEnd();
		expect(sendMessage).toHaveBeenCalledTimes(2);
		resumed.stop();
	});
});

test("cron waits for pending user input and drains at agent_settled", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
	const harness = createHarness();
	let pending = true;
	Object.assign(harness.ctx, { hasPendingMessages: () => pending });
	createStepCronExtension({ enabled: true })(harness.api);
	await emitCron(harness, "session_start");
	await harness.tools
		.get("cron_create")!
		.execute(
			"create",
			{ cron: "* * * * *", prompt: "user first", recurring: false },
			undefined,
			undefined,
			harness.ctx,
		);
	vi.advanceTimersByTime(60_000);
	expect(harness.sent).toEqual([]);
	pending = false;
	await emitCron(harness, "agent_settled");
	expect(harness.sent).toHaveLength(1);
	await emitCron(harness, "session_shutdown");
});

test("missed notices and /cron status include the original prompts", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
	const harness = createHarness();
	const first = new StepCronRuntime({
		now: () => Date.now() - 120_000,
		storagePath: path.join(harness.ctx.cwd, ".stepcode", "cron", "tasks.json"),
		jitterRatio: 0,
	});
	const missed = first.create("* * * * *", "check the failed deployment", false, true).job;
	createStepCronExtension({ enabled: true })(harness.api);
	await emitCron(harness, "session_start");
	expect(harness.sent[0]?.message.content).toContain(missed.prompt);
	expect(harness.sent[0]?.message.content).toContain(missed.id);
	await harness.tools
		.get("cron_create")!
		.execute(
			"create",
			{ cron: "* * * * *", prompt: "inspect queue", recurring: false },
			undefined,
			undefined,
			harness.ctx,
		);
	await harness.commands.get("cron")!("", harness.ctx);
	expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("inspect queue"), "info");
	await emitCron(harness, "session_shutdown");
});

test("the storage lock covers dispatch as well as the final write", () => {
	vi.useFakeTimers();
	const directory = makeDirectory();
	const storagePath = path.join(directory, "tasks.json");
	let now = Date.UTC(2026, 0, 1, 12, 0);
	const otherDelivery = vi.fn();
	const otherWarning = vi.fn();
	const other = new StepCronRuntime({
		now: () => now,
		storagePath,
		jitterRatio: 0,
		sendMessage: otherDelivery,
		warn: otherWarning,
	});
	const delivery = vi.fn(() => other.tick());
	const first = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage: delivery });
	first.start(directory, true);
	const job = first.create("* * * * *", "only one dispatcher", false, true).job;
	other.start(directory, true);
	now = job.nextFireAt;
	first.tick();
	other.tick();
	expect(delivery).toHaveBeenCalledTimes(1);
	expect(otherDelivery).not.toHaveBeenCalled();
	expect(otherWarning).toHaveBeenCalledWith(expect.stringContaining("lock"));
	first.stop();
	other.stop();
});

test("a failed transaction rolls back a session job alongside shared durable state", () => {
	const storagePath = path.join(makeDirectory(), "tasks.json");
	const store = new CronFileStore(storagePath);
	const runtime = new StepCronRuntime({ storagePath, storeFactory: () => store, jitterRatio: 0 });
	const existing = runtime.create("* * * * *", "persisted", false, true).job;
	const update = vi.spyOn(store, "update").mockImplementationOnce((mutate) => {
		mutate(store.load());
		throw new Error("disk full");
	});
	expect(() => runtime.create("* * * * *", "must roll back", false)).toThrow("disk full");
	update.mockRestore();
	expect(runtime.list()).toEqual([existing]);
	expect(store.load()).toEqual([existing]);
});

test("rejects an oversized prompt without silently truncating the instruction", () => {
	const runtime = new StepCronRuntime({ jitterRatio: 0 });
	expect(() => runtime.create("* * * * *", "x".repeat(16_001))).toThrow("exceeds");
	expect(runtime.list()).toEqual([]);
});

test("an unschedulable persisted recurrence does not block other jobs on restart", () => {
	vi.useFakeTimers();
	const directory = makeDirectory();
	const storagePath = path.join(directory, "tasks.json");
	let now = Date.UTC(2026, 0, 1, 12, 0);
	const unschedulable: CronJob = {
		schemaVersion: 1,
		id: "unschedulable",
		cron: "0 0 31 2 *",
		prompt: "invalid calendar date",
		recurring: true,
		durable: true,
		createdAt: now - 120_000,
		nextFireAt: now - 60_000,
		autoExpireAt: now + 86_400_000,
	};
	const missed: CronJob = {
		...unschedulable,
		id: "missed",
		cron: "* * * * *",
		prompt: "recover this reminder",
		recurring: false,
	};
	const future: CronJob = { ...missed, id: "future", nextFireAt: now + 60_000 };
	const store = new CronFileStore(storagePath);
	store.save([unschedulable, missed, future]);
	const sendMessage = vi.fn();
	const warn = vi.fn();
	const runtime = new StepCronRuntime({ now: () => now, storagePath, jitterRatio: 0, sendMessage, warn });
	try {
		runtime.start(directory, true);
		expect(sendMessage).toHaveBeenCalledWith({ kind: "missed", jobs: [missed] });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("unschedulable"));
		expect(store.load()).toEqual([unschedulable, future]);
		now = future.nextFireAt;
		runtime.tick();
		expect(sendMessage).toHaveBeenLastCalledWith({ kind: "fire", job: future });
		expect(store.load()).toEqual([unschedulable]);
	} finally {
		runtime.stop();
	}
});
