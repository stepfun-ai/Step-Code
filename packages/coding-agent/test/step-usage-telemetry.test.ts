import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelRequestTraceCapture,
	type ModelRequestObserver,
	type ModelRequestTrace,
} from "../src/core/model-request-observer.ts";
import { trackStepTelemetry } from "../src/step/telemetry-contract.ts";
import { readTelemetryEndpoint } from "../src/step/telemetry-runtime.ts";
import {
	classifyStepUsageEndpoint,
	createStepUsageObservabilityProvider,
	readInternalProviderHosts,
	stepUsageLocalDay,
} from "../src/step/usage-telemetry.ts";

const INTERNAL_HOST = "gateway.internal-example.test";
const profiles = [
	{ id: "step_plan", baseUrl: "https://api.stepfun.com/step_plan" },
	{ id: "step_plan_oversea", baseUrl: "https://api.stepfun.ai/step_plan" },
	{ id: "platform_cn", baseUrl: "https://api.stepfun.com/v1" },
	{ id: "platform_oversea", baseUrl: "https://api.stepfun.ai/v1" },
];
const classifier = { internalHosts: [INTERNAL_HOST], profiles };

describe("usage endpoint classification", () => {
	it("separates internal gateways, the four Step profiles, and third-party providers", () => {
		expect(classifyStepUsageEndpoint(`https://${INTERNAL_HOST}/v1`, "stepcode-anthropic", classifier)).toEqual({
			userType: "internal",
			providerKind: "internal",
		});
		expect(classifyStepUsageEndpoint("https://api.stepfun.com/step_plan/v1", "step", classifier)).toEqual({
			userType: "external",
			providerKind: "step_plan",
		});
		expect(classifyStepUsageEndpoint("https://api.stepfun.ai/step_plan", "step", classifier).providerKind).toBe(
			"step_plan_oversea",
		);
		expect(classifyStepUsageEndpoint("https://api.stepfun.com/v1/", "my-step", classifier).providerKind).toBe(
			"platform_cn",
		);
		expect(classifyStepUsageEndpoint("https://api.stepfun.ai/v1", "step", classifier).providerKind).toBe(
			"platform_oversea",
		);
		// Another path on a Step host is still a Step endpoint, reported under its provider id.
		expect(classifyStepUsageEndpoint("https://api.stepfun.com/v2", "beta", classifier)).toEqual({
			userType: "external",
			providerKind: "beta",
		});
		// Third-party endpoints are named by provider id, never by address.
		expect(classifyStepUsageEndpoint("https://openrouter.ai/api/v1", "openrouter", classifier)).toEqual({
			userType: "third_party",
			providerKind: "openrouter",
		});
		expect(classifyStepUsageEndpoint("not a url", "local", classifier).userType).toBe("third_party");
	});

	it("reads internal hosts from the runtime variable before the build-time list", () => {
		expect(
			readInternalProviderHosts({
				STEPCODE_INTERNAL_PROVIDER_HOSTS: " A.example.test, b.example.test,a.example.test ",
				STEPCODE_BUILD_INTERNAL_PROVIDER_HOSTS: "build.example.test",
			}),
		).toEqual(["a.example.test", "b.example.test"]);
		expect(readInternalProviderHosts({ STEPCODE_BUILD_INTERNAL_PROVIDER_HOSTS: "build.example.test" })).toEqual([
			"build.example.test",
		]);
		expect(readInternalProviderHosts({})).toEqual([]);
	});

	it("uses the UTC+8 calendar day", () => {
		expect(stepUsageLocalDay(new Date("2026-10-26T15:59:59.999Z"))).toBe("2026-10-26");
		expect(stepUsageLocalDay(new Date("2026-10-26T16:00:00.000Z"))).toBe("2026-10-27");
	});
});

describe("usage telemetry config", () => {
	it("embeds the YAML config on every channel, so local and release agree", () => {
		const buildConfig = JSON.stringify({ endpoint: "https://collector.test/config" });
		expect(
			readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "release", STEPCODE_BUILD_USAGE_TELEMETRY: buildConfig }),
		).toBe("https://collector.test/config");
		expect(
			readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "dev", STEPCODE_BUILD_USAGE_TELEMETRY: buildConfig }),
		).toBe("https://collector.test/config");
	});

	it("lets an operator point an installed build at another collector without rebuilding", () => {
		expect(
			readTelemetryEndpoint({
				STEPCODE_BUILD_CHANNEL: "dev",
				STEPCODE_USAGE_TELEMETRY: '{"endpoint":"https://tester.test/ingest"}',
			}),
		).toBe("https://tester.test/ingest");
		// The dedicated variable still wins over the config.
		expect(
			readTelemetryEndpoint({
				STEPCODE_TELEMETRY_ENDPOINT: "https://env.test/ingest",
				STEPCODE_USAGE_TELEMETRY: '{"endpoint":"https://tester.test/ingest"}',
			}),
		).toBe("https://env.test/ingest");
	});

	it("reads a runtime override file in the same YAML form the build reads", async () => {
		const directory = await mkdtemp(join(tmpdir(), "step-usage-config-"));
		try {
			const path = join(directory, "usage-telemetry.yaml");
			await writeFile(path, "endpoint: https://tester.test/yaml\ninternalProviderHosts:\n  - yaml.test\n");
			const env = { STEPCODE_BUILD_CHANNEL: "dev", STEPCODE_USAGE_TELEMETRY_CONFIG: path };
			expect(readTelemetryEndpoint(env)).toBe("https://tester.test/yaml");
			expect(readInternalProviderHosts(env)).toEqual(["yaml.test"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("takes internal hosts from the config and keeps explicit variables first", () => {
		const config = JSON.stringify({ internalProviderHosts: ["config.test"] });
		expect(readInternalProviderHosts({ STEPCODE_BUILD_USAGE_TELEMETRY: config })).toEqual(["config.test"]);
		expect(
			readInternalProviderHosts({
				STEPCODE_INTERNAL_PROVIDER_HOSTS: "explicit.test",
				STEPCODE_BUILD_USAGE_TELEMETRY: config,
			}),
		).toEqual(["explicit.test"]);
		// A runtime document overrides the embedded one field by field.
		expect(
			readInternalProviderHosts({
				STEPCODE_BUILD_USAGE_TELEMETRY: config,
				STEPCODE_USAGE_TELEMETRY: '{"internalProviderHosts":["runtime.test"]}',
			}),
		).toEqual(["runtime.test"]);
	});

	it("honors enabled: false from the config", () => {
		const provider = createStepUsageObservabilityProvider({
			client: "cli",
			env: {
				STEPCODE_TELEMETRY_ENDPOINT: "https://collector.test/ingest",
				STEPCODE_USAGE_TELEMETRY: '{"enabled":false}',
			},
		});
		expect(provider.createReporter().enabled).toBe(false);
	});
});

describe("telemetry endpoint resolution", () => {
	it("reports nowhere without the YAML: there is no built-in collector", () => {
		expect(readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "release" })).toBeUndefined();
		expect(readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "dev" })).toBeUndefined();
		expect(readTelemetryEndpoint({})).toBeUndefined();
		const provider = createStepUsageObservabilityProvider({
			client: "cli",
			env: { STEPCODE_BUILD_CHANNEL: "release" },
		});
		expect(provider.createReporter().enabled).toBe(false);
	});

	it("lets a release config.toml endpoint win over the embedded config", () => {
		const env = {
			STEPCODE_BUILD_CHANNEL: "release",
			STEPCODE_BUILD_USAGE_TELEMETRY: '{"endpoint":"https://collector.test/yaml"}',
		};
		expect(readTelemetryEndpoint(env, { endpoint: "https://collector.test/toml" })).toBe(
			"https://collector.test/toml",
		);
		// Dev builds keep ignoring a persisted endpoint, and fall back to the YAML.
		expect(
			readTelemetryEndpoint({ ...env, STEPCODE_BUILD_CHANNEL: "dev" }, { endpoint: "https://collector.test/toml" }),
		).toBe("https://collector.test/yaml");
		// The runtime override and the environment variable still come first.
		expect(
			readTelemetryEndpoint(
				{ ...env, STEPCODE_USAGE_TELEMETRY: '{"endpoint":"https://collector.test/runtime"}' },
				{ endpoint: "https://collector.test/toml" },
			),
		).toBe("https://collector.test/runtime");
		expect(
			readTelemetryEndpoint(
				{ ...env, STEPCODE_TELEMETRY_ENDPOINT: "https://collector.test/env" },
				{ endpoint: "https://collector.test/toml" },
			),
		).toBe("https://collector.test/env");
	});
});

interface Posted {
	readonly event: string;
	readonly properties: Record<string, unknown>;
	readonly context: Record<string, unknown>;
}

describe("usage observability provider", () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	async function setup(extraEnv: NodeJS.ProcessEnv = {}, explicitCredential = false) {
		const root = await mkdtemp(join(tmpdir(), "step-usage-telemetry-"));
		directories.push(root);
		const authPath = join(root, "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({ step: { type: "oauth", access: "a", refresh: "r", expires: 1, uid: "222690541878919168" } }),
		);
		const posted: Posted[] = [];
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			posted.push(...(JSON.parse(String(init?.body)) as { events: Posted[] }).events);
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		let now = new Date("2026-10-26T01:00:00.000Z");
		const env: NodeJS.ProcessEnv = {
			STEPCODE_TELEMETRY_ENDPOINT: "https://collector.test/ingest",
			STEPCODE_INTERNAL_PROVIDER_HOSTS: INTERNAL_HOST,
			STEPCODE_STORAGE_ROOT_DIR: root,
			STEPCODE_AUTH_PATH: authPath,
			...extraEnv,
		};
		const provider = createStepUsageObservabilityProvider({
			client: "cli",
			env,
			explicitCredential,
			now: () => now,
			runtime: { fetchImpl, spoolDirectory: join(root, "telemetry"), flushIntervalMs: 0, retryBackoffsMs: [] },
		});
		const reporter = provider.createReporter({ version: "1.2.3" });
		const observer = provider.createModelRequestObserver(reporter);
		const setNow = (value: Date): void => {
			now = value;
		};
		return { root, provider, reporter, observer, posted, setNow };
	}

	it("does not attach the stored account uid when the process runs on an explicit key", async () => {
		const { provider, reporter, observer, posted } = await setup({}, true);
		provider.refreshIdentity(reporter);
		await observer?.onTraceId?.(trace());
		await reporter.flush?.();
		expect(posted.length).toBeGreaterThan(0);
		for (const record of posted) expect(record.context.uid).toBeUndefined();
	});

	function trace(overrides: Partial<ModelRequestTrace> = {}): ModelRequestTrace {
		return {
			traceId: "a5f244fa5819b09ea2636d37611b7596",
			sessionId: "session-1",
			provider: "step",
			model: "step-5-preview",
			baseUrl: "https://api.stepfun.com/v1",
			statusCode: 200,
			attempt: 1,
			...overrides,
		};
	}

	/** One request through the SDK's real response capture; `traceId: ""` sends no header. */
	function request(
		observer: ModelRequestObserver | undefined,
		overrides: Partial<ModelRequestTrace> = {},
		statuses: readonly number[] = [overrides.statusCode ?? 200],
	): void {
		const value = trace(overrides);
		const capture = createModelRequestTraceCapture(observer, value.sessionId);
		const model = { provider: value.provider, id: value.model, baseUrl: value.baseUrl } as Model<Api>;
		for (const status of statuses) {
			capture?.onResponse({ status, headers: value.traceId ? { "x-trace-id": value.traceId } : {} }, model);
		}
	}

	it("is a no-op without a collector, so nothing is sent or spooled", async () => {
		const provider = createStepUsageObservabilityProvider({ client: "cli", env: {} });
		const reporter = provider.createReporter();
		expect(reporter.enabled).toBe(false);
		expect(provider.createModelRequestObserver(reporter)).toBeUndefined();
	});

	it("forwards only the two usage events and records every trace with its session", async () => {
		const { reporter, observer, posted } = await setup();
		trackStepTelemetry(reporter, "cli_started", { entrypoint: "root", os: "darwin", node_version: "22.19" });
		request(observer, {}, [200, 404]);
		request(observer, {
			traceId: "fc8e0193e63f9088cf594b55bbb4d21f",
			sessionId: "",
			provider: "stepcode-anthropic",
			model: "deepseek-v4.1-flash-api",
			baseUrl: `https://${INTERNAL_HOST}/v1`,
		});
		await reporter.flush?.();

		expect(posted.map((record) => record.event)).toEqual([
			"session_trace_recorded",
			"device_daily_active",
			"session_trace_recorded",
			"session_trace_recorded",
			"device_daily_active",
		]);
		const [first, externalDay, retried, internal, internalDay] = posted;
		expect(first?.properties).toEqual({
			session_id: "session-1",
			trace_id: "a5f244fa5819b09ea2636d37611b7596",
			user_type: "external",
			provider_kind: "platform_cn",
			provider: "step",
			model: "step-5-preview",
			status_code: 200,
			attempt: 1,
			local_day: "2026-10-26",
			client: "cli",
		});
		expect(first?.context).toMatchObject({ sessionId: "session-1", uid: "222690541878919168", version: "1.2.3" });
		expect(retried?.properties).toMatchObject({ status_code: 404, attempt: 2 });
		expect(internal?.properties).toMatchObject({ session_id: "", user_type: "internal", provider_kind: "internal" });
		expect(externalDay?.properties).toMatchObject({ user_type: "external", provider_kind: "platform_cn" });
		expect(internalDay?.properties).toMatchObject({
			user_type: "internal",
			provider_kind: "internal",
			local_day: "2026-10-26",
		});
	});

	it("counts every user type once per UTC+8 day, third-party providers without a trace id included", async () => {
		const { reporter, observer, posted, setNow } = await setup();
		// Third-party APIs send no x-trace-id: the request still counts, and no trace is recorded.
		request(observer, {
			traceId: "",
			provider: "openrouter",
			model: "gpt-x",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		request(observer);
		request(observer, { traceId: "second" });
		// An error status is still a request that reached the endpoint.
		request(observer, {
			traceId: "",
			provider: "stepcode-chat",
			baseUrl: `https://${INTERNAL_HOST}/v1`,
			statusCode: 402,
		});
		setNow(new Date("2026-10-26T16:30:00.000Z"));
		request(observer, { traceId: "next-day" });
		await reporter.flush?.();

		const days = posted.filter((record) => record.event === "device_daily_active").map((record) => record.properties);
		expect(days).toEqual([
			expect.objectContaining({
				user_type: "third_party",
				provider_kind: "openrouter",
				provider: "openrouter",
				model: "gpt-x",
				local_day: "2026-10-26",
			}),
			expect.objectContaining({ user_type: "external", local_day: "2026-10-26" }),
			expect.objectContaining({ user_type: "internal", provider: "stepcode-chat", local_day: "2026-10-26" }),
			expect.objectContaining({ user_type: "external", local_day: "2026-10-27" }),
		]);
		const traces = posted.filter((record) => record.event === "session_trace_recorded");
		expect(traces.map((record) => record.properties.trace_id)).toEqual([
			"a5f244fa5819b09ea2636d37611b7596",
			"second",
			"next-day",
		]);
	});

	it("treats both internal gateways from the shipped config as internal", async () => {
		const { reporter, observer, posted } = await setup({
			STEPCODE_INTERNAL_PROVIDER_HOSTS: "mp.z01.normandyfunc.com,i-ai-gw.stepx.com",
		});
		request(observer, { traceId: "", provider: "stepcode-anthropic", baseUrl: "https://mp.z01.normandyfunc.com" });
		request(observer, { traceId: "", provider: "gw", baseUrl: "https://i-ai-gw.stepx.com/v1" });
		await reporter.flush?.();
		// One internal record for the day, whichever gateway was used first.
		expect(posted.map((record) => record.properties)).toEqual([
			expect.objectContaining({ user_type: "internal", provider_kind: "internal", provider: "stepcode-anthropic" }),
		]);
	});

	it("dates the day's activity from the process start, not from when the model became usable", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-usage-telemetry-"));
		directories.push(root);
		const posted: Posted[] = [];
		let now = new Date("2026-10-26T09:30:00.000Z");
		const provider = createStepUsageObservabilityProvider({
			client: "cli",
			env: { STEPCODE_TELEMETRY_ENDPOINT: "https://collector.test/ingest", STEPCODE_STORAGE_ROOT_DIR: root },
			now: () => now,
			processStartedAt: new Date("2026-10-26T01:00:00.000Z"),
			runtime: {
				fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
					posted.push(...(JSON.parse(String(init?.body)) as { events: Posted[] }).events);
					return new Response("{}", { status: 200 });
				}) as typeof fetch,
				spoolDirectory: join(root, "telemetry"),
				flushIntervalMs: 0,
				retryBackoffsMs: [],
			},
		});
		const reporter = provider.createReporter();
		request(provider.createModelRequestObserver(reporter), { sessionId: "s1", traceId: "t1" });
		await reporter.flush?.();
		const daily = posted.find((record) => record.event === "device_daily_active");
		expect(daily?.properties).toMatchObject({ opened_at: "2026-10-26T01:00:00.000Z", local_day: "2026-10-26" });

		// A process left running past midnight reports today's record without yesterday's start.
		now = new Date("2026-10-26T16:30:00.000Z");
		request(provider.createModelRequestObserver(reporter), { sessionId: "s2", traceId: "t2" });
		await reporter.flush?.();
		const nextDay = posted.filter((record) => record.event === "device_daily_active").at(-1);
		expect(nextDay?.properties).toMatchObject({ local_day: "2026-10-27" });
		expect(nextDay?.properties.opened_at).toBeUndefined();
	});

	it("attaches the device id from the storage root", async () => {
		const { root, observer, reporter, posted } = await setup();
		await new Promise((resolve) => setTimeout(resolve, 20));
		observer?.onTraceId?.(trace());
		await reporter.flush?.();
		const deviceId = (await readFile(join(root, "device-id"), "utf8")).trim();
		expect(deviceId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(posted[0]?.context.deviceId).toBe(deviceId);
	});
});
