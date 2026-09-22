import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-provider-base-url-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function loadConfig(providers: Record<string, unknown>): Promise<ModelConfig> {
	const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, JSON.stringify({ providers }), "utf8");
	return ModelConfig.load(path);
}

describe("composeModelProvider base URL normalization", () => {
	it("drops a models.json /v1 root for anthropic-messages", async () => {
		// A `/v1` root plus the SDK's own `/v1/messages` produced `/v1/v1/messages`
		// and a bare `404 page not found`.
		const config = await loadConfig({
			proxy: {
				api: "anthropic-messages",
				baseUrl: "https://proxy.example.com/v1",
				apiKey: "test-key",
				models: [{ id: "water18-0910" }],
			},
		});
		const models = composeModelProvider("proxy", undefined, config, undefined).getModels();
		expect(models.map((model) => model.baseUrl)).toEqual(["https://proxy.example.com"]);
	});

	it("keeps a models.json /v1 root for openai-responses", async () => {
		const config = await loadConfig({
			proxy: {
				api: "openai-responses",
				baseUrl: "https://proxy.example.com/v1",
				apiKey: "test-key",
				models: [{ id: "gpt-5.6-sol" }],
			},
		});
		const models = composeModelProvider("proxy", undefined, config, undefined).getModels();
		expect(models.map((model) => model.baseUrl)).toEqual(["https://proxy.example.com/v1"]);
	});

	it("normalizes a model level base URL override", async () => {
		const config = await loadConfig({
			proxy: {
				api: "anthropic-messages",
				baseUrl: "https://proxy.example.com",
				apiKey: "test-key",
				models: [{ id: "override", baseUrl: "https://other.example.com/v1/messages" }],
			},
		});
		const models = composeModelProvider("proxy", undefined, config, undefined).getModels();
		expect(models.map((model) => model.baseUrl)).toEqual(["https://other.example.com"]);
	});
});
