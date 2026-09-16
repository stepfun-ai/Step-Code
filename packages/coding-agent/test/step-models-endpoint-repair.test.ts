import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createStepProviderConfig, STEP_PROVIDER_ID } from "../src/features/step-provider/index.ts";
import { canonicalStepBaseUrl, normalizeStepModelsFile } from "../src/step/models-endpoint-repair.ts";

const CANONICAL = "https://api.stepfun.com/step_plan";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeModels(models: unknown): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-endpoint-repair-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const path = join(agentDir, "models.json");
	await writeFile(path, JSON.stringify(models));
	return path;
}

async function readModels(path: string): Promise<{
	providers: Record<string, { api?: string; baseUrl?: string; models?: Array<Record<string, unknown>> }>;
}> {
	return JSON.parse(await readFile(path, "utf8"));
}

describe("Step models.json endpoint repair", () => {
	test("rewrites a stale Step endpoint override from an earlier Harness release", async () => {
		const path = await writeModels({
			providers: {
				[STEP_PROVIDER_ID]: {
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1",
					models: [
						{
							id: "step-3.7-flash",
							api: "anthropic-messages",
							baseUrl: "https://api.stepfun.com/step_plan/v1/messages",
						},
					],
				},
				custom: { api: "openai-completions", baseUrl: "https://custom.example/v1" },
			},
		});

		await expect(normalizeStepModelsFile(path, [], CANONICAL)).resolves.toBe(true);
		const models = await readModels(path);
		expect(models.providers[STEP_PROVIDER_ID]?.baseUrl).toBe(CANONICAL);
		expect(models.providers[STEP_PROVIDER_ID]?.models?.[0]?.baseUrl).toBe(CANONICAL);
		// A deliberately configured custom provider is not product-owned.
		expect(models.providers.custom?.baseUrl).toBe("https://custom.example/v1");
	});

	test("restores the Anthropic dialect on a built-in id left on an OpenAI route", async () => {
		const path = await writeModels({
			providers: {
				[STEP_PROVIDER_ID]: {
					api: "openai-compatible",
					baseUrl: "https://models-proxy.example/v1/messages",
					models: [
						{
							id: "step-3.7-flash",
							api: "openai-compatible",
							baseUrl: "https://models-proxy.example/v1/messages",
						},
					],
				},
			},
		});

		await expect(normalizeStepModelsFile(path, [], CANONICAL)).resolves.toBe(true);
		const models = await readModels(path);
		expect(models.providers[STEP_PROVIDER_ID]).toMatchObject({ api: "anthropic-messages", baseUrl: CANONICAL });
		expect(models.providers[STEP_PROVIDER_ID]?.models?.[0]).toMatchObject({
			api: "anthropic-messages",
			baseUrl: CANONICAL,
		});
	});

	test("leaves a canonical file untouched", async () => {
		const path = await writeModels({
			providers: {
				[STEP_PROVIDER_ID]: {
					api: "anthropic-messages",
					baseUrl: CANONICAL,
					models: [{ id: "step-3.7-flash", api: "anthropic-messages", baseUrl: CANONICAL }],
				},
			},
		});
		const before = await readFile(path, "utf8");

		await expect(normalizeStepModelsFile(path, [], CANONICAL)).resolves.toBe(false);
		await expect(readFile(path, "utf8")).resolves.toBe(before);
	});

	test("does not turn a missing or malformed catalog into a second launch error", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-endpoint-repair-bad-"));
		roots.push(root);
		const missing = join(root, "models.json");
		await expect(normalizeStepModelsFile(missing, [], CANONICAL)).resolves.toBe(false);

		await writeFile(missing, "{ not json");
		await expect(normalizeStepModelsFile(missing, [], CANONICAL)).resolves.toBe(false);
	});

	test("a repaired catalog resolves to the working messages endpoint", async () => {
		const path = await writeModels({
			providers: {
				[STEP_PROVIDER_ID]: {
					api: "anthropic-messages",
					baseUrl: "https://api.stepfun.com/step_plan/v1",
					models: [
						{
							id: "step-3.7-flash",
							api: "anthropic-messages",
							baseUrl: "https://api.stepfun.com/step_plan/v1/messages",
						},
					],
				},
			},
		});
		const authPath = join(path, "..", "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({
				[STEP_PROVIDER_ID]: {
					type: "oauth",
					access: "stored-step-key",
					refresh: "step-static-credential",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
		);

		await normalizeStepModelsFile(path, [], CANONICAL);

		const runtime = await ModelRuntime.create({ authPath, modelsPath: path, refreshOnCreate: false });
		runtime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig({ env: {} }));
		const model = runtime.getModel(STEP_PROVIDER_ID, "step-3.7-flash");
		expect(model?.baseUrl).toBe(CANONICAL);

		let requestUrl: string | undefined;
		await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input) => {
					requestUrl = String(input);
					return new Response(null, { status: 404 });
				},
			},
		);
		expect(requestUrl).toBe(`${CANONICAL}/v1/messages`);
	});

	test("an explicit endpoint override wins, a malformed one falls back to the default", async () => {
		expect(canonicalStepBaseUrl({ STEP_API_URL: "https://staging.example/step_plan" })).toBe(
			"https://staging.example/step_plan",
		);
		expect(canonicalStepBaseUrl({ STEP_API_URL: "not a url" })).toBe(CANONICAL);
		expect(canonicalStepBaseUrl({})).toBe(CANONICAL);
	});
});
