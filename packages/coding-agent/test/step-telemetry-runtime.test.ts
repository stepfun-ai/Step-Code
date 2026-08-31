import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelRequestCompleted, ModelRequestStarted } from "../src/core/model-request-observer.ts";
import { createStepModelRequestObserver } from "../src/step/telemetry.ts";
import {
	createStepSystemMetricsCollector,
	createStepTelemetryRuntime,
	installStepTelemetryCrashHandlers,
	readTelemetryEndpoint,
	redactTelemetryString,
	trackStepTelemetryError,
} from "../src/step/telemetry-runtime.ts";

async function readSpool(directory: string, prefix: string): Promise<Array<Record<string, unknown>>> {
	const entries = await readdir(directory);
	const file = entries.find((entry) => entry.startsWith(`${prefix}-`));
	if (!file) return [];
	const contents = await readFile(join(directory, file), "utf8");
	return contents
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Step telemetry runtime", () => {
	it("uses the release collector default while keeping dev builds local", () => {
		expect(readTelemetryEndpoint({ STEP_CLI_BUILD_CHANNEL: "release" })).toBe(
			"https://api.stepfun.com/stepcliobserserver/api/v1/events",
		);
		expect(readTelemetryEndpoint({ STEP_CLI_BUILD_CHANNEL: "dev" })).toBeUndefined();
		expect(readTelemetryEndpoint({})).toBeUndefined();
	});

	it("is disabled automatically in test environments", () => {
		const runtime = createStepTelemetryRuntime({ env: { NODE_ENV: "test", VITEST: "1" } });
		expect(runtime.enabled).toBe(false);
		expect(runtime.endpoint).toBeUndefined();
	});

	it("posts the legacy event envelope and keeps a local spool copy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const requests: Array<{ url: string; init: RequestInit }> = [];
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				endpoint: "https://collector.example/api/v1/events",
				spoolDirectory: directory,
				flushThreshold: 1,
				flushIntervalMs: 0,
				clock: () => "2026-08-30T01:02:03.000Z",
				fetchImpl: async (url, init) => {
					requests.push({ url: String(url), init: init ?? {} });
					return new Response("{}", { status: 200 });
				},
			});
			runtime.track("model_request_completed", {
				provider: "step",
				model: "step-3.7-flash",
				duration_ms: 12,
				status_code: 200,
				streamed: true,
			});
			await runtime.flush();
			await runtime.shutdown();

			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toBe("https://collector.example/api/v1/events");
			expect(requests[0]?.init.method).toBe("POST");
			const body = JSON.parse(String(requests[0]?.init.body)) as { events: Array<Record<string, unknown>> };
			expect(body.events[0]).toMatchObject({
				event: "model_request_completed",
				at: "2026-08-30T01:02:03.000Z",
				properties: { provider: "step", model: "step-3.7-flash" },
			});
			expect(await readSpool(directory, "events")).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("writes a failed-delivery spool when the collector rejects a batch", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				endpoint: "https://collector.example/api/v1/events",
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
				retryBackoffsMs: [],
				clock: () => "2026-08-30T01:02:03.000Z",
				fetchImpl: async () => new Response("no", { status: 503 }),
			});
			runtime.track("model_request_started", { provider: "step", model: "step-3.7-flash", streamed: true });
			await runtime.shutdown();

			expect(await readSpool(directory, "events")).toHaveLength(1);
			expect(await readSpool(directory, "failed")).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("stamps observer session identity without changing event properties", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
				clock: () => "2026-08-30T01:02:03.000Z",
			});
			const observer = createStepModelRequestObserver(runtime);
			const request: ModelRequestStarted = {
				provider: "step",
				model: "step-3.7-flash",
				api: "openai-completions",
				baseUrl: "https://api.stepfun.com/v1",
				streamed: true,
				startedAt: 0,
				sessionId: "session-1",
			};
			const completed: ModelRequestCompleted = {
				...request,
				completedAt: 10,
				durationMs: 10,
				ttftMs: 1,
				statusCode: 200,
				outcome: "ok",
				stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			};
			observer.onRequestStarted?.(request);
			observer.onRequestCompleted?.(completed);
			await runtime.shutdown();

			const record = (await readSpool(directory, "events")).find(
				(candidate) => candidate.event === "model_request_completed",
			);
			expect(record?.context).toMatchObject({ sessionId: "session-1" });
			expect(record?.properties).toMatchObject({ provider: "step", model: "step-3.7-flash", duration_ms: 10 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("applies late ambient identity without relabeling session snapshots", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
				clock: () => "2026-08-30T01:02:03.000Z",
			});
			runtime.setContext({ sessionId: "session-a" });
			runtime.track("first_launch", { channel: "dev" });
			runtime.setContext({ sessionId: "session-b", deviceId: "device-1", commit: "abc123", uid: "uid-1" });
			runtime.track("session_started", { resumed: false, agent_mode: "normal", ui_mode: "interactive" });
			await runtime.shutdown();

			const records = await readSpool(directory, "events");
			expect(records[0]?.context).toMatchObject({
				sessionId: "session-a",
				deviceId: "device-1",
				commit: "abc123",
				uid: "uid-1",
			});
			expect(records[1]?.context).toMatchObject({
				sessionId: "session-b",
				deviceId: "device-1",
				commit: "abc123",
				uid: "uid-1",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("filters user-content property channels and redacts endpoint-shaped strings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
			});
			runtime.track("diagnostic", {
				prompt: "do not send this",
				label: "https://private.example/path",
				finite: Number.POSITIVE_INFINITY,
			});
			await runtime.shutdown();
			const record = (await readSpool(directory, "events"))[0];
			const properties = record?.properties as Record<string, unknown>;
			expect(properties).not.toHaveProperty("prompt");
			expect(properties.label).toBe("<redacted:url>");
			expect(properties).not.toHaveProperty("finite");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("retries transient collector responses but does not retry permanent failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			let attempts = 0;
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				endpoint: "https://collector.example/api/v1/events",
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
				retryBackoffsMs: [0, 0],
				clock: () => "2026-08-30T01:02:03.000Z",
				fetchImpl: async () => {
					attempts += 1;
					return attempts === 1 ? new Response("retry", { status: 503 }) : new Response("{}", { status: 200 });
				},
			});
			runtime.track("model_request_completed", { provider: "step", model: "step-3.7-flash" });
			await runtime.flush();
			await runtime.shutdown();
			expect(attempts).toBe(2);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not retry transport failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			let attempts = 0;
			let sleeps = 0;
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				endpoint: "https://collector.example/api/v1/events",
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
				retryBackoffsMs: [0, 0],
				sleep: async () => {
					sleeps += 1;
				},
				fetchImpl: async () => {
					attempts += 1;
					throw new Error("DNS failure");
				},
			});
			runtime.track("model_request_completed", { provider: "step", model: "step-3.7-flash" });
			await runtime.flush();
			await runtime.shutdown();

			expect(attempts).toBe(1);
			expect(sleeps).toBe(0);
			expect(await readSpool(directory, "failed")).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("matches the legacy retry status vocabulary", async () => {
		for (const status of [408, 425]) {
			const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
			try {
				let attempts = 0;
				let sleeps = 0;
				const runtime = createStepTelemetryRuntime({
					enabled: true,
					env: {},
					endpoint: "https://collector.example/api/v1/events",
					spoolDirectory: directory,
					flushThreshold: 10,
					flushIntervalMs: 0,
					retryBackoffsMs: [0, 0],
					sleep: async () => {
						sleeps += 1;
					},
					fetchImpl: async () => {
						attempts += 1;
						return new Response("no", { status });
					},
				});
				runtime.track("model_request_completed", { provider: "step", model: "step-3.7-flash" });
				await runtime.flush();
				await runtime.shutdown();
				expect(attempts).toBe(1);
				expect(sleeps).toBe(0);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	});

	it("does not head-of-line block later batches behind a slow collector", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		let releaseFirst: (() => void) | undefined;
		try {
			let attempts = 0;
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				endpoint: "https://collector.example/api/v1/events",
				spoolDirectory: directory,
				flushThreshold: 1,
				flushIntervalMs: 0,
				retryBackoffsMs: [],
				fetchImpl: async () => {
					attempts += 1;
					if (attempts === 1) {
						await new Promise<void>((resolve) => {
							releaseFirst = resolve;
						});
					}
					return new Response("{}", { status: 200 });
				},
			});

			runtime.track("first_launch", { channel: "dev" });
			await Promise.resolve();
			runtime.track("cli_exited", { duration_ms: 1, exit_reason: "normal" });
			await Promise.resolve();
			expect(attempts).toBe(2);
			releaseFirst?.();
			await runtime.shutdown();
		} finally {
			releaseFirst?.();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("redacts the legacy sensitive shapes, including Unicode paths", () => {
		expect(redactTelemetryString("owner@example.com")).toBe("<redacted:email>");
		expect(redactTelemetryString("eyJheader12345.payload12345.signature12345")).toBe("<redacted:jwt>");
		expect(redactTelemetryString("failed at /Users/张三/项目/step-harness")).toContain("<redacted:path>");
		expect(redactTelemetryString("C:\\Users\\张三\\项目\\step-harness")).toContain("<redacted:path>");
		expect(redactTelemetryString("x".repeat(600))).toHaveLength(600);
	});

	it("applies the legacy username boundary to telemetry context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const valid = createStepTelemetryRuntime({
				env: { STEP_HARNESS_USER: "  kris@stepfun.com\n" },
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
			});
			valid.track("first_launch", { channel: "dev" });
			await valid.shutdown();
			expect((await readSpool(directory, "events"))[0]?.context).toMatchObject({
				username: "kris@stepfun.com",
			});

			const invalidDirectory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
			try {
				const invalid = createStepTelemetryRuntime({
					env: { STEP_CLI_USER: "not a username" },
					spoolDirectory: invalidDirectory,
					flushThreshold: 10,
					flushIntervalMs: 0,
				});
				invalid.track("first_launch", { channel: "dev" });
				await invalid.shutdown();
				expect((await readSpool(invalidDirectory, "events"))[0]?.context).not.toHaveProperty("username");
			} finally {
				await rm(invalidDirectory, { recursive: true, force: true });
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("allows ambient context fields to be patched", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-telemetry-runtime-"));
		try {
			const runtime = createStepTelemetryRuntime({
				enabled: true,
				env: {},
				spoolDirectory: directory,
				flushThreshold: 10,
				flushIntervalMs: 0,
			});
			runtime.setContext({ channel: "release", version: "1.2.3", platform: "linux" });
			runtime.track("first_launch", { channel: "release" });
			await runtime.shutdown();
			const record = (await readSpool(directory, "events"))[0];
			expect(record?.context).toMatchObject({ channel: "release", version: "1.2.3", platform: "linux" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("collects bounded system metrics with an injectable CPU window", () => {
		const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
		const reporter = {
			track(event: string, properties: Record<string, unknown>) {
				events.push({ event, properties });
			},
		};
		let now = 0n;
		const collector = createStepSystemMetricsCollector(reporter, {
			intervalMs: 0,
			warmupMs: null,
			now: () => now,
		});

		collector.sample();
		now = 2_000_000n;
		collector.sample();
		collector.start();
		collector.start();
		collector.stop();
		collector.stop();

		expect(events).toHaveLength(2);
		expect(events[0]?.event).toBe("system_metrics");
		expect(events[1]?.properties).toMatchObject({
			cpu_elapsed_us: 2_000,
		});
		for (const { properties } of events) {
			for (const value of Object.values(properties)) {
				if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
			}
		}
	});

	it("records handled errors without exporting their messages and releases crash listeners", () => {
		const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
		let flushes = 0;
		const reporter = {
			track(event: string, properties: Record<string, unknown>) {
				events.push({ event, properties });
			},
			flush: async () => {
				flushes += 1;
			},
		};
		const error = Object.assign(new Error("secret /Users/alice/project"), { code: "EACCES" });
		trackStepTelemetryError(reporter, error, "cli_entry", false);
		expect(events).toEqual([
			{
				event: "error_raised",
				properties: { error_type: "EACCES", where: "cli_entry", retryable: false },
			},
		]);

		const handlers = installStepTelemetryCrashHandlers(reporter);
		process.emit("uncaughtExceptionMonitor", new Error("do not export this"));
		handlers.dispose();
		handlers.dispose();
		expect(events.at(-1)).toEqual({
			event: "crash",
			properties: { error_type: "Error", source: "uncaught_exception" },
		});
		expect(flushes).toBe(1);
	});
});
