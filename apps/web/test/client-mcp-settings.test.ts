import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import type * as Editor from "../client/src/features/settings/McpEditor.tsx";
import type { SettingsMcpServer } from "../client/src/state/types.ts";
import { mcpSettingsMessages } from "../client/src/i18n/mcp-settings-messages.ts";

const source = await readFile(new URL("../client/src/features/settings/McpEditor.tsx", import.meta.url), "utf8");
// Execute the actual pure editor conversions without loading DOM/CSS modules or host resources.
const start = source.indexOf("type Transport");
const end = source.indexOf("export function McpEditor(");
assert.ok(start >= 0 && end > start);
const helpers = ts.transpileModule(source.slice(start, end), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const conversions: Pick<typeof Editor, "formFromConfig" | "configFromForm" | "serversFromJson" | "initialMcpPatchDraft" | "mcpPatchFromDraft" | "mcpPatchDraftFromJson" | "changeMcpPatchTransport"> =
	new Function("exports", `${helpers}\nreturn exports;`)({});
const { initialMcpPatchDraft, mcpPatchFromDraft, mcpPatchDraftFromJson, changeMcpPatchTransport } = conversions;

const existing: SettingsMcpServer = {
	name: "fixture", source: "user", enabled: false, transport: "http", revision: "a".repeat(64),
	protectedFields: ["url", "http_headers", "oauth"],
	config: {
		enabled_tools: [], disabled_tools: ["write"], env_http_headers: { "X-Key": "FIXTURE_KEY" },
		bearer_token_env_var: "FIXTURE_TOKEN", shared: false, enabled: false, tool_timeout_sec: 20,
		// Even a stale unsafe DTO must not populate the patch form with secrets.
		url: "https://fixture.invalid/?token=fixture-secret", http_headers: { Authorization: "fixture-secret" },
		oauth: { client_secret: "fixture-secret" },
	},
};

function roundTrip(draft: Editor.McpPatchDraft): Editor.McpPatchDraft {
	return mcpPatchDraftFromJson(JSON.stringify(mcpPatchFromDraft(draft)), existing);
}

test("initial edit uses explicit transport and keeps protected fields without exposing values", () => {
	const draft = initialMcpPatchDraft(existing);
	assert.equal(draft.transport, "http");
	assert.doesNotMatch(JSON.stringify(draft), /fixture-secret/u);
	assert.equal(draft.fields.url.text, "");
	assert.equal(draft.fields.enabled_tools.text, "[]");
	for (const change of Object.values(mcpPatchFromDraft(draft).fields)) assert.deepEqual(change, { operation: "keep" });
});

test("form/JSON transitions keep empty allowlists, refs, sharing and explicit removals/replacements", () => {
	const initial = initialMcpPatchDraft(existing);
	const draft: Editor.McpPatchDraft = { ...initial, fields: { ...initial.fields,
		http_headers: { operation: "remove", text: "" },
		enabled_tools: { operation: "set", text: "[]" },
		oauth: { operation: "set", text: '{"client_secret":"fixture-new-secret"}' },
	} };
	assert.deepEqual(mcpPatchFromDraft(roundTrip(roundTrip(draft))), mcpPatchFromDraft(draft));
	assert.deepEqual(mcpPatchFromDraft(roundTrip(draft)).fields.env_http_headers, { operation: "keep" });
	assert.deepEqual(mcpPatchFromDraft(roundTrip(draft)).fields.shared, { operation: "keep" });
	assert.deepEqual(mcpPatchFromDraft(roundTrip(draft)).fields.enabled, { operation: "keep" });
});

test("omitted JSON fields preserve restrictions and malformed patches cannot switch to form", () => {
	const draft = mcpPatchDraftFromJson(JSON.stringify({ revision: existing.revision, fields: {} }), existing);
	assert.deepEqual(mcpPatchFromDraft(draft).fields.enabled_tools, { operation: "keep" });
	for (const fields of [{ enabled_tools: [] }, { url: { operation: "set" } },
		{ unknown: { operation: "remove" } }, { env: { operation: "keep", value: "***" } }]) {
		assert.throws(() => mcpPatchDraftFromJson(JSON.stringify({ revision: existing.revision, fields }), existing));
	}
	assert.throws(() => mcpPatchDraftFromJson(JSON.stringify({ revision: "b".repeat(64), fields: {} }), existing));
	assert.throws(() => mcpPatchDraftFromJson('{"url":"https://fixture.invalid"}', existing));
});

test("transport switch removes incompatible fields explicitly and retains all restriction operations", () => {
	const switched = changeMcpPatchTransport(initialMcpPatchDraft(existing), "stdio");
	for (const field of ["url", "oauth", "http_headers", "env_http_headers", "bearer_token_env_var"] as const) {
		assert.equal(switched.fields[field].operation, "remove");
	}
	assert.equal(switched.fields.command.operation, "set");
	assert.equal(switched.fields.enabled_tools.operation, "keep");
	assert.equal(switched.fields.disabled_tools.operation, "keep");
	const ready = { ...switched, fields: { ...switched.fields, command: { operation: "set" as const, text: '"fixture-node"' } } };
	assert.deepEqual(mcpPatchFromDraft(roundTrip(ready)), mcpPatchFromDraft(ready));
});

test("new declaration form/JSON conversions retain restrictions, refs, OAuth, sharing and disabled state", () => {
	const config = { url: "https://fixture.invalid/mcp", enabled_tools: [], disabled_tools: ["write"],
		env_http_headers: { "X-Key": "FIXTURE_KEY" }, oauth: { client_id: "fixture-id" }, enabled: false, shared: false };
	const form = conversions.formFromConfig("new-fixture", config);
	const output = JSON.parse(JSON.stringify(conversions.configFromForm(form)));
	assert.deepEqual(output, config);
	const [entry] = conversions.serversFromJson(JSON.stringify({ "new-fixture": output }), "new-fixture");
	assert.ok(entry);
	assert.deepEqual(JSON.parse(JSON.stringify(conversions.configFromForm(conversions.formFromConfig(entry[0], entry[1])))), config);
});

test("edits send patches, list descriptions never render raw secrets, and keys are bilingual", async () => {
	assert.match(source, /"PUT",\s*\{ patch \}/u);
	assert.doesNotMatch(source, /"PUT",\s*\{ config/u);
	const page = await readFile(new URL("../client/src/features/settings/McpPage.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(page, /title=\{server|config\.url|config\.command|\? server\.error/u);
	assert.deepEqual(Object.keys(mcpSettingsMessages.zh).sort(), Object.keys(mcpSettingsMessages.en).sort());
});
