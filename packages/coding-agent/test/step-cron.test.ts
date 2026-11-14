import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	CRON_MAX_PROMPT_LENGTH,
	CRON_MAX_TITLE_LENGTH,
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
	/** The session id `ctx.sessionManager.getSessionId()` reports; reassign to act as another session. */
	session: { id: string; file: string | undefined };
}

function createHarness(): Harness {
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	// A task records the absolute path of its session file, so the harness has to
	// report one; `undefined` models `--no-session`.
	const session: { id: string; file: string | undefined } = {
		id: "cron-session",
		file: path.join(makeDirectory(), "cron-session.jsonl"),
	};
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: makeDirectory(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		hasPendingUserDecision: () => false,
		isProjectTrusted: () => true,
		ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
		sessionManager: {
			getSessionId: () => session.id,
			getSessionFile: () => session.file,
			getEntries: () => [],
		},
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
	return { api, tools, handlers, sent, ctx, commands, session };
}

test("cron extension exposes create/list/update/delete and steer delivery", async () => {
	vi.useFakeTimers();
	const harness = createHarness();
	createStepCronExtension({ enabled: true, allowUpdate: true })(harness.api);
	expect([...harness.tools.keys()].sort()).toEqual(["cron_create", "cron_delete", "cron_list", "cron_update"]);
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

test("a task session cannot create, update, or delete cron jobs", async () => {
	const harness = createHarness();
	createStepCronExtension({ enabled: true, readOnly: true, allowUpdate: true })(harness.api);
	await emitCron(harness, "session_start");
	const create = harness.tools.get("cron_create")!;
	await expect(
		create.execute("create", { cron: "* * * * *", prompt: "nested" } as never, undefined, undefined, harness.ctx),
	).rejects.toThrow("cannot create");
	await expect(
		harness.tools
			.get("cron_update")!
			.execute("update", { id: "x", title: "y" } as never, undefined, undefined, harness.ctx),
	).rejects.toThrow("cannot update");
	await expect(
		harness.tools.get("cron_delete")!.execute("delete", { id: "x" } as never, undefined, undefined, harness.ctx),
	).rejects.toThrow("cannot delete");
	const listed = (await harness.tools
		.get("cron_list")!
		.execute("list", {} as never, undefined, undefined, harness.ctx)) as { content: Array<{ text: string }> };
	expect(JSON.parse(listed.content[0]!.text)).toEqual([]);
	await emitCron(harness, "session_shutdown");
});

test("the CLI cron extension keeps its original tool surface", () => {
	const harness = createHarness();
	createStepCronExtension({ enabled: true })(harness.api);
	expect([...harness.tools.keys()].sort()).toEqual(["cron_create", "cron_delete", "cron_list"]);
});

test("the approval gate is a host choice, and a host that asks gets one dialog per change", async () => {
	// The CLI host does not pass `requireApproval`: scheduling work is its own
	// user-driven command surface, and a print / RPC session has no page to show
	// a dialog on. A host that opts in does.
	const cli = createHarness();
	createStepCronExtension({ enabled: true })(cli.api);
	await emitCron(cli, "session_start");
	const cliConfirm = cli.ctx.ui.confirm as ReturnType<typeof vi.fn>;
	await cli.tools
		.get("cron_create")!
		.execute("create", { cron: "* * * * *", prompt: "no gate here" } as never, undefined, undefined, cli.ctx);
	expect(cliConfirm).not.toHaveBeenCalled();
	await emitCron(cli, "session_shutdown");

	const desktop = createHarness();
	createStepCronExtension({ enabled: true, requireApproval: true })(desktop.api);
	await emitCron(desktop, "session_start");
	const confirm = desktop.ctx.ui.confirm as ReturnType<typeof vi.fn>;
	confirm.mockResolvedValueOnce(false);
	await expect(
		desktop.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "needs approval" } as never,
				undefined,
				undefined,
				desktop.ctx,
			),
	).rejects.toThrow("not approved");
	// The dialog is per scheduled task, never part of a session-wide grant.
	expect(confirm.mock.calls[0]?.[2]).toMatchObject({ once: true });
	await emitCron(desktop, "session_shutdown");
});

test("a host without a dialog surface refuses rather than silently scheduling", async () => {
	const harness = createHarness();
	Object.assign(harness.ctx, { hasUI: false });
	createStepCronExtension({ enabled: true, requireApproval: true })(harness.api);
	await expect(
		harness.tools
			.get("cron_create")!
			.execute("create", { cron: "* * * * *", prompt: "no dialog" } as never, undefined, undefined, harness.ctx),
	).rejects.toThrow("no dialog surface");
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

test("a due job stays due while a decision is pending", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
	const harness = createHarness();
	let awaitingDecision = true;
	Object.assign(harness.ctx, { hasPendingUserDecision: () => awaitingDecision });
	createStepCronExtension({ enabled: true })(harness.api);
	await emitCron(harness, "session_start");
	await harness.tools
		.get("cron_create")!
		.execute("create", { cron: "* * * * *", prompt: "audit", recurring: false }, undefined, undefined, harness.ctx);
	vi.advanceTimersByTime(60_000);
	await emitCron(harness, "agent_settled");
	// Deferred, not consumed: firing it would replay work the user may reject.
	expect(harness.sent).toEqual([]);
	expect(harness.tools.get("cron_create")).toBeDefined();
	const listed = (await harness.tools
		.get("cron_list")!
		.execute("list", {} as never, undefined, undefined, harness.ctx)) as { content: Array<{ text: string }> };
	expect(JSON.parse(listed.content[0]!.text)).toHaveLength(1);

	// The decision is answered: the one-shot job still fires and then leaves.
	awaitingDecision = false;
	vi.advanceTimersByTime(60_000);
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
	// Bound to this session, as every task the CLI creates now is: a record with no
	// session id is not claimed by any session and would never be reported.
	const missed = first.create("* * * * *", "check the failed deployment", false, true, true, {
		sessionId: harness.session.id,
	}).job;
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

describe("desktop cron task fields", () => {
	test("a task created paused for a missing session keeps its reason", () => {
		// The record reader validates `statusReason`, so a host that creates a task
		// already paused (an imported task whose session is gone) must have the
		// reason written on creation, not only through a later update.
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const directory = makeDirectory();
		const file = path.join(directory, "tasks.json");
		const first = new StepCronRuntime({ now: () => now, jitterRatio: 0, storagePath: file });
		const created = first.create("0 9 * * *", "orphaned task", true, true, true, {
			id: "orphan",
			sessionId: "session-gone",
			status: "paused",
			statusReason: "session_missing",
			origin: "desktop",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(created.statusReason).toBe("session_missing");

		const reloaded = new StepCronRuntime({ now: () => now, jitterRatio: 0, storagePath: file });
		reloaded.start(directory, true);
		const record = reloaded.list().find((job) => job.id === "orphan");
		expect(record?.statusReason).toBe("session_missing");
		expect(record?.status).toBe("paused");
	});

	test("creates a v2 task with task session metadata and updates it", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const directory = makeDirectory();
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			storagePath: path.join(directory, "tasks.json"),
		});
		const created = runtime.create("0 9 * * *", "desktop task", true, true, true, {
			workspace: directory,
			sessionId: "cron-task-1",
			status: "enabled",
			title: "Task",
			inputs: { skills: ["skill-a"] },
			permissionPreset: "full-access",
			fullAccessAcknowledged: true,
			autoExpireMs: null,
			jitter: false,
			origin: "desktop",
		}).job;
		expect(created.schemaVersion).toBe(2);
		expect(created.sessionId).toBe("cron-task-1");
		expect(created.status).toBe("enabled");
		expect(created.fullAccessAcknowledged).toBe(true);
		expect(created.autoExpireAt).toBeUndefined();
		const updated = runtime.update(created.id, {
			title: "Task 2",
			inputs: { skills: ["skill-b"] },
			status: "paused",
		});
		expect(updated.title).toBe("Task 2");
		expect(updated.inputs?.skills).toEqual(["skill-b"]);
		expect(updated.status).toBe("paused");
		expect(runtime.setEnabled(created.id, true)).toBe(true);
		expect(runtime.list()[0]?.status).toBe("enabled");
	});

	test("runNow hands off without advancing the schedule or completing a one-shot", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		const job = runtime.create("0 9 * * *", "manual", false, false, true, {
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		const next = job.nextFireAt;
		runtime.runNow(job.id);
		expect(deliveries).toHaveLength(1);
		expect(runtime.list()[0]?.nextFireAt).toBe(next);
		expect(runtime.list()[0]?.status).toBe("enabled");
	});

	test("accepts a caller-provided id and a bound session", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		const job = runtime.create("0 9 * * *", "named", true, false, true, {
			id: "task-a",
			sessionId: "session-a",
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(job.id).toBe("task-a");
		expect(runtime.list()[0]?.sessionId).toBe("session-a");
		expect(() =>
			runtime.create("0 9 * * *", "duplicate", true, false, true, {
				id: "task-a",
				status: "enabled",
				autoExpireMs: null,
				jitter: false,
			}),
		).toThrow(/already exists/);
	});

	test("full access requires an explicit acknowledgment on create and update", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		expect(() =>
			runtime.create("* * * * *", "unsafe", true, false, true, {
				permissionPreset: "full-access",
			}),
		).toThrow(/risk acknowledgment/);
		const created = runtime.create("* * * * *", "safe", true, false, true, {
			permissionPreset: "full-access",
			fullAccessAcknowledged: true,
		}).job;
		expect(() => runtime.update(created.id, { fullAccessAcknowledged: false })).toThrow(/risk acknowledgment/);
	});

	test("one-shot and repeating schedules cannot leak into each other", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		const runAt = now + 2 * 60 * 60 * 1000;
		const once = runtime.create("0 9 * * *", "once", false, false, true, {
			runAt,
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(once.runAt).toBe(runAt);
		expect(once.nextFireAt).toBe(runAt);

		// `once -> daily`: the old absolute time must not decide the next fire.
		const daily = runtime.update(once.id, { recurring: true, cron: "0 9 * * *" });
		expect(daily.recurring).toBe(true);
		expect(daily.runAt).toBeUndefined();
		expect(daily.nextFireAt).toBe(SimpleCronExpression.parse("0 9 * * *").next(now));

		// …and back: `daily -> once` carries an explicit time.
		const backToOnce = runtime.update(once.id, { recurring: false, runAt: now + 60 * 60 * 1000 });
		expect(backToOnce.intervalHours).toBeUndefined();
		expect(backToOnce.nextFireAt).toBe(now + 60 * 60 * 1000);

		// A repeating task cannot take a one-shot time.
		expect(() =>
			runtime.update(once.id, {
				recurring: true,
				runAt: now + 60 * 60 * 1000,
			}),
		).toThrow(/one-shot/);
	});

	test("a one-shot time must be in the future on create and update", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		expect(() =>
			runtime.create("0 9 * * *", "past", false, false, true, {
				runAt: now - 60_000,
				status: "enabled",
				autoExpireMs: null,
				jitter: false,
			}),
		).toThrow(/future/);
		expect(() =>
			runtime.create("0 9 * * *", "nan", false, false, true, {
				runAt: Number.NaN,
				status: "enabled",
				autoExpireMs: null,
				jitter: false,
			}),
		).toThrow(/finite/);
		const once = runtime.create("0 9 * * *", "ok", false, false, true, {
			runAt: now + 60_000,
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(() => runtime.update(once.id, { runAt: now - 1 })).toThrow(/future/);
		expect(() => runtime.update(once.id, { runAt: Number.POSITIVE_INFINITY })).toThrow(/finite/);
		expect(() => runtime.update(once.id, { expiresAt: Number.NaN })).toThrow(/finite/);
	});

	test("editing an expiry or a one-shot time reopens a finished task", () => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		const expired = runtime.create("0 9 * * *", "expiring", true, false, true, {
			status: "expired",
			expiresAt: now - 60_000,
			autoExpireMs: null,
			jitter: false,
		}).job;
		const renewed = runtime.update(expired.id, { expiresAt: now + 24 * 60 * 60 * 1000 });
		expect(renewed.status).toBe("enabled");
		expect(renewed.enabled).toBe(true);

		const completed = runtime.create("0 9 * * *", "done", false, false, true, {
			runAt: now + 60_000,
			status: "completed",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(runtime.update(completed.id, { runAt: now + 60 * 60 * 1000 }).status).toBe("enabled");

		// An edit that does not restore a future schedule must not reopen it.
		const stillExpired = runtime.update(expired.id, { status: "expired" });
		expect(runtime.update(stillExpired.id, { title: "renamed" }).status).toBe("expired");

		// Re-enabling a one-shot whose time already passed would fire it at once on
		// the next tick, so it needs a new time instead.
		const stale = runtime.create("0 9 * * *", "stale", false, false, true, {
			runAt: now + 60_000,
			status: "paused",
			autoExpireMs: null,
			jitter: false,
		}).job;
		now += 10 * 60_000;
		expect(() => runtime.update(stale.id, { status: "enabled" })).toThrow(/future time/);
		expect(runtime.update(stale.id, { status: "enabled", runAt: now + 60_000 }).status).toBe("enabled");
	});

	test("a host only sees and fires the records it owns", () => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			ownsJob: (job) => job.sessionId === undefined,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		const mine = runtime.create("* * * * *", "mine", false, false, true, {
			status: "enabled",
			// One-shot at the next tick, so the drain loop has real work to do.
			runAt: now + 60_000,
			autoExpireMs: null,
			jitter: false,
		}).job;
		const foreign = runtime.create("* * * * *", "desktop", true, false, true, {
			sessionId: "session-desktop",
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(runtime.list().map((job) => job.id)).toEqual([mine.id]);
		expect(runtime.delete(foreign.id)).toBe(false);
		expect(() => runtime.runNow(foreign.id)).toThrow(/another host/);
		expect(() => runtime.update(foreign.id, { title: "hijack" })).toThrow(/another host/);
		now += 60_000;
		runtime.tick();
		expect(deliveries.map((delivery) => delivery.job?.id)).toEqual([mine.id]);
	});

	test("the kernel keeps generic ceilings the persisted reader shares", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		const created = runtime.create("0 9 * * *", "x", true, false, true, { status: "enabled" }).job;
		// 16,000 is the kernel ceiling; a host form may be stricter, but narrowing
		// this value would make an earlier record with a longer prompt unreadable.
		expect(CRON_MAX_PROMPT_LENGTH).toBe(16_000);
		expect(CRON_MAX_TITLE_LENGTH).toBe(200);
		expect(() => runtime.create("0 9 * * *", "y".repeat(CRON_MAX_PROMPT_LENGTH + 1), true, false, true)).toThrow(
			/exceeds 16000/,
		);
		expect(() => runtime.update(created.id, { prompt: "y".repeat(CRON_MAX_PROMPT_LENGTH + 1) })).toThrow(
			/exceeds 16000/,
		);
		// A title over the ceiling is truncated rather than rejected, as before.
		const longTitle = runtime.create("0 9 * * *", "z", true, false, true, {
			title: "t".repeat(CRON_MAX_TITLE_LENGTH + 10),
			status: "enabled",
		}).job;
		expect(longTitle.title?.length).toBe(CRON_MAX_TITLE_LENGTH);
	});

	test("supports explicit hour intervals and absolute one-shot times", () => {
		const now = Date.UTC(2026, 0, 1, 12, 0);
		const runtime = new StepCronRuntime({ now: () => now, jitterRatio: 0 });
		const interval = runtime.create("* * * * *", "interval", true, false, true, {
			intervalHours: 5,
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(interval.intervalHours).toBe(5);
		expect(interval.nextFireAt).toBe(now + 5 * 60 * 60 * 1000);
		const runAt = now + 2 * 60 * 60 * 1000;
		const once = runtime.create("* * * * *", "once", false, false, true, {
			runAt,
			status: "enabled",
			autoExpireMs: null,
			jitter: false,
		}).job;
		expect(once.nextFireAt).toBe(runAt);
	});

	test("canDeliver gates each job and maxJobs is configurable", () => {
		let now = Date.UTC(2026, 0, 1, 12, 0);
		let allow = false;
		const deliveries: CronDelivery[] = [];
		const runtime = new StepCronRuntime({
			now: () => now,
			jitterRatio: 0,
			maxJobs: 1,
			canDeliver: () => allow,
			sendMessage: (delivery) => deliveries.push(delivery),
		});
		runtime.create("* * * * *", "gated", false, false);
		expect(() => runtime.create("* * * * *", "second", false, false)).toThrow(/At most 1/);
		now += 60_000;
		runtime.tick();
		expect(deliveries).toHaveLength(0);
		allow = true;
		runtime.tick();
		expect(deliveries).toHaveLength(1);
	});
});

describe("a task belongs to the session that created it", () => {
	/** Two sessions sharing one project folder, which is what makes the file shared. */
	function twoSessionsInOneFolder() {
		const cwd = makeDirectory();
		const first = createHarness();
		Object.assign(first.ctx, { cwd });
		first.session.id = "session-first";
		const second = createHarness();
		Object.assign(second.ctx, { cwd });
		second.session.id = "session-second";
		return { first, second };
	}

	test("the record names the creating session", async () => {
		vi.useFakeTimers();
		const { first } = twoSessionsInOneFolder();
		createStepCronExtension({ enabled: true })(first.api);
		await emitCron(first, "session_start");
		const created = (await first.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "audit", durable: true } as never,
				undefined,
				undefined,
				first.ctx,
			)) as { details: CronJob };
		expect(created.details.sessionId).toBe("session-first");
		// The file is what a later start checks; recording only the id would leave
		// nothing to verify, and an id is not a location.
		expect(created.details.sessionFile).toBe(first.session.file);
		await emitCron(first, "session_shutdown");
	});

	test("a host with no session file records no file, and its tasks are not guessed at", async () => {
		// `--no-session` keeps the transcript in memory. There is no path to check,
		// so a later start must leave the record alone rather than call it missing.
		vi.useFakeTimers();
		const harness = createHarness();
		harness.session.file = undefined;
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const created = (await harness.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "no file", durable: true } as never,
				undefined,
				undefined,
				harness.ctx,
			)) as {
			details: CronJob;
		};
		expect(created.details.sessionId).toBe("cron-session");
		expect("sessionFile" in created.details).toBe(false);
		await emitCron(harness, "session_shutdown");
	});

	test("another session in the same folder neither lists nor fires it", async () => {
		// The defect: the record lived in the shared project folder with no
		// `sessionId`, so every session opened there claimed it and the job's prompt
		// fired into whichever terminal was active.
		vi.useFakeTimers();
		const { first, second } = twoSessionsInOneFolder();
		createStepCronExtension({ enabled: true })(first.api);
		await emitCron(first, "session_start");
		await first.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "audit", durable: true } as never,
				undefined,
				undefined,
				first.ctx,
			);
		await emitCron(first, "session_shutdown");

		createStepCronExtension({ enabled: true })(second.api);
		await emitCron(second, "session_start");
		const listed = (await second.tools
			.get("cron_list")!
			.execute("list", {} as never, undefined, undefined, second.ctx)) as {
			details: CronJob[];
		};
		expect(listed.details).toEqual([]);
		vi.advanceTimersByTime(120_000);
		expect(second.sent).toEqual([]);
		await emitCron(second, "session_shutdown");
	});

	test("the creating session still lists it after a restart", async () => {
		// `--resume` reads the id back from the session file's header, so the same
		// conversation reclaims its task; a restart is a new extension over the same
		// folder and the same session id.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const before = createHarness();
		Object.assign(before.ctx, { cwd });
		before.session.id = "session-a";
		createStepCronExtension({ enabled: true })(before.api);
		await emitCron(before, "session_start");
		await before.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "* * * * *", prompt: "audit", durable: true } as never,
				undefined,
				undefined,
				before.ctx,
			);
		await emitCron(before, "session_shutdown");

		const after = createHarness();
		Object.assign(after.ctx, { cwd });
		after.session.id = "session-a";
		createStepCronExtension({ enabled: true })(after.api);
		await emitCron(after, "session_start");
		const listed = (await after.tools
			.get("cron_list")!
			.execute("list", {} as never, undefined, undefined, after.ctx)) as {
			details: CronJob[];
		};
		expect(listed.details.map((job) => job.prompt)).toEqual(["audit"]);
		await emitCron(after, "session_shutdown");
	});

	test("session_start does not deliver another session's due task", async () => {
		// Startup recovery used to walk every durable record without consulting
		// ownership, so a task belonging to a session that had exited was delivered
		// into whichever session opened the folder next — the reported defect, on
		// the one path that runs before any tick.
		//
		// `autoExpireAt` is in the past on purpose: that is the branch that actually
		// fires. A record that has merely come due without expiring takes the
		// "advance and defer" path, which a version without the ownership check
		// would also leave silent — the test would pass either way.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		new CronFileStore(path.join(cwd, ".stepcode", "cron", "tasks.json")).save([
			{
				schemaVersion: 2,
				id: "theirs",
				cron: "* * * * *",
				prompt: "THEIR SECRET TASK",
				recurring: true,
				durable: true,
				createdAt: now - 120_000,
				nextFireAt: now - 60_000,
				autoExpireAt: now - 30_000,
				sessionId: "session-theirs",
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		expect(harness.sent).toEqual([]);
		// Untouched: its schedule is that session's to advance, not ours.
		const stored = new CronFileStore(path.join(cwd, ".stepcode", "cron", "tasks.json")).load();
		expect(stored[0]?.nextFireAt).toBe(now - 60_000);
		await emitCron(harness, "session_shutdown");
	});

	test("unowned records neither fill the create quota nor become undeletable", async () => {
		// Records written before tasks were bound have no owner. Counting them
		// blocked new tasks, and refusing to delete them left the reader with no way
		// to clear the ones in the way.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		new CronFileStore(file).save(
			Array.from({ length: 50 }, (_, index) => ({
				schemaVersion: 1 as const,
				id: `legacy-${index}`,
				cron: "0 9 * * *",
				prompt: `old ${index}`,
				recurring: true,
				durable: true,
				createdAt: now - 1_000,
				nextFireAt: now + 3_600_000,
			})),
		);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		// 50 unowned records must not fill the quota.
		const created = (await harness.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "0 10 * * *", prompt: "new", durable: true } as never,
				undefined,
				undefined,
				harness.ctx,
			)) as {
			details: CronJob;
		};
		expect(created.details.sessionId).toBe("session-mine");
		// A record no session owns can be removed, so it is not stranded.
		const deleted = (await harness.tools
			.get("cron_delete")!
			.execute("delete", { id: "legacy-0" } as never, undefined, undefined, harness.ctx)) as {
			details: { found: boolean };
		};
		expect(deleted.details.found).toBe(true);
		await emitCron(harness, "session_shutdown");
	});

	test("a task bound to a deleted session is paused and can be removed", async () => {
		// Nothing can claim a task whose conversation is gone: it is never listed,
		// never fired, and its expiry only runs for records this host owns. Without
		// marking it, the record sat in the shared file forever with no way out.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		new CronFileStore(file).save([
			{
				schemaVersion: 2,
				id: "gone",
				cron: "0 9 * * *",
				prompt: "bound to a deleted conversation",
				recurring: true,
				durable: true,
				createdAt: now - 1_000,
				nextFireAt: now + 3_600_000,
				sessionId: "session-that-was-deleted",
				// A path that does not exist: the record names its own proof, so no
				// directory scan is involved.
				sessionFile: path.join(cwd, "sessions", "20260101_session-that-was-deleted.jsonl"),
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const stored = new CronFileStore(file).load();
		expect(stored[0]?.status).toBe("paused");
		expect(stored[0]?.statusReason).toBe("session_missing");
		// Its bound session is gone, so this is the only place that can clear it.
		const deleted = (await harness.tools
			.get("cron_delete")!
			.execute("delete", { id: "gone" } as never, undefined, undefined, harness.ctx)) as {
			details: { found: boolean };
		};
		expect(deleted.details.found).toBe(true);
		await emitCron(harness, "session_shutdown");
	});

	test("a session file outside the default directory still counts as alive", async () => {
		// `--session <path>` keeps whatever path it was given, and a custom session
		// directory puts the file elsewhere. A record names its own file, so neither
		// looks lost — judging by an id and a directory listing marked live
		// sessions' own tasks as gone, and nothing could undo that.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		const elsewhere = path.join(makeDirectory(), "hand-picked-name.jsonl");
		writeFileSync(elsewhere, "{}\n");
		new CronFileStore(file).save([
			{
				schemaVersion: 2,
				id: "outside",
				cron: "0 9 * * *",
				prompt: "bound to a session file with a non-standard name",
				recurring: true,
				durable: true,
				createdAt: now - 1_000,
				nextFireAt: now + 3_600_000,
				sessionId: "session-elsewhere",
				sessionFile: elsewhere,
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const stored = new CronFileStore(file).load();
		expect(stored[0]?.status).toBeUndefined();
		expect(stored[0]?.statusReason).toBeUndefined();
		await emitCron(harness, "session_shutdown");
	});

	test("a record written before session files were recorded is left alone", async () => {
		// Such a record carries only an id, and an id is not a location. There is
		// nothing to verify, so nothing is guessed.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		new CronFileStore(file).save([
			{
				schemaVersion: 2,
				id: "old-style",
				cron: "0 9 * * *",
				prompt: "only a session id",
				recurring: true,
				durable: true,
				createdAt: now - 1_000,
				nextFireAt: now + 3_600_000,
				sessionId: "session-unknown",
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const stored = new CronFileStore(file).load();
		expect(stored[0]?.status).toBeUndefined();
		expect(stored[0]?.statusReason).toBeUndefined();
		await emitCron(harness, "session_shutdown");
	});

	test("a task from a host with no session file is still removable by its own session", async () => {
		// `--no-session` records an id but no file, so no start can verify it. Its
		// own conversation still owns it through the id, which is what keeps the
		// record from being stranded.
		vi.useFakeTimers();
		const harness = createHarness();
		harness.session.file = undefined;
		harness.session.id = "session-no-file";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const created = (await harness.tools
			.get("cron_create")!
			.execute(
				"create",
				{ cron: "0 9 * * *", prompt: "no file", durable: true } as never,
				undefined,
				undefined,
				harness.ctx,
			)) as { details: CronJob };
		expect("sessionFile" in created.details).toBe(false);
		// Not paused: there is nothing to check.
		const listed = (await harness.tools
			.get("cron_list")!
			.execute("list", {} as never, undefined, undefined, harness.ctx)) as { details: CronJob[] };
		expect(listed.details.map((job) => job.id)).toEqual([created.details.id]);
		const deleted = (await harness.tools
			.get("cron_delete")!
			.execute("delete", { id: created.details.id } as never, undefined, undefined, harness.ctx)) as {
			details: { found: boolean };
		};
		expect(deleted.details.found).toBe(true);
		await emitCron(harness, "session_shutdown");
	});

	test("a finished task keeps its outcome instead of being marked as a lost session", async () => {
		// Overwriting it with `paused` would hide why it stopped, and the record is
		// not a lost session in the first place.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		const gone = path.join(cwd, "sessions", "gone.jsonl");
		new CronFileStore(file).save([
			{
				schemaVersion: 2,
				id: "done",
				cron: "0 9 * * *",
				prompt: "finished",
				recurring: true,
				durable: true,
				createdAt: now - 10_000,
				nextFireAt: now + 3_600_000,
				sessionId: "session-gone",
				sessionFile: gone,
				status: "completed",
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const stored = new CronFileStore(file).load();
		expect(stored[0]?.status).toBe("completed");
		expect(stored[0]?.statusReason).toBeUndefined();
		await emitCron(harness, "session_shutdown");
	});

	test("a task whose bound session still exists is left alone", async () => {
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const now = Date.now();
		const file = path.join(cwd, ".stepcode", "cron", "tasks.json");
		new CronFileStore(file).save([
			{
				schemaVersion: 2,
				id: "alive",
				cron: "0 9 * * *",
				prompt: "still bound",
				recurring: true,
				durable: true,
				createdAt: now - 1_000,
				nextFireAt: now + 3_600_000,
				sessionId: "session-other",
				sessionFile: path.join(cwd, "sessions", "20260101_session-other.jsonl"),
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-mine";
		// The bound session's file is present, so its task stays live.
		const sessionFile = path.join(cwd, "sessions", "20260101_session-other.jsonl");
		mkdirSync(path.dirname(sessionFile), { recursive: true });
		writeFileSync(sessionFile, "{}\n");
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const stored = new CronFileStore(file).load();
		expect(stored[0]?.status).toBeUndefined();
		expect(stored[0]?.statusReason).toBeUndefined();
		// Still not ours to delete: that conversation is live.
		const deleted = (await harness.tools
			.get("cron_delete")!
			.execute("delete", { id: "alive" } as never, undefined, undefined, harness.ctx)) as {
			details: { found: boolean };
		};
		expect(deleted.details.found).toBe(false);
		await emitCron(harness, "session_shutdown");
	});

	test("a record with no session id is not claimed by any session", async () => {
		// Records written before tasks were bound cannot be attributed, and firing
		// one into an unrelated conversation is the defect this fixes. They stay on
		// disk, unlisted, rather than being delivered somewhere arbitrary.
		vi.useFakeTimers();
		const cwd = makeDirectory();
		const store = new CronFileStore(path.join(cwd, ".stepcode", "cron", "tasks.json"));
		store.save([
			{
				schemaVersion: 1,
				id: "legacy",
				cron: "* * * * *",
				prompt: "old",
				recurring: true,
				durable: true,
				createdAt: Date.now() - 1_000,
				nextFireAt: Date.now() + 1_000,
			},
		]);
		const harness = createHarness();
		Object.assign(harness.ctx, { cwd });
		harness.session.id = "session-any";
		createStepCronExtension({ enabled: true })(harness.api);
		await emitCron(harness, "session_start");
		const listed = (await harness.tools
			.get("cron_list")!
			.execute("list", {} as never, undefined, undefined, harness.ctx)) as {
			details: CronJob[];
		};
		expect(listed.details).toEqual([]);
		vi.advanceTimersByTime(120_000);
		expect(harness.sent).toEqual([]);
		await emitCron(harness, "session_shutdown");
	});
});
