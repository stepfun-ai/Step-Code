import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import type { ModelRequestTrace } from "../src/core/model-request-observer.ts";
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
	it("embeds the YAML config: release builds use it, dev builds ignore it", () => {
		const buildConfig = JSON.stringify({ endpoint: "https://collector.test/config" });
		expect(
			readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "release", STEPCODE_BUILD_USAGE_TELEMETRY: buildConfig }),
		).toBe("https://collector.test/config");
		expect(
			readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "dev", STEPCODE_BUILD_USAGE_TELEMETRY: buildConfig }),
		).toBeUndefined();
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
	it("takes the collector from the environment or the release build, never from source", () => {
		expect(readTelemetryEndpoint({ STEPCODE_TELEMETRY_ENDPOINT: "https://collector.test/ingest" })).toBe(
			"https://collector.test/ingest",
		);
		expect(
			readTelemetryEndpoint({
				STEPCODE_BUILD_CHANNEL: "release",
				STEPCODE_BUILD_TELEMETRY_ENDPOINT: "https://collector.test/release",
			}),
		).toBe("https://collector.test/release");
		// A dev build ignores the build-time default; a release build without one reports nowhere.
		expect(
			readTelemetryEndpoint({
				STEPCODE_BUILD_CHANNEL: "dev",
				STEPCODE_BUILD_TELEMETRY_ENDPOINT: "https://collector.test/release",
			}),
		).toBeUndefined();
		expect(readTelemetryEndpoint({ STEPCODE_BUILD_CHANNEL: "release" })).toBeUndefined();
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

	async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
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

	it("is a no-op without a collector, so nothing is sent or spooled", async () => {
		const provider = createStepUsageObservabilityProvider({ client: "cli", env: {} });
		const reporter = provider.createReporter();
		expect(reporter.enabled).toBe(false);
		expect(provider.createModelRequestObserver(reporter)).toBeUndefined();
	});

	it("forwards only the two usage events and records every trace with its session", async () => {
		const { reporter, observer, posted } = await setup();
		trackStepTelemetry(reporter, "cli_started", { entrypoint: "root", os: "darwin", node_version: "22.19" });
		observer?.onTraceId?.(trace());
		observer?.onTraceId?.(trace({ traceId: "1aa27d35c9ae9769b01aa31054fc1dea", statusCode: 404, attempt: 2 }));
		observer?.onTraceId?.(
			trace({
				traceId: "fc8e0193e63f9088cf594b55bbb4d21f",
				sessionId: "",
				provider: "stepcode-anthropic",
				model: "deepseek-v4.1-flash-api",
				baseUrl: `https://${INTERNAL_HOST}/v1`,
			}),
		);
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

	it("reports each user type once per UTC+8 day and skips third-party providers", async () => {
		const { reporter, observer, posted, setNow } = await setup();
		observer?.onTraceId?.(trace({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }));
		observer?.onTraceId?.(trace());
		observer?.onTraceId?.(trace({ traceId: "second" }));
		setNow(new Date("2026-10-26T16:30:00.000Z"));
		observer?.onTraceId?.(trace({ traceId: "next-day" }));
		await reporter.flush?.();

		const days = posted.filter((record) => record.event === "device_daily_active").map((record) => record.properties);
		expect(days).toEqual([
			expect.objectContaining({ user_type: "external", local_day: "2026-10-26" }),
			expect.objectContaining({ user_type: "external", local_day: "2026-10-27" }),
		]);
		const thirdParty = posted.find((record) => record.properties.provider === "openrouter");
		expect(thirdParty?.properties).toMatchObject({ user_type: "third_party", provider_kind: "openrouter" });
	});

	it("records a session start for internal gateways without sign-in and for Step only with a credential", async () => {
		const { provider, reporter, posted } = await setup();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const api = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		};
		const extension = provider.createActivityExtension(reporter);
		if (typeof extension === "function") throw new Error("expected a named inline extension");
		await extension.factory(api as unknown as ExtensionAPI);

		const step = {
			provider: "step",
			id: "step-5-preview",
			baseUrl: "https://api.stepfun.com/step_plan",
		} as Model<Api>;
		const internal = {
			provider: "stepcode-anthropic",
			id: "deepseek-v4.1-flash-api",
			baseUrl: `https://${INTERNAL_HOST}/v1`,
		} as Model<Api>;
		const ctx = (model: Model<Api>, signedIn: boolean) =>
			({ model, modelRegistry: { hasConfiguredAuth: () => signedIn } }) as unknown as ExtensionContext;

		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx(step, false));
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx(internal, false));
		handlers.get("model_select")?.({ type: "model_select", model: step, source: "set" }, ctx(step, true));
		await reporter.flush?.();

		expect(posted.map((record) => record.properties)).toEqual([
			expect.objectContaining({ user_type: "internal", provider_kind: "internal", provider: "stepcode-anthropic" }),
			expect.objectContaining({ user_type: "external", provider_kind: "step_plan", model: "step-5-preview" }),
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
		provider.createModelRequestObserver(reporter)?.onTraceId?.(trace({ sessionId: "s1", traceId: "t1" }));
		await reporter.flush?.();
		const daily = posted.find((record) => record.event === "device_daily_active");
		expect(daily?.properties).toMatchObject({ opened_at: "2026-10-26T01:00:00.000Z", local_day: "2026-10-26" });

		// A process left running past midnight reports today's record without yesterday's start.
		now = new Date("2026-10-26T16:30:00.000Z");
		provider.createModelRequestObserver(reporter)?.onTraceId?.(trace({ sessionId: "s2", traceId: "t2" }));
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
