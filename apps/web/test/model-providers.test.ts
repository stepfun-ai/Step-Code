/**
 * Model-provider settings: CRUD against `models.json` plus the credential rules,
 * and model discovery against a local mock endpoint.
 *
 * Everything runs under a scratch HOME, so the developer's own `~/.stepcode` is
 * never read or written — the same isolation `settings.test.ts` uses.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	deleteModelProvider,
	discoverProviderModels,
	importLocalStepgoModels,
	listModelProviders,
	parseModelProvider,
	saveModelProvider,
	setStoredApiKey,
} from "../src/model-providers.ts";
import { SettingsError } from "../src/settings.ts";

const ENV_KEYS = [
	"HOME",
	"STEP_CODING_AGENT_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_AUTH_PATH",
	"STEPGO_HOME",
	"STEPCODE_HOME",
	"STEPCODE_STEPGO_IMPORT",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let home = "";

test.before(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-models-")));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.HOME = home;
});

test.after(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});

async function rejectsWith(work: Promise<unknown> | (() => unknown), status: number): Promise<void> {
	await assert.rejects(
		async () => (typeof work === "function" ? work() : work),
		(error: unknown) => error instanceof SettingsError && error.status === status,
	);
}

/** The declarations as they sit on disk, so a test can assert what was written. */
async function onDisk(): Promise<Record<string, unknown>> {
	const text = await readFile(join(home, ".stepcode", "models.json"), "utf8");
	return JSON.parse(text) as Record<string, unknown>;
}

async function authOnDisk(): Promise<Record<string, unknown>> {
	const text = await readFile(join(home, ".stepcode", "auth.json"), "utf8");
	return JSON.parse(text) as Record<string, unknown>;
}

test("a declaration needs an http(s) address, a protocol, and unique model ids", () => {
	assert.deepEqual(parseModelProvider({ baseUrl: "https://gw.example/v1", api: "openai-completions" }), {
		baseUrl: "https://gw.example/v1",
		api: "openai-completions",
	});
	// The API key never reaches the declaration, whatever the caller sends.
	assert.deepEqual(
		parseModelProvider({ baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "secret" }),
		{ baseUrl: "https://gw.example/v1", api: "openai-completions" },
	);
	// One address works under every protocol: the declaration stores what that
	// protocol's client appends its request path to.
	for (const typed of ["https://gw.example", "https://gw.example/v1/"]) {
		assert.equal(parseModelProvider({ baseUrl: typed, api: "openai-completions" }).baseUrl, "https://gw.example/v1");
		assert.equal(parseModelProvider({ baseUrl: typed, api: "openai-responses" }).baseUrl, "https://gw.example/v1");
		assert.equal(parseModelProvider({ baseUrl: typed, api: "anthropic-messages" }).baseUrl, "https://gw.example");
	}
	assert.equal(
		parseModelProvider({ baseUrl: "https://ark.example/api/v3", api: "openai-completions" }).baseUrl,
		"https://ark.example/api/v3",
	);
	for (const bad of [
		{ api: "openai-completions" },
		{ baseUrl: "ftp://gw.example" },
		{ baseUrl: "not a url", api: "openai-completions" },
		{ baseUrl: "https://gw.example/v1" },
	]) {
		assert.throws(() => parseModelProvider(bad), SettingsError);
	}
	assert.throws(
		() =>
			parseModelProvider({
				baseUrl: "https://gw.example/v1",
				api: "openai-completions",
				models: [{ id: "a" }, { id: "a" }],
			}),
		SettingsError,
	);
	// Capacities must be positive whole numbers when present.
	assert.throws(
		() =>
			parseModelProvider({
				baseUrl: "https://gw.example/v1",
				api: "openai-completions",
				models: [{ id: "a", contextWindow: 1.5 }],
			}),
		SettingsError,
	);
	assert.deepEqual(
		parseModelProvider({
			baseUrl: "https://gw.example/v1",
			api: "openai-completions",
			models: [{ id: "a", name: "A", contextWindow: 128000, maxTokens: 16384, input: ["text", "image"] }],
		}),
		{
			baseUrl: "https://gw.example/v1",
			api: "openai-completions",
			models: [{ id: "a", name: "A", contextWindow: 128000, maxTokens: 16384, input: ["text", "image"] }],
		},
	);
});

test("adding a provider writes models.json and puts the key in auth.json only", async () => {
	await saveModelProvider(
		"gw-one",
		{ name: "Gateway One", baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "sk-secret", models: [{ id: "m-1" }] },
		{ replace: false },
	);
	const document = await onDisk();
	assert.deepEqual(document.providers, {
		"gw-one": {
			baseUrl: "https://gw.example/v1",
			api: "openai-completions",
			name: "Gateway One",
			// The catalog is carried through; the key is not.
			models: [{ id: "m-1" }],
		},
	});
	assert.equal(JSON.stringify(document).includes("sk-secret"), false, "the key must not reach models.json");
	assert.deepEqual(await authOnDisk(), { "gw-one": { type: "api_key", key: "sk-secret" } });

	const [provider] = await listModelProviders();
	assert.equal(provider?.id, "gw-one");
	assert.equal(provider?.name, "Gateway One");
	assert.equal(provider?.credential, "stored");
	assert.deepEqual(provider?.models, [{ id: "m-1" }]);

	// A duplicate id is refused, and the same id with replace:true is an update.
	await rejectsWith(() => saveModelProvider("gw-one", { baseUrl: "https://other/v1", api: "openai-completions" }, { replace: false }), 409);
	await rejectsWith(() => saveModelProvider("missing", { baseUrl: "https://other/v1", api: "openai-completions" }, { replace: true }), 404);
});

test("a model's reasoning flag and thinking-level map survive a save and a read", async () => {
	const thinkingLevelMap = { off: "off", minimal: null, low: "low", high: "high", max: "max" };
	await saveModelProvider(
		"gw-think",
		{
			baseUrl: "https://gw.example",
			api: "openai-completions",
			models: [{ id: "m-think", reasoning: true, thinkingLevelMap }, { id: "m-plain", reasoning: false }],
		},
		{ replace: false },
	);
	const stored = (await onDisk()).providers as Record<string, { models: unknown }>;
	assert.deepEqual(stored["gw-think"]?.models, [
		{ id: "m-think", reasoning: true, thinkingLevelMap },
		{ id: "m-plain", reasoning: false },
	]);
	const provider = (await listModelProviders()).find((entry) => entry.id === "gw-think");
	assert.deepEqual(provider?.models, [
		{ id: "m-think", reasoning: true, thinkingLevelMap },
		{ id: "m-plain", reasoning: false },
	]);
	for (const bad of [
		{ id: "x", reasoning: "yes" },
		{ id: "x", thinkingLevelMap: { turbo: "turbo" } },
		{ id: "x", thinkingLevelMap: { high: 3 } },
		{ id: "x", thinkingLevelMap: ["high"] },
	]) {
		assert.throws(() => parseModelProvider({ baseUrl: "https://gw.example", api: "openai-completions", models: [bad] }), SettingsError);
	}
	await deleteModelProvider("gw-think");
});

test("the account provider and non-API-key credentials are refused", async () => {
	await rejectsWith(() => saveModelProvider("step", { baseUrl: "https://x/v1", api: "openai-completions" }, { replace: false }), 400);
	await rejectsWith(() => saveModelProvider("Bad_Id", { baseUrl: "https://x/v1", api: "openai-completions" }, { replace: false }), 400);

	// A signed-in provider's credential is not an API key and must not be touched.
	await setStoredApiKey("signed-in", "sk-first");
	const auth = await authOnDisk();
	assert.deepEqual(auth["signed-in"], { type: "api_key", key: "sk-first" });
});

test("editing keeps a stored key when the field is blank, and removeKey clears it", async () => {
	await saveModelProvider("gw-two", { baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "sk-two" }, { replace: false });
	assert.deepEqual((await authOnDisk())["gw-two"], { type: "api_key", key: "sk-two" });

	// A blank key means "unchanged": the browser never received the stored one.
	await saveModelProvider("gw-two", { baseUrl: "https://gw.example/v1", api: "openai-responses" }, { replace: true });
	assert.deepEqual((await authOnDisk())["gw-two"], { type: "api_key", key: "sk-two" });
	assert.equal((await listModelProviders()).find((p) => p.id === "gw-two")?.api, "openai-responses");

	// An explicit removal clears it.
	await saveModelProvider("gw-two", { baseUrl: "https://gw.example/v1", api: "openai-responses" }, { replace: true, removeKey: true });
	assert.equal((await authOnDisk())["gw-two"], undefined);
	assert.equal((await listModelProviders()).find((p) => p.id === "gw-two")?.credential, "none");
});

test("a hand-written literal key in the declaration survives an edit and is reported as configured", async () => {
	// The form never displays a literal apiKey, so replacing the declaration must
	// not silently drop what the user wrote by hand.
	const { writeFile, mkdir } = await import("node:fs/promises");
	await mkdir(join(home, ".stepcode"), { recursive: true });
	await writeFile(
		join(home, ".stepcode", "models.json"),
		JSON.stringify({
			keepMe: true,
			providers: {
				handwritten: { baseUrl: "https://hand/v1", api: "openai-completions", apiKey: "$HAND_KEY" },
			},
		}),
		"utf8",
	);
	const [provider] = await listModelProviders();
	assert.equal(provider?.id, "handwritten");
	assert.equal(provider?.credential, "configured");

	await saveModelProvider(
		"handwritten",
		{ baseUrl: "https://hand/v1", api: "openai-completions", models: [{ id: "m" }] },
		{ replace: true },
	);
	const document = await onDisk();
	assert.equal(document.keepMe, true, "an unknown top-level key survives");
	assert.deepEqual((document.providers as Record<string, Record<string, unknown>>).handwritten, {
		apiKey: "$HAND_KEY",
		baseUrl: "https://hand/v1",
		api: "openai-completions",
		models: [{ id: "m" }],
	});
});

test("an edit keeps the model and provider fields the form does not show", async () => {
	// `compat` decides how a request is built (adaptive vs budget thinking), and
	// `cost`/`headers`/`samplingParams` are hand-written values this page never
	// renders. Editing the provider — rotating its key, say — must not drop them.
	await mkdir(join(home, ".stepcode"), { recursive: true });
	await writeFile(
		join(home, ".stepcode", "models.json"),
		JSON.stringify({
			providers: {
				"gw-hidden": {
					baseUrl: "https://gw.example",
					api: "anthropic-messages",
					headers: { "x-gw": "1" },
					compat: { supportsStrictTools: true },
					cacheRetention: "long",
					authHeader: true,
					modelOverrides: { "m-keep": { contextWindow: 4096 } },
					models: [
						{
							id: "m-keep",
							reasoning: true,
							thinkingLevelMap: { low: "low" },
							maxTokens: 64000,
							cacheRetention: "short",
							compat: { forceAdaptiveThinking: true },
							cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
							headers: { "x-model": "1" },
						},
						{ id: "m-dropped", reasoning: true },
					],
				},
			},
		}),
		"utf8",
	);

	await saveModelProvider(
		"gw-hidden",
		{
			baseUrl: "https://gw.example",
			api: "anthropic-messages",
			apiKey: "sk-rotated",
			models: [
				{ id: "m-keep", reasoning: true, thinkingLevelMap: { low: "low" }, maxTokens: 8192 },
				{ id: "m-added" },
			],
		},
		{ replace: true },
	);

	const document = await onDisk();
	assert.deepEqual((document.providers as Record<string, Record<string, unknown>>)["gw-hidden"], {
		headers: { "x-gw": "1" },
		compat: { supportsStrictTools: true },
		cacheRetention: "long",
		authHeader: true,
		modelOverrides: { "m-keep": { contextWindow: 4096 } },
		baseUrl: "https://gw.example",
		api: "anthropic-messages",
		models: [
			{
				cacheRetention: "short",
				compat: { forceAdaptiveThinking: true },
				cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
				headers: { "x-model": "1" },
				// The form owns these, so its values win — including a lowered cap.
				id: "m-keep",
				reasoning: true,
				thinkingLevelMap: { low: "low" },
				maxTokens: 8192,
			},
			// A row the form no longer sends is gone: removing a model is an edit.
			{ id: "m-added" },
		],
	});
	assert.deepEqual((await authOnDisk())["gw-hidden"], { type: "api_key", key: "sk-rotated" });
	await deleteModelProvider("gw-hidden");
});

test("deleting a provider removes its declaration and its stored key", async () => {
	await saveModelProvider("gw-del", { baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "sk-del" }, { replace: false });
	await deleteModelProvider("gw-del");
	assert.equal((await listModelProviders()).some((provider) => provider.id === "gw-del"), false);
	assert.equal((await authOnDisk())["gw-del"], undefined);
	await rejectsWith(() => deleteModelProvider("gw-del"), 404);
});

/** A stand-in endpoint for the discovery tests; nothing leaves the machine. */
function mockEndpoint(
	handler: (url: string, headers: Record<string, string | string[] | undefined>, response: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server: Server = createServer((request, response) => {
			handler(request.url ?? "", request.headers, response);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${String(port)}`,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

function jsonResponse(response: import("node:http").ServerResponse, body: unknown, status = 200): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function configToml(): Promise<string> {
	return readFile(join(home, ".stepcode", "config.toml"), "utf8").catch(() => "");
}

test("a model's compaction threshold is stored in config.toml, not models.json, and read back", async () => {
	await mkdir(join(home, ".stepcode"), { recursive: true });
	await writeFile(
		join(home, ".stepcode", "config.toml"),
		'[compaction]\ntriggerRatio = 0.85\n\n[compaction.modelTriggerRatios]\n"other/x" = 0.8\n',
	);
	await saveModelProvider(
		"gw-ratio",
		{
			baseUrl: "https://gw.example/v1",
			api: "openai-completions",
			models: [{ id: "big", compactionThreshold: 0.7 }, { id: "small" }],
		},
		{ replace: false },
	);
	const declared = (await onDisk()).providers as Record<string, { models: Array<Record<string, unknown>> }>;
	assert.equal(
		declared["gw-ratio"]?.models.some((model) => "compactionThreshold" in model),
		false,
		"the threshold is a setting, not part of the model declaration",
	);
	const listed = (await listModelProviders()).find((provider) => provider.id === "gw-ratio");
	assert.deepEqual(
		listed?.models.map((model) => [model.id, model.compactionThreshold]),
		[
			["big", 0.7],
			["small", undefined],
		],
	);
	assert.match(await configToml(), /triggerRatio = 0\.85/u, "sibling compaction settings are kept");

	// An edit replaces this provider's thresholds: a cleared field and a removed
	// row drop their keys, another provider's key stays.
	await saveModelProvider(
		"gw-ratio",
		{
			baseUrl: "https://gw.example/v1",
			api: "openai-completions",
			models: [{ id: "small", compactionThreshold: 0.6 }],
		},
		{ replace: true },
	);
	const edited = (await listModelProviders()).find((provider) => provider.id === "gw-ratio");
	assert.deepEqual(edited?.models.map((model) => [model.id, model.compactionThreshold]), [["small", 0.6]]);
	const toml = await configToml();
	assert.doesNotMatch(toml, /gw-ratio\/big/u);
	assert.match(toml, /"other\/x" = 0\.8/u);

	// Out-of-range values are refused before anything is written.
	await rejectsWith(
		saveModelProvider(
			"gw-ratio",
			{ baseUrl: "https://gw.example/v1", api: "openai-completions", models: [{ id: "small", compactionThreshold: 0.99 }] },
			{ replace: true },
		),
		400,
	);
	assert.match(await configToml(), /"gw-ratio\/small" = 0\.6/u);

	await deleteModelProvider("gw-ratio");
	const afterDelete = await configToml();
	assert.doesNotMatch(afterDelete, /gw-ratio\//u, "deleting a provider removes its thresholds");
	assert.match(afterDelete, /"other\/x" = 0\.8/u);
});

test("saving a provider keeps another provider's threshold even when the CLI would ignore it", async () => {
	await mkdir(join(home, ".stepcode"), { recursive: true });
	await writeFile(join(home, ".stepcode", "config.toml"), '[compaction.modelTriggerRatios]\n"hand/edited" = 0.4\n');
	await saveModelProvider(
		"gw-keep",
		{ baseUrl: "https://gw.example/v1", api: "openai-completions", models: [{ id: "m", compactionThreshold: 0.8 }] },
		{ replace: false },
	);
	const toml = await configToml();
	assert.match(toml, /"hand\/edited" = 0\.4/u, "an entry this page does not own is left as written");
	assert.match(toml, /"gw-keep\/m" = 0\.8/u);
	await deleteModelProvider("gw-keep");
	assert.match(await configToml(), /"hand\/edited" = 0\.4/u);
	assert.doesNotMatch(await configToml(), /gw-keep/u);
});

test("an unreadable config.toml is reported on save and does not hide the provider list", async () => {
	await mkdir(join(home, ".stepcode"), { recursive: true });
	const broken = "[compaction\nbroken = ";
	await writeFile(join(home, ".stepcode", "config.toml"), broken);
	await assert.rejects(
		saveModelProvider(
			"gw-broken",
			{ baseUrl: "https://gw.example/v1", api: "openai-completions", models: [{ id: "m", compactionThreshold: 0.8 }] },
			{ replace: false },
		),
		(error: unknown) =>
			error instanceof SettingsError && error.status === 500 && /was saved, but its compaction thresholds/u.test(error.message),
	);
	assert.equal(await configToml(), broken, "the unreadable file is never overwritten");
	const listed = (await listModelProviders()).find((provider) => provider.id === "gw-broken");
	assert.deepEqual(listed?.models.map((model) => [model.id, model.compactionThreshold]), [["m", undefined]]);
	await writeFile(join(home, ".stepcode", "config.toml"), "");
	await deleteModelProvider("gw-broken");
});

test("discovery reads an OpenAI-shaped listing and sends the key as a bearer token", async () => {
	let seenPath = "";
	let seenAuth: string | undefined;
	const endpoint = await mockEndpoint((url, headers, response) => {
		seenPath = url;
		seenAuth = typeof headers.authorization === "string" ? headers.authorization : undefined;
		jsonResponse(response, {
			data: [
				{ id: "gpt-alpha", name: "Alpha", context_window: 128000, max_output_tokens: 8192 },
				{ id: "gpt-beta" },
				{ name: "no id" },
			],
		});
	});
	try {
		const models = await discoverProviderModels({
			baseUrl: `${endpoint.url}/v1`,
			api: "openai-completions",
			apiKey: "sk-probe",
		});
		assert.equal(seenPath, "/v1/models", "the OpenAI path is {base}/models");
		assert.equal(seenAuth, "Bearer sk-probe");
		assert.deepEqual(models, [
			{ id: "gpt-alpha", name: "Alpha", contextWindow: 128000, maxTokens: 8192 },
			{ id: "gpt-beta", name: "gpt-beta" },
		]);
	} finally {
		await endpoint.close();
	}
});

test("discovery reads an Anthropic listing at /v1/models with the version header", async () => {
	let seenPath = "";
	let seenKey: string | undefined;
	let seenVersion: string | undefined;
	const endpoint = await mockEndpoint((url, headers, response) => {
		seenPath = url;
		seenKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : undefined;
		seenVersion = typeof headers["anthropic-version"] === "string" ? headers["anthropic-version"] : undefined;
		jsonResponse(response, {
			data: [{ id: "claude-x", display_name: "Claude X", limit: { context: 200000, output: 64000 } }],
		});
	});
	try {
		// The configured root already ends in /v1; the listing still lands on /v1/models.
		const models = await discoverProviderModels({
			baseUrl: `${endpoint.url}/v1`,
			api: "anthropic-messages",
			apiKey: "sk-anthropic",
		});
		assert.equal(seenPath, "/v1/models?limit=1000");
		assert.equal(seenKey, "sk-anthropic");
		assert.equal(seenVersion, "2023-06-01");
		assert.deepEqual(models, [{ id: "claude-x", name: "Claude X", contextWindow: 200000, maxTokens: 64000 }]);

		// A base without /v1 produces the same listing URL.
		const again = await discoverProviderModels({ baseUrl: endpoint.url, api: "anthropic-messages" });
		assert.equal(again.length, 1);
	} finally {
		await endpoint.close();
	}
});

test("discovery reads an enriched models map, using each key as the id", async () => {
	const endpoint = await mockEndpoint((_url, _headers, response) => {
		jsonResponse(response, {
			models: {
				"alias-one": { id: "canonical-one", name: "One", context_length: 32000 },
				"alias-two": {},
				metadata: "not a model",
			},
		});
	});
	try {
		const models = await discoverProviderModels({ baseUrl: endpoint.url, api: "openai-completions" });
		assert.deepEqual(models, [
			{ id: "alias-one", name: "One", contextWindow: 32000 },
			{ id: "alias-two", name: "alias-two" },
		]);
	} finally {
		await endpoint.close();
	}
});

test("discovery reports the failure the user can act on", async () => {
	const unauthorized = await mockEndpoint((_url, _headers, response) => {
		jsonResponse(response, { error: "bad key" }, 401);
	});
	try {
		await rejectsWith(
			() => discoverProviderModels({ baseUrl: unauthorized.url, api: "openai-completions", apiKey: "wrong" }),
			502,
		);
	} finally {
		await unauthorized.close();
	}

	const notAListing = await mockEndpoint((_url, _headers, response) => {
		jsonResponse(response, { hello: "world" });
	});
	try {
		await rejectsWith(() => discoverProviderModels({ baseUrl: notAListing.url, api: "openai-completions" }), 400);
	} finally {
		await notAListing.close();
	}

	// A protocol with no readable listing is a caller mistake, not a network one.
	await rejectsWith(() => discoverProviderModels({ baseUrl: "https://gw.example/v1", api: "google-generative-ai" }), 400);
	await rejectsWith(() => discoverProviderModels({ baseUrl: "not a url", api: "openai-completions" }), 400);
	await rejectsWith(() => discoverProviderModels({ baseUrl: "", api: "openai-completions" }), 400);
});

test("discovery with a blank key uses the provider's stored key, and a typed key still wins", async () => {
	const seen: (string | undefined)[] = [];
	const endpoint = await mockEndpoint((_url, headers, response) => {
		const key = typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : undefined;
		seen.push(key);
		if (key !== "sk-stored" && key !== "sk-typed") {
			jsonResponse(response, { error: "bad key" }, 401);
			return;
		}
		jsonResponse(response, { data: [{ id: "claude-x" }] });
	});
	try {
		await saveModelProvider(
			"gw-discover",
			{ baseUrl: endpoint.url, api: "anthropic-messages", apiKey: "sk-stored", models: [{ id: "claude-x" }] },
			{ replace: false },
		);
		// Editing a saved provider: the key field is blank, the stored key answers.
		const models = await discoverProviderModels({ providerId: "gw-discover", baseUrl: endpoint.url, api: "anthropic-messages" });
		assert.deepEqual(models, [{ id: "claude-x", name: "claude-x" }]);
		assert.equal(seen.at(-1), "sk-stored");

		await discoverProviderModels({
			providerId: "gw-discover",
			baseUrl: endpoint.url,
			api: "anthropic-messages",
			apiKey: "sk-typed",
		});
		assert.equal(seen.at(-1), "sk-typed", "a typed key replaces the stored one for this request");

		// No stored credential (unknown id, or the account provider) means no key at all.
		await rejectsWith(() => discoverProviderModels({ providerId: "gw-unknown", baseUrl: endpoint.url, api: "anthropic-messages" }), 502);
		await rejectsWith(() => discoverProviderModels({ providerId: "step", baseUrl: endpoint.url, api: "anthropic-messages" }), 502);
		assert.equal(seen.at(-1), undefined);
	} finally {
		await deleteModelProvider("gw-discover");
		await endpoint.close();
	}
});

test("discovery refuses an over-large reply instead of truncating it", async () => {
	const endpoint = await mockEndpoint((_url, _headers, response) => {
		response.writeHead(200, { "content-type": "application/json", "content-length": String(5 * 1024 * 1024) });
		response.end("{}");
	});
	try {
		await rejectsWith(() => discoverProviderModels({ baseUrl: endpoint.url, api: "openai-completions" }), 400);
	} finally {
		await endpoint.close();
	}
});

test("a local stepgo launcher is imported once and then listed like any custom provider", async () => {
	const managedDir = join(home, ".stepgo", "config", "agent", "managed");
	await mkdir(managedDir, { recursive: true });
	await writeFile(
		join(home, ".stepgo", "config", "config.json"),
		JSON.stringify({ model: "config", apiKey: "ak-fixture-stepgo", baseUrl: "https://gw.example" }),
	);
	await writeFile(
		join(managedDir, "config.json"),
		JSON.stringify({
			providers: {
				"stepgo-chat": {
					api: "openai-completions",
					baseUrl: "https://gw.example/v1",
					models: [{ id: "m1", model: "m1", tokens: { maxContext: 200000, maxOutput: 8192 }, input: ["text"] }],
				},
			},
		}),
	);
	const lines: string[] = [];

	const result = await importLocalStepgoModels((line) => lines.push(line));

	assert.equal(result.status, "imported");
	assert.ok(lines.every((line) => !line.includes("ak-fixture-stepgo")), "the key is never logged");
	const row = (await listModelProviders()).find((provider) => provider.id === "stepgo-chat");
	assert.deepEqual(row, {
		id: "stepgo-chat",
		name: "stepgo-chat",
		baseUrl: "https://gw.example/v1",
		api: "openai-completions",
		models: [{ id: "m1", contextWindow: 200000, maxTokens: 8192, input: ["text"] }],
		credential: "stored",
	});
	assert.deepEqual((await authOnDisk())["stepgo-chat"], { type: "api_key", key: "ak-fixture-stepgo" });
	assert.ok(!JSON.stringify(await onDisk()).includes("ak-fixture-stepgo"));

	// Once imported the user owns it: a delete sticks across restarts.
	await deleteModelProvider("stepgo-chat");
	assert.equal((await importLocalStepgoModels(() => {})).status, "done");
	assert.equal((await listModelProviders()).find((provider) => provider.id === "stepgo-chat"), undefined);
});
