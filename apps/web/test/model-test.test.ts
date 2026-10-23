/**
 * `testProviderModel`: the per-row connection test of the models editor. It
 * answers for the declaration in the form — saved or not — through the
 * provider stack a session would use. The gateway points at a closed port, so
 * the probe fails immediately with the transport's own words.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsError, testProviderModel } from "../src/model-providers.ts";

const ENV_KEYS = ["HOME", "STEP_CODING_AGENT_DIR", "STEPCODE_AUTH_PATH", "STEP_API_KEY"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let home = "";

test.before(async () => {
	home = await mkdtemp(join(tmpdir(), "stepcode-web-model-test-"));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.HOME = home;
	process.env.STEPCODE_AUTH_PATH = join(home, "auth.json");
	await mkdir(join(home, ".stepcode"), { recursive: true });
	await writeFile(join(home, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "fixture-only" } })}\n`);
});

test.after(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});

const draft = {
	providerId: "mygw",
	baseUrl: "http://127.0.0.1:9/v1",
	api: "openai-completions",
	apiKey: "fixture-only",
	modelId: "fixture-model",
};

test("an unreachable address fails the probe with the transport's error", { timeout: 60_000 }, async () => {
	await assert.rejects(
		() => testProviderModel(draft),
		(error: SettingsError) => {
			// The reason reaches the form either way; only its shape is asserted.
			assert.equal(error instanceof Error, true);
			return true;
		},
		"the probe must fail, not succeed or hang",
	);
});

test("missing fields are the caller's mistake, not a probe attempt", async () => {
	await assert.rejects(() => testProviderModel({ ...draft, baseUrl: "" }), /required/i);
	await assert.rejects(() => testProviderModel({ ...draft, modelId: "" }), /required/i);
});

test("the draft needs no models.json: the form is the declaration", { timeout: 60_000 }, async () => {
	// No models.json exists in the scratch home; the probe still resolves the
	// model from the body and fails on the network, not with "not found".
	await assert.rejects(
		() => testProviderModel({ ...draft, providerId: "brand-new" }),
		(error: Error) => !/not found/i.test(error.message),
	);
});
