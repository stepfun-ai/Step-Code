import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSessionStore } from "../src/runtime.ts";

/**
 * A provider added to `models.json` (what the settings page writes) must reach
 * an already-open session's model picker through `refreshModels`, not only
 * sessions started after the change. The gateways point at a closed port; the
 * declarations themselves are what the catalog reads.
 */
test("refreshModels brings a provider added in settings into an open session", { timeout: 120_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-model-refresh-"));
	const previous = {
		agentDir: process.env.STEP_CODING_AGENT_DIR,
		authPath: process.env.STEPCODE_AUTH_PATH,
		apiKey: process.env.STEP_API_KEY,
		loginState: process.env.STEPCODE_LOGIN_STATE_PATH,
	};
	process.env.STEP_CODING_AGENT_DIR = join(base, "agent");
	process.env.STEPCODE_AUTH_PATH = join(base, "auth.json");
	delete process.env.STEP_API_KEY;
	delete process.env.STEPCODE_LOGIN_STATE_PATH;
	// `resolveStepConfigRoot()` is the agent dir's parent, so models.json sits
	// beside it — the same file the settings page writes.
	await mkdir(join(base, "agent"), { recursive: true });
	const modelsJson = (providers: Record<string, unknown>) =>
		writeFile(join(base, "models.json"), `${JSON.stringify({ providers })}\n`, "utf8");
	await modelsJson({
		mygw: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			name: "Closed Gateway",
			models: [{ id: "fixture-model" }],
		},
	});
	await writeFile(join(base, "auth.json"), `${JSON.stringify({ mygw: { type: "api_key", key: "test-key" } })}\n`);
	const store = new WebSessionStore();
	try {
		const session = await store.create(base);
		const before = session.snapshot();
		assert.equal(
			(before.models as Array<{ id: string }>).some((model) => model.id === "fixture-model"),
			true,
			"the declared provider's model is listed at session start",
		);

		// What the settings page does: a second provider appears in models.json.
		await modelsJson({
			mygw: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				name: "Closed Gateway",
				models: [{ id: "fixture-model" }],
			},
			newgw: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				name: "Added In Settings",
				models: [{ id: "added-model" }],
			},
		});
		await writeFile(
			join(base, "auth.json"),
			`${JSON.stringify({
				mygw: { type: "api_key", key: "test-key" },
				newgw: { type: "api_key", key: "test-key" },
			})}\n`,
		);

		assert.equal(
			(session.snapshot().models as Array<{ id: string }>).some((model) => model.id === "added-model"),
			false,
			"without a refresh the session's catalog is frozen at creation",
		);

		await session.refreshModels();
		const after = session.snapshot().models as Array<{ id: string; provider?: string; providerName?: string }>;
		const added = after.find((model) => model.id === "added-model");
		assert.equal(added?.provider, "newgw");
		assert.equal(added?.providerName, "Added In Settings", "the section heading is the declared provider name");
		assert.equal(after.some((model) => model.id === "fixture-model"), true, "the earlier provider survives");
	} finally {
		await store.close();
		await rm(base, { recursive: true, force: true });
		process.env.STEP_CODING_AGENT_DIR = previous.agentDir;
		process.env.STEPCODE_AUTH_PATH = previous.authPath;
		if (previous.apiKey === undefined) delete process.env.STEP_API_KEY;
		else process.env.STEP_API_KEY = previous.apiKey;
		if (previous.loginState === undefined) delete process.env.STEPCODE_LOGIN_STATE_PATH;
		else process.env.STEPCODE_LOGIN_STATE_PATH = previous.loginState;
	}
});
