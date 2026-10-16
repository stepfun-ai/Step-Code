import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.ts";
import { createUsageLineage } from "../src/core/usage-lineage.ts";
import { collectSessionUsage } from "../src/core/usage-totals.ts";
import { decodePlanUsage, PlanUsageController, resolvePlanUsageAccount, usageText } from "../src/step/usage/account.ts";
import { type ActivityScanOptions, scanActivity } from "../src/step/usage/activity-engine.ts";
import { parseUsageCommand } from "../src/step/usage/commands.ts";
import { projectUsageJson, UsageProjectionLimit } from "../src/step/usage/json-projection.ts";
import type { PlanAccountContext } from "../src/step/usage/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
	const path = mkdtempSync(join(tmpdir(), "step-usage-test-"));
	roots.push(path);
	return path;
}
const timestamp = "2026-10-13T10:00:00.000Z";
function header(id: string, cwd = "/work/A", parentSession?: string): SessionHeader {
	return { type: "session", version: 3, id, cwd, timestamp, parentSession };
}
function row(
	id: string,
	input: number,
	output: number,
	cacheRead = 0,
	cacheWrite = 0,
	role = "assistant",
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role,
			content: [{ type: "text", text: "PRIVATE_MESSAGE_MUST_NOT_BE_CACHED" }],
			usage: { input, output, cacheRead, cacheWrite },
		},
	};
}
function caps(id: string, role = "user", parentCwd?: string): Record<string, unknown> {
	return {
		type: "custom",
		id: `cap-${id}`,
		parentId: null,
		timestamp: "2026-10-13T00:00:00.000Z",
		customType: "step.activity_capabilities",
		data: {
			version: 1,
			sessionId: id,
			sessionRole: role,
			parentCwd,
			skillDiscovery: true,
			skillActivation: true,
			pluginInvocation: true,
		},
	};
}
function mainRows(): Record<string, unknown>[] {
	return [
		caps("main"),
		row("a", 100, 5, 20, 10),
		row("b", 50, 10, 20),
		{
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp,
			usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3 },
		},
		row("d", 4, 1, 0, 0, "toolResult"),
	];
}
function write(path: string, rows: readonly unknown[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
function options(path: string, scope: "all" | "project" = "all"): ActivityScanOptions {
	return {
		roots: [join(path, "sessions")],
		cachePath: join(path, "cache", `index-${scope}.jsonl`),
		key: `test-${scope}`,
		cwd: "/work/A",
		scope,
		dates: ["2026-10-12", "2026-10-13"],
		timezone: "Asia/Shanghai",
	};
}

describe("usage totals and bounded projection", () => {
	it("includes all main entries, AutoCLM increments, and does not sum cumulative custom totals", () => {
		const entries = mainRows();
		expect(collectSessionUsage(entries).total).toBe(235);
		for (const [id, input, read, write, output] of [
			["clm1", 10, 2, 0, 3],
			["clm2", 20, 3, 1, 4],
		] as const)
			entries.push({
				type: "custom",
				customType: "step-auto-clm-usage",
				id,
				timestamp,
				data: { sessionId: "main", usage: { input, cacheRead: read, cacheWrite: write, output } },
			});
		entries.push({
			type: "custom",
			customType: "step-auto-clm-result",
			data: { usage: { input: 30, cacheRead: 5, cacheWrite: 1, output: 7 } },
		});
		const got = collectSessionUsage(entries);
		expect(got.total).toBe(278);
		expect(got.input).toBe(252);
		expect(got.output).toBe(26);
		expect(got.cacheHit).toBeCloseTo(47 / 252);
	});
	it("reuses ANSI stripping before bounding account and status labels", () => {
		expect(usageText("Plan \x1b[31mPro\x1b[0m\n")).toBe("Plan Pro");
		expect(usageText("\x1b]8;;https://example.com\x07Pro\x1b]8;;\x07")).toBe("Pro");
		expect(usageText("x".repeat(300))).toHaveLength(256);
	});

	it("keeps invalid and missing usage separate from real zero", () => {
		const entries = [row("valid", 0, 0), { type: "message", message: { role: "assistant" } }, row("bad", -1, 0)];
		expect(collectSessionUsage(entries)).toMatchObject({ total: 0, missing: 1, invalid: 1, cacheHit: null });
	});
	it("validates ignored content while retaining only statistics", () => {
		const projected = projectUsageJson(JSON.stringify(row("a", 10, 2)));
		expect(projected.message).not.toHaveProperty("content");
		expect(collectSessionUsage([projected]).total).toBe(12);
		expect(() => projectUsageJson('{"type":"message","message":{"content":[tru]}}')).toThrow(SyntaxError);
		expect(() => projectUsageJson('{"id":"a","id":"b"}')).toThrow(SyntaxError);
		expect(() => projectUsageJson(`{"unknown":${"[".repeat(70)}0${"]".repeat(70)}}`)).toThrow(UsageProjectionLimit);
		expect(() => projectUsageJson(JSON.stringify({ id: "a".repeat(5000) }))).toThrow(UsageProjectionLimit);
	});
	it("accepts escaped JSON strings and ignores large unrelated strings", () => {
		const raw = JSON.stringify({
			...row("a", 10, 2),
			ignored: "x".repeat(1024 * 1024),
			data: { name: 'skill\n"name\u4e2d', ignored: { deep: [1, false, null] } },
		});
		expect(projectUsageJson(raw).data).toMatchObject({ name: 'skill\n"name中' });
	});
});

describe("annual local activity and cache", () => {
	it("retains dispatch provenance when a fork selects the earlier assistant leaf", async () => {
		const path = root(),
			file = join(path, "sessions", "fork.jsonl"),
			source = mainRows() as unknown as SessionEntry[];
		const provenance = {
			type: "custom",
			id: "provenance",
			timestamp,
			customType: "step.usage_provenance",
			data: {
				version: 1,
				sessionId: "main",
				originSessionId: "main",
				usageEntryId: "a",
				reasoningAtDispatch: "high",
			},
		} as SessionEntry;
		const copied = source.slice(0, 2),
			lineage = createUsageLineage(header("main"), [...source, provenance], copied, "fork", timestamp, "a");
		write(file, [header("fork", "/work/B"), ...copied, ...lineage]);
		const got = await scanActivity(options(path, "project"));
		expect(got.tokens).toBe(135);
		expect(got.reasoning).toContainEqual(["high", 1]);
	});
	it("skips directory/file symlinks and concurrent cache readers do not duplicate totals", async () => {
		const path = root(),
			source = join(path, "sessions", "main.jsonl"),
			outside = join(path, "outside");
		write(source, [header("main"), ...mainRows()]);
		write(join(outside, "extra.jsonl"), [header("extra"), row("extra", 999, 0)]);
		symlinkSync(outside, join(path, "sessions", "linked"), "dir");
		symlinkSync(join(outside, "extra.jsonl"), join(path, "sessions", "linked.jsonl"));
		const results = await Promise.all([scanActivity(options(path)), scanActivity(options(path))]);
		expect(results.map((x) => x.tokens)).toEqual([235, 235]);
		expect((await scanActivity(options(path))).tokens).toBe(235);
	});

	it("deduplicates forks and excludes child chats, including project attribution", async () => {
		const path = root(),
			main = join(path, "sessions", "A", "main.jsonl"),
			fork = join(path, "sessions", "B", "fork.jsonl"),
			child = join(path, "sessions", "C", "child.jsonl");
		write(main, [header("main"), ...mainRows()]);
		write(fork, [header("fork", "/work/B", main), ...mainRows(), caps("fork"), row("new", 20, 2)]);
		write(child, [header("child", "/work/isolated"), caps("child", "subagent", "/work/A"), row("child-call", 30, 3)]);
		const checksum = createHash("sha256").update(readFileSync(main)).digest("hex");
		const all = await scanActivity(options(path));
		expect(all).toMatchObject({ tokens: 290, chats: 2 });
		expect(all.days[1]).toMatchObject({ tokens: 290, chats: 2 });
		const project = await scanActivity(options(path, "project"));
		expect(project).toMatchObject({ tokens: 268, chats: 1 });
		expect(createHash("sha256").update(readFileSync(main)).digest("hex")).toBe(checksum);
		expect(readFileSync(options(path).cachePath, "utf8")).not.toContain("PRIVATE_MESSAGE");
		expect((await scanActivity(options(path))).tokens).toBe(290);
	});
	it("reuses complete prefixes, includes a completed tail once, and detects prefix rewrite plus growth", async () => {
		const path = root(),
			file = join(path, "sessions", "main.jsonl"),
			opts = options(path);
		write(file, [header("main"), ...mainRows()]);
		expect((await scanActivity(opts)).tokens).toBe(235);
		const tail = JSON.stringify(row("tail", 20, 2));
		appendFileSync(file, tail.slice(0, -1));
		expect((await scanActivity(opts)).tokens).toBe(235);
		appendFileSync(file, "}\n");
		expect((await scanActivity(opts)).tokens).toBe(257);
		expect((await scanActivity(opts)).tokens).toBe(257);
		const changed = mainRows();
		changed[1] = row("a", 101, 5, 20, 10);
		write(file, [header("main"), ...changed, row("tail", 20, 2), row("more", 30, 3)]);
		expect((await scanActivity(opts)).tokens).toBe(291);
	});
	it("keeps coverage limitations through a cache hit and rebuilds corrupted cache", async () => {
		const path = root(),
			file = join(path, "sessions", "main.jsonl"),
			opts = options(path);
		write(file, [header("main"), ...mainRows()]);
		appendFileSync(file, "{broken}\n");
		expect((await scanActivity(opts)).limited).toContain("Invalid records");
		expect((await scanActivity(opts)).limited).toContain("Invalid records");
		writeFileSync(opts.cachePath, "bad cache\n");
		expect((await scanActivity(opts)).tokens).toBe(235);
	});
	it("preserves a multi-hop fork's original project after source files are removed", async () => {
		const path = root(),
			file = join(path, "sessions", "leaf.jsonl"),
			main = mainRows() as unknown as SessionEntry[],
			forkHeader = header("fork", "/work/B", "/removed/main.jsonl");
		const first = createUsageLineage(header("main"), main, main, "fork", timestamp, "d");
		const branch = [...main, ...first, row("new", 20, 2), caps("fork")] as unknown as SessionEntry[];
		const second = createUsageLineage(forkHeader, branch, branch, "leaf", timestamp, "cap-fork");
		write(file, [header("leaf", "/work/C", "/removed/fork.jsonl"), ...branch, ...second]);
		expect((await scanActivity(options(path))).tokens).toBe(257);
		expect((await scanActivity(options(path, "project"))).tokens).toBe(235);
	});
	it("uses started date and independent resource dimensions, not completion time", async () => {
		const path = root(),
			file = join(path, "sessions", "main.jsonl");
		write(file, [
			header("main"),
			caps("main"),
			{
				type: "custom",
				id: "run1",
				timestamp,
				customType: "step.activity",
				data: {
					sessionId: "main",
					kind: "skill",
					stage: "started",
					runId: "run",
					resourceId: "skill",
					name: "$skill",
					startedAt: Date.parse("2026-10-12T12:00:00Z"),
					pluginId: "plugin",
				},
			},
			{
				type: "custom",
				id: "run2",
				timestamp,
				customType: "step.activity",
				data: {
					sessionId: "main",
					kind: "plugin",
					stage: "started",
					runId: "run",
					resourceId: "plugin",
					name: "@plugin",
					startedAt: Date.parse("2026-10-12T12:00:00Z"),
				},
			},
		]);
		const got = await scanActivity(options(path));
		expect(got.topResources).toContainEqual(["$skill", 1]);
		expect(got.topResources).toContainEqual(["@plugin", 1]);
		expect(got.chats).toBe(0);
	});
});

function snapshot(): Record<string, unknown> {
	return {
		schema_version: 1,
		observed_at_ms: Date.now(),
		scope: "personal_account",
		account: { id: "123" },
		plan: { state: "known", family: "coding", name: "Pro", subscription: { id: "7", expires_at_ms: null } },
		quota: {
			state: "known",
			allowed: true,
			reason: null,
			windows: [
				{ id: "five_hour", limited: true, used_percent: 0, resets_at_ms: null },
				{ id: "weekly", limited: false, used_percent: null, resets_at_ms: null },
			],
			credit_buckets: [],
		},
	};
}
const accountContext = (identity = "a"): PlanAccountContext => ({
	identity,
	key: "private-key",
	projection: {
		presence: "present",
		eligible: true,
		source: "plan",
		accountId: "123",
		endpoint: "https://api.stepfun.com/step_plan/v1/usage",
	},
});
const response = (body: unknown = snapshot(), status = 200, headers?: Record<string, string>): Response =>
	new Response(JSON.stringify(body), { status, headers });

describe("account schema and lifecycle", () => {
	it("refreshes a cached snapshot after its reset boundary before the normal TTL", async () => {
		let wall = Date.now();
		const body = snapshot();
		(body.quota as Record<string, unknown>).windows = [
			{ id: "five_hour", limited: true, used_percent: 0, resets_at_ms: wall + 100 },
			{ id: "weekly", limited: false, used_percent: null, resets_at_ms: null },
		];
		const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(body));
		const controller = new PlanUsageController(
			() => accountContext(),
			fetchFn,
			() => wall,
		);
		await controller.query();
		wall += 101;
		expect(controller.readCached().status).toBe("stale");
		await controller.query();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		await controller.query();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("uses monotonic TTL/cooldown when wall time changes and preserves long Retry-After", async () => {
		let wall = Date.now(),
			tick = 0;
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
		const controller = new PlanUsageController(
			() => accountContext(),
			fetchFn,
			() => wall,
			12000,
			() => tick,
		);
		await controller.query();
		wall -= 3600000;
		tick += 31000;
		expect(controller.readCached().status).toBe("stale");
		fetchFn.mockResolvedValue(response({}, 429, { "Retry-After": "604800" }));
		await controller.query();
		wall += 36000000;
		tick += 86401000;
		await controller.query(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		tick += 7 * 86400000;
		await controller.query(true);
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it("supports genuine zero and unknown future bucket types without losing integer precision", () => {
		expect(decodePlanUsage(snapshot()).quota.windows[0].used_percent).toBe(0);
		const body = snapshot();
		body.plan = { state: "known", family: "token", name: null, subscription: null };
		body.quota = {
			state: "known",
			allowed: true,
			reason: null,
			windows: [],
			credit_buckets: [
				{
					type: "topup",
					total: "9007199254740993",
					remaining: "42",
					used_percent: 99,
					resets_at_ms: null,
					expires_at_ms: null,
				},
				{ type: "future-type" },
			],
		};
		const got = decodePlanUsage(body);
		expect(got.quota.credit_buckets?.[0].total).toBe("9007199254740993");
		expect(got.quota.credit_buckets?.[1].unsupported).toBe(true);
	});
	it("rejects invalid cross-family, identity and numeric snapshots", () => {
		for (const change of [
			(x: Record<string, unknown>) => {
				x.schema_version = 2;
			},
			(x: Record<string, unknown>) => {
				x.account = { id: "0" };
			},
			(x: Record<string, unknown>) => {
				(x.quota as Record<string, unknown>).windows = [
					{ id: "five_hour", limited: true, used_percent: NaN, resets_at_ms: null },
				];
			},
		]) {
			const body = snapshot();
			change(body);
			expect(() => decodePlanUsage(body)).toThrow();
		}
	});
	it("does not send gateway or platform keys to a personal endpoint", () => {
		const path = root(),
			auth = join(path, "auth.json");
		writeFileSync(
			auth,
			JSON.stringify({ step: { type: "oauth", access: "private-key", uid: "123", profile: "platform_cn" } }),
		);
		expect(resolvePlanUsageAccount(auth, {}).projection.eligible).toBe(false);
		expect(resolvePlanUsageAccount(auth, { STEP_API_KEY: "gateway" }).key).toBeUndefined();
		expect(resolvePlanUsageAccount(auth, { STEP_API_KEY: "gateway" }).projection.accountId).toBeUndefined();
		writeFileSync(
			auth,
			JSON.stringify({ step: { type: "oauth", access: "private-key", uid: "123", profile: "step_plan_oversea" } }),
		);
		expect(resolvePlanUsageAccount(auth, {}).projection.endpoint).toContain("stepfun.ai/step_plan/v1/usage");
	});
	it("shares requests, caches results and retains snapshots on visible failure", async () => {
		let now = Date.now();
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
		const controller = new PlanUsageController(
			() => accountContext(),
			fetchFn,
			() => now,
		);
		await Promise.all([controller.query(), controller.query()]);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await controller.query();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		now += 31000;
		fetchFn.mockResolvedValue(response({}, 503));
		expect((await controller.query()).status).toBe("stale");
		expect(controller.readCached().snapshot).toBeDefined();
	});
	it("settles timeout even when fetch ignores abort and late 401 cannot erase a newer snapshot", async () => {
		let finish!: (r: Response) => void;
		let calls = 0;
		const fetchFn = vi.fn<typeof fetch>().mockImplementation(() =>
			++calls === 1
				? new Promise<Response>((r) => {
						finish = r;
					})
				: Promise.resolve(response()),
		);
		const controller = new PlanUsageController(() => accountContext(), fetchFn, Date.now, 10);
		await controller.query();
		expect(controller.readCached().status).toBe("error");
		await controller.query(true);
		expect(controller.readCached().status).toBe("ready");
		finish(response({}, 401));
		await new Promise((r) => setTimeout(r, 0));
		expect(controller.readCached().status).toBe("ready");
	});
	it("drops old identity results and cancel settles promptly without waiting for fetch", async () => {
		let identity = "a",
			finish!: (r: Response) => void;
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(
				() =>
					new Promise<Response>((r) => {
						finish = r;
					}),
			)
			.mockResolvedValue(response());
		const controller = new PlanUsageController(() => accountContext(identity), fetchFn);
		const old = controller.query();
		identity = "b";
		await controller.query();
		finish(response({}, 401));
		await old;
		expect(controller.readCached().status).toBe("ready");
		const blocked = new PlanUsageController(
			() => accountContext(),
			vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {})),
		);
		const pending = blocked.query();
		blocked.cancel();
		await pending;
		expect(blocked.readCached().status).toBe("idle");
	});
	it("enforces Retry-After without changing stored credentials", async () => {
		let now = Date.now();
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({}, 429, { "Retry-After": "30" }));
		const controller = new PlanUsageController(
			() => accountContext(),
			fetchFn,
			() => now,
		);
		await controller.query();
		await controller.query(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		now += 31000;
		await controller.query();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it("bounds response body reads and rejects cross-account responses", async () => {
		const large = new PlanUsageController(
			() => accountContext(),
			vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(256 * 1024 + 1))),
		);
		expect((await large.query()).status).toBe("error");
		const body = snapshot();
		body.account = { id: "999" };
		const mismatched = new PlanUsageController(
			() => accountContext(),
			vi.fn<typeof fetch>().mockResolvedValue(response(body)),
		);
		expect((await mismatched.query()).snapshot).toBeUndefined();
	});
});

it("accepts only the two supported usage views and refresh forms", () => {
	for (const command of ["", "overview", "account", "--refresh", "account --refresh"])
		expect(parseUsageCommand(command)).toBeDefined();
	for (const command of ["session", "history", "overview --refresh", "account extra", "--refresh extra"])
		expect(parseUsageCommand(command)).toBeUndefined();
});
