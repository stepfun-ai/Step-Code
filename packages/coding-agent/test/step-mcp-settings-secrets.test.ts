import { describe, expect, it } from "vitest";
import type { StepMcpServerConfig } from "../src/step/config-toml.ts";
import {
	applyMcpSettingsPatch,
	applyValidatedMcpSettingsPatch,
	getMcpSettingsView,
	McpSettingsPatchError,
	parseMcpSettingsServerConfig,
} from "../src/step/mcp-settings-secrets.ts";

const configuration: StepMcpServerConfig = {
	url: "https://fixture.invalid/mcp?key=fixture-query-secret",
	http_headers: { Authorization: "fixture-header-secret" },
	bearer_token_env_var: "FIXTURE_ACCESS_TOKEN",
	env_http_headers: { "X-Token": "FIXTURE_HEADER_TOKEN" },
	oauth: { client_id: "fixture-id", client_secret: "fixture-client-secret" },
	enabled_tools: [],
	disabled_tools: ["dangerous_operation"],
	shared: false,
	enabled: false,
};

describe("validated MCP settings patches", () => {
	const patch = (current: unknown, fields: Record<string, unknown>) => ({
		revision: getMcpSettingsView(current).revision,
		fields,
	});

	it("keeps exact protected values, empty restrictions, OAuth references and future metadata", () => {
		const current = {
			...configuration,
			url: ` ${configuration.url} `,
			disabled_tools: [],
			oauth: { ...configuration.oauth, future_option: "fixture-opaque-secret" },
			future_metadata: { access: [], label: "fixture-future-secret" },
		};
		const result = applyValidatedMcpSettingsPatch(
			current,
			patch(current, {
				url: { operation: "keep" },
				tool_timeout_sec: { operation: "set", value: 90 },
			}),
		);
		expect(result).toEqual({ ...current, tool_timeout_sec: 90 });
		expect(current).not.toHaveProperty("tool_timeout_sec");
		expect(JSON.stringify(getMcpSettingsView(result))).not.toContain("fixture-future-secret");
	});

	it.each([
		["command", 42],
		["url", false],
		["cwd", 42],
		["bearer_token_env_var", null],
		["enabled", "false"],
		["shared", "false"],
		["tool_timeout_sec", null],
		["startup_timeout_sec", ""],
		["tool_timeout_sec", 0],
		["tool_timeout_sec", -1],
		["tool_timeout_sec", Infinity],
		["enabled_tools", null],
		["disabled_tools", [42]],
		["http_headers", { "fixture-secret-key": 42 }],
		["oauth", { callback_port: 65536 }],
	])("rejects invalid %s without disclosing input", (field, value) => {
		const apply = () =>
			applyValidatedMcpSettingsPatch(
				configuration,
				patch(configuration, {
					[field]: { operation: "set", value },
				}),
			);
		expect(apply).toThrowError("Invalid MCP settings patch");
		try {
			apply();
		} catch (error) {
			expect(error).toMatchObject({ status: 400, code: "mcp_settings_invalid" });
		}
	});

	it("requires explicit transport removals and retains the allowlist on a transport change", () => {
		const current = { command: "fixture-command", args: [], env: { KEY: "fixture-secret" }, enabled_tools: [] };
		const fields = {
			command: { operation: "remove" },
			url: { operation: "set", value: " https://fixture.invalid " },
		};
		expect(() => applyValidatedMcpSettingsPatch(current, patch(current, fields))).toThrow(McpSettingsPatchError);
		expect(
			applyValidatedMcpSettingsPatch(
				current,
				patch(current, {
					...fields,
					args: { operation: "remove" },
					env: { operation: "remove" },
				}),
			),
		).toEqual({ url: "https://fixture.invalid", enabled_tools: [] });
	});

	it("distinguishes setting, removing and keeping flags and protected values", () => {
		expect(
			applyValidatedMcpSettingsPatch(
				configuration,
				patch(configuration, {
					enabled: { operation: "set", value: true },
					http_headers: { operation: "remove" },
					oauth: { operation: "set", value: { client_id: "replacement", scopes: [] } },
				}),
			),
		).toEqual({
			...configuration,
			enabled: true,
			http_headers: undefined,
			oauth: { client_id: "replacement", scopes: [] },
		});
	});

	it("keeps every omitted or explicitly kept stdio field byte-for-byte", () => {
		const current = {
			command: " fixture-command ",
			args: [],
			cwd: " /fixture/private-directory ",
			env: { " FIXTURE_KEY ": "fixture-secret" },
			enabled_tools: [],
			disabled_tools: [],
			shared: true,
			enabled: true,
			future_metadata: { private: "fixture-secret" },
		};
		expect(
			applyValidatedMcpSettingsPatch(
				current,
				patch(current, {
					command: { operation: "keep" },
					args: { operation: "keep" },
					cwd: { operation: "keep" },
					env: { operation: "keep" },
					enabled: { operation: "keep" },
					shared: { operation: "keep" },
					enabled_tools: { operation: "keep" },
					disabled_tools: { operation: "keep" },
				}),
			),
		).toEqual(current);
	});

	it("requires removal of all HTTP-only fields when changing to stdio", () => {
		const fields = { url: { operation: "remove" }, command: { operation: "set", value: "fixture-command" } };
		expect(() => applyValidatedMcpSettingsPatch(configuration, patch(configuration, fields))).toThrow(
			McpSettingsPatchError,
		);
		expect(
			applyValidatedMcpSettingsPatch(
				configuration,
				patch(configuration, {
					...fields,
					http_headers: { operation: "remove" },
					bearer_token_env_var: { operation: "remove" },
					env_http_headers: { operation: "remove" },
					oauth: { operation: "remove" },
				}),
			),
		).toEqual({
			command: "fixture-command",
			enabled_tools: [],
			disabled_tools: ["dangerous_operation"],
			shared: false,
			enabled: false,
		});
	});

	it("reports stale revisions as safe conflicts before validating new field values", () => {
		const input = patch(configuration, { env: { operation: "set", value: "fixture-secret" } });
		expect(() => applyValidatedMcpSettingsPatch({ ...configuration, shared: true }, input)).toThrowError(
			"MCP configuration changed; reload before editing",
		);
		try {
			applyValidatedMcpSettingsPatch({ ...configuration, shared: true }, input);
		} catch (error) {
			expect(error).toMatchObject({ status: 409, code: "mcp_settings_changed" });
		}
	});

	it("shares declaration parsing while keeping replacement normalization and empty allowlists", () => {
		expect(
			parseMcpSettingsServerConfig({ command: " node ", args: [], env: {}, enabled_tools: [], unknown: 1 }),
		).toEqual({ command: "node", enabled_tools: [] });
		expect(parseMcpSettingsServerConfig(configuration)).toEqual(configuration);
		for (const invalid of [{}, { command: "a", url: "https://fixture.invalid" }, { url: "ftp://fixture.invalid" }])
			expect(() => parseMcpSettingsServerConfig(invalid)).toThrow(McpSettingsPatchError);
	});
});

describe("MCP settings secret preservation", () => {
	it("returns presence rather than stored literal values", () => {
		const view = getMcpSettingsView(configuration);
		const serialized = JSON.stringify(view);
		for (const secret of ["fixture-query-secret", "fixture-header-secret", "fixture-client-secret", "fixture-id"])
			expect(serialized).not.toContain(secret);
		expect(view.transport).toBe("http");
		expect(view.protectedFields).toEqual(expect.arrayContaining(["url", "http_headers", "oauth"]));
		expect(view.configuration).toMatchObject({ enabled_tools: [], shared: false, enabled: false });
		expect(view.configuration.bearer_token_env_var).toBe("FIXTURE_ACCESS_TOKEN");
	});

	it("does not expose credentials embedded in executable arguments or environment values", () => {
		const view = getMcpSettingsView({
			command: "fixture-private-command",
			args: ["fixture-secret-argument"],
			cwd: "/fixture/private-directory",
			env: { FIXTURE_KEY: "fixture-env-secret" },
		});
		expect(view.transport).toBe("stdio");
		for (const secret of [
			"fixture-private-command",
			"fixture-secret-argument",
			"private-directory",
			"fixture-env-secret",
		])
			expect(JSON.stringify(view)).not.toContain(secret);
		expect(view.protectedFields).toEqual(expect.arrayContaining(["command", "args", "cwd", "env"]));
	});

	it("treats malformed environment references as opaque rather than displaying their contents", () => {
		const view = getMcpSettingsView({
			url: "https://fixture.invalid",
			bearer_token_env_var: "Bearer fixture-secret",
			env_http_headers: { "X-Token": "not a variable name" },
		});
		expect(view.configuration.bearer_token_env_var).toBeUndefined();
		expect(view.configuration.env_http_headers).toBeUndefined();
		expect(JSON.stringify(view)).not.toContain("fixture-secret");
	});

	it("keeps untouched protected values and preserves permission lists", () => {
		const revision = getMcpSettingsView(configuration).revision;
		const result = applyMcpSettingsPatch(configuration, {
			revision,
			fields: {
				url: { operation: "keep" },
				http_headers: { operation: "keep" },
				tool_timeout_sec: { operation: "set", value: 90 },
			},
		});
		expect(result).toEqual({ ...configuration, tool_timeout_sec: 90 });
		expect(result).not.toBe(configuration);
		expect(configuration.tool_timeout_sec).toBeUndefined();
	});

	it("distinguishes explicitly setting a new value from removing an old one", () => {
		const result = applyMcpSettingsPatch(configuration, {
			revision: getMcpSettingsView(configuration).revision,
			fields: {
				http_headers: { operation: "remove" },
				oauth: { operation: "set", value: { client_id: "new-public-id" } },
			},
		});
		expect(result.http_headers).toBeUndefined();
		expect(result.oauth).toEqual({ client_id: "new-public-id" });
		expect(result.url).toBe(configuration.url);
	});

	it("rejects stale edits before merging any values", () => {
		const revision = getMcpSettingsView(configuration).revision;
		const changed = { ...configuration, enabled_tools: ["read_only"] };
		expect(() =>
			applyMcpSettingsPatch(changed, { revision, fields: { enabled: { operation: "set", value: true } } }),
		).toThrow(McpSettingsPatchError);
		try {
			applyMcpSettingsPatch(changed, { revision, fields: {} });
		} catch (error) {
			expect(error).toMatchObject({ status: 409, code: "mcp_settings_changed" });
		}
	});

	it("makes equivalent object order produce the same revision, but permission changes do not", () => {
		const left = getMcpSettingsView(configuration).revision;
		const reversed = Object.fromEntries(Object.entries(configuration).reverse());
		expect(getMcpSettingsView(reversed).revision).toBe(left);
		expect(getMcpSettingsView({ ...configuration, enabled_tools: ["read_only"] }).revision).not.toBe(left);
	});

	it.each([
		{ fields: { unknown: { operation: "remove" } } },
		{ fields: { url: { operation: "keep", value: "must-not-be-ignored" } } },
		{ fields: { url: { operation: "set" } } },
		{ fields: { url: { operation: "surprise" } } },
		{ fields: [] },
	])("rejects malformed field operations without echoing values", (input) => {
		const patch = { revision: getMcpSettingsView(configuration).revision, ...input };
		expect(() => applyMcpSettingsPatch(configuration, patch)).toThrow(McpSettingsPatchError);
		expect(() => applyValidatedMcpSettingsPatch(configuration, patch)).toThrow(McpSettingsPatchError);
	});

	it("rejects prototype-related field names", () => {
		const input = JSON.parse('{"fields":{"__proto__":{"operation":"set","value":{"polluted":true}}}}');
		expect(() =>
			applyMcpSettingsPatch(configuration, { ...input, revision: getMcpSettingsView(configuration).revision }),
		).toThrow(McpSettingsPatchError);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});
});
