import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import {
	DEFAULT_COMPACTION_TRIGGER_RATIO,
	MAX_COMPACTION_TRIGGER_RATIO,
	MIN_COMPACTION_TRIGGER_RATIO,
} from "../src/core/compaction/trigger-policy.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import {
	ClosedModelsJsonSchema,
	ConfigTomlSchema,
	MODELS_SCHEMA_FILE_NAME,
	ModelsJsonSchema,
	PermissiveModelsJsonSchema,
	renderConfigSchema,
	renderStrictModelsSchema,
	renderThemeSchema,
} from "../src/step/config-schema.ts";
import { STEP_SETTING_ALIASES, STEP_SETTING_NESTED_ALIASES, type StepSettings } from "../src/step/settings-manager.ts";
import { ThemeJsonSchema } from "../src/theme/theme-schema.ts";

const compileConfig = Compile(ConfigTomlSchema);
const compileModels = Compile(ModelsJsonSchema);
const compileTheme = Compile(ThemeJsonSchema);

type JsonSchema = { properties?: Record<string, JsonSchema>; type?: string };
const configProperties = (ConfigTomlSchema as JsonSchema).properties ?? {};

function hasKey(schema: JsonSchema, path: readonly string[]): boolean {
	let node: JsonSchema | undefined = schema;
	for (const part of path) {
		node = node?.properties?.[part];
		if (!node) return false;
	}
	return true;
}

describe("config.toml schema", () => {
	// The loaders accept a flat key and two nested spellings for the same
	// product setting. The schema has to accept every one of them, or an editor
	// rejects a file the product still reads.
	test("accepts every alias the settings manager honors", () => {
		const aliases: string[][] = [];
		for (const key of Object.keys(STEP_SETTING_ALIASES) as (keyof StepSettings)[]) {
			aliases.push([key]);
			for (const alias of STEP_SETTING_ALIASES[key]) aliases.push([alias]);
			for (const nested of STEP_SETTING_NESTED_ALIASES[key]) aliases.push([...nested]);
		}
		const missing = aliases.filter((path) => !hasKey(ConfigTomlSchema as JsonSchema, path));
		expect(missing).toEqual([]);
	});

	test("accepts a document that uses the documented tables", () => {
		const document = parseToml(`
defaultProvider = "step"
defaultModel = "step-5-preview"
permissionPreset = "approve-for-me"

[compaction]
triggerRatio = 0.9

[subagent]
background = true
background_timeout_seconds = 3600
max_concurrency = 8

[search]
provider = "auto"

[telemetry]
enabled = false

[mcp_servers.local]
command = "node"
args = ["server.js"]
`);
		expect(compileConfig.Check(document)).toBe(true);
	});

	test("rejects an unknown key instead of silently accepting a typo", () => {
		expect(compileConfig.Check({ compactionn: {} })).toBe(false);
		expect(compileConfig.Check({ compaction: { triggerRation: 0.9 } })).toBe(false);
	});

	test("rejects a value the settings manager would discard", () => {
		expect(compileConfig.Check({ compaction: { triggerRatio: 5 } })).toBe(false);
		expect(compileConfig.Check({ subagent: { background_timeout_seconds: 10 } })).toBe(false);
		expect(compileConfig.Check({ search: { provider: "not-a-backend" } })).toBe(false);
	});

	test("documents every top-level settings key in the schema", () => {
		// A key the runtime reads but the schema omits would make the editor
		// report a valid configuration as invalid.
		const documented = Object.keys(configProperties);
		expect(documented).toContain("defaultProvider");
		expect(documented).toContain("compaction");
		expect(documented).toContain("mcp_servers");
		expect(new Set(documented).size).toBe(documented.length);
	});
});

describe("models.json schema", () => {
	test("accepts a provider with models and editable metadata", () => {
		const document = {
			$schema: "./models.schema.json",
			providers: {
				local: {
					name: "Local",
					baseUrl: "http://127.0.0.1:8000/v1",
					apiKey: "unused",
					api: "openai-completions",
					models: [{ id: "local-model", contextWindow: 128000, maxTokens: 8192 }],
				},
			},
		};
		expect(compileModels.Check(document)).toBe(true);
	});

	test("still requires providers", () => {
		expect(compileModels.Check({})).toBe(false);
	});
});

describe("committed schema files", () => {
	test("match the definitions the runtime loads through", () => {
		const dir = join(import.meta.dirname, "..", "schema");
		expect(readFileSync(join(dir, "config.schema.json"), "utf8")).toBe(renderConfigSchema());
		expect(readFileSync(join(dir, MODELS_SCHEMA_FILE_NAME), "utf8")).toBe(renderStrictModelsSchema());
	});
});

describe("theme schema", () => {
	const themeDir = join(import.meta.dirname, "..", "src", "theme");

	test("is generated from the schema the theme loader compiles", () => {
		expect(readFileSync(join(themeDir, "theme-schema.json"), "utf8")).toBe(renderThemeSchema());
	});

	test("every built-in theme resolves its editor schema beside itself", () => {
		const files = readdirSync(themeDir).filter((name) => name.endsWith(".json") && name !== "theme-schema.json");
		expect(files.length).toBeGreaterThan(3);
		for (const name of files) {
			const theme = JSON.parse(readFileSync(join(themeDir, name), "utf8")) as { $schema?: string; name: string };
			// A relative path cannot rot the way a repository URL does.
			expect(theme.$schema, name).toBe("./theme-schema.json");
		}
	});

	test("every built-in theme satisfies the schema", () => {
		const check = compileTheme;
		const files = readdirSync(themeDir).filter((name) => name.endsWith(".json") && name !== "theme-schema.json");
		for (const name of files) {
			const theme = JSON.parse(readFileSync(join(themeDir, name), "utf8")) as unknown;
			expect(
				check.Errors(theme).map((error) => `${error.instancePath} ${error.message}`),
				name,
			).toEqual([]);
		}
	});
});

describe("files the product writes", () => {
	// A file Step writes itself must satisfy the schema it ships. A new
	// product-owned key that nobody added to the schema would otherwise make an
	// editor report a false error on a freshly written config.
	test("a config.toml written by the product validates against the schema", async () => {
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { markStepMcpImportSourcesReviewed } = await import("../src/step/mcp-import-store.ts");
		const { updateGlobalMcpConfig } = await import("../src/step/config-toml.ts");
		const root = await mkdtemp(join(tmpdir(), "step-schema-write-"));
		const env = { STEP_CODING_AGENT_DIR: join(root, "agent"), HOME: join(root, "home") };
		try {
			updateGlobalMcpConfig(env, () => ({ local: { command: "node", args: ["server.js"] } }));
			markStepMcpImportSourcesReviewed([".claude"], env);

			const written = parseToml(readFileSync(join(root, "config.toml"), "utf8"));
			const errors = compileConfig.Check(written) ? [] : compileConfig.Errors(written);
			expect(errors.map((error) => `${error.instancePath} ${error.message}`)).toEqual([]);
			expect(written.mcp_import).toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

type JsonSchemaNode = {
	readonly description?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly properties?: Record<string, JsonSchemaNode>;
};

/** One property node of the generated document, by dotted path. */
function schemaNode(path: readonly string[]): JsonSchemaNode | undefined {
	let node: JsonSchemaNode | undefined = ConfigTomlSchema as unknown as JsonSchemaNode;
	for (const part of path) node = node?.properties?.[part];
	return node;
}

describe("schema values follow the constants the runtime reads", () => {
	// Regenerating the schema catches a changed key. This catches a changed
	// number: the schema's default and bounds are copied by hand into a
	// description, so nothing else would notice the constant moving.
	function numericBounds(path: readonly string[]): { minimum?: number; maximum?: number } {
		const node = schemaNode(path);
		return { minimum: node?.minimum, maximum: node?.maximum };
	}

	test("compaction.triggerRatio bounds match MIN/MAX_COMPACTION_TRIGGER_RATIO", () => {
		expect(numericBounds(["compaction", "triggerRatio"])).toEqual({
			minimum: MIN_COMPACTION_TRIGGER_RATIO,
			maximum: MAX_COMPACTION_TRIGGER_RATIO,
		});
	});

	test("the documented default equals DEFAULT_COMPACTION_TRIGGER_RATIO", () => {
		const description = schemaNode(["compaction", "triggerRatio"])?.description;
		expect(description).toContain(`default ${DEFAULT_COMPACTION_TRIGGER_RATIO}`);
	});

	test("autoClm fields are integers, as resolveAutoClmSettings requires", () => {
		const schema = ConfigTomlSchema as unknown as {
			properties: {
				compaction: { properties: { autoClm: { properties: Record<string, { type?: string }> } } };
			};
		};
		const fields = schema.properties.compaction.properties.autoClm.properties;
		const nonInteger = Object.entries(fields)
			// `enabled` is a boolean and the two ratios are fractions.
			.filter(
				([name, node]) =>
					!["enabled", "softThresholdRatio", "minSavingsRatio"].includes(name) && node.type !== "integer",
			)
			.map(([name]) => name);
		expect(nonInteger).toEqual([]);
	});

	test("rateLimitMaxRetries matches the clamp in getRetrySettings", () => {
		expect(numericBounds(["retry", "rateLimitMaxRetries"])).toEqual({ minimum: 0, maximum: 20 });
	});

	// The description states the number instead of importing the constant, so the
	// schema module stays free of the HTTP stack. This keeps the two in step.
	test("httpIdleTimeoutMs documents DEFAULT_HTTP_IDLE_TIMEOUT_MS", () => {
		expect(schemaNode(["httpIdleTimeoutMs"])?.description).toContain(String(DEFAULT_HTTP_IDLE_TIMEOUT_MS));
	});

	test("editorPaddingX and autocompleteMaxVisible match the ranges their setters clamp to", () => {
		// `setEditorPaddingX` clamps 0-3 and `setAutocompleteMaxVisible` 3-20; the
		// getters do not, so the schema is the only guard on a hand-edited file.
		expect(numericBounds(["editorPaddingX"])).toEqual({ minimum: 0, maximum: 3 });
		expect(numericBounds(["autocompleteMaxVisible"])).toEqual({ minimum: 3, maximum: 20 });
	});
});

describe("mcp_servers entries", () => {
	// `normalizeDeclaration` in mcp.ts reads exactly these fields. A field added
	// there but not to the schema would make the editor reject a working entry,
	// and the other way round would let a key through that is never read.
	test("the schema covers every field the MCP loader reads", async () => {
		const source = readFileSync(join(import.meta.dirname, "..", "src", "step", "mcp.ts"), "utf8");
		const normalized = source.slice(
			source.indexOf("function normalizeDeclaration"),
			source.indexOf("export async function connectStepMcpServer"),
		);
		const readFields = [...normalized.matchAll(/declaration\.([a-z_]+) =/g)].map((match) => match[1]!);
		expect(readFields.length).toBeGreaterThan(5);

		const mcpSchema = (
			ConfigTomlSchema as unknown as {
				properties: { mcp_servers: { patternProperties: Record<string, { properties: Record<string, unknown> }> } };
			}
		).properties.mcp_servers;
		const server = Object.values(mcpSchema.patternProperties)[0]!;
		const missing = [...new Set(readFields)].filter((field) => !(field in server.properties));
		expect(missing).toEqual([]);
	});
});

describe("legacy keys are part of the schema", () => {
	// `migrateSettings` rewrites these before any read, so a file that still uses
	// them works. The schema has to list them or the editor flags a valid file.
	test.each(["queueMode", "websockets"])("%s is in the schema", (key) => {
		expect(schemaNode([key])).toBeDefined();
	});

	test("retry.maxDelayMs is in the schema", () => {
		expect(schemaNode(["retry", "maxDelayMs"])).toBeDefined();
	});

	// `migrateSettings` rewrites this shape into an array plus a boolean, so a
	// file that still uses it loads. Without it here the editor would call that
	// file invalid.
	test("the older [skills] table is accepted alongside the array", () => {
		const skills = schemaNode(["skills"]) as unknown as { anyOf?: unknown[] } | undefined;
		expect(skills?.anyOf?.length).toBe(2);
		expect(compileConfig.Check({ skills: { customDirectories: ["/tmp/x"] } })).toBe(true);
		expect(compileConfig.Check({ skills: ["/tmp/x"] })).toBe(true);
	});
});

describe("the models.json editor schema only adds strictness", () => {
	// The strict copy exists so a misspelled provider field is visible. If it
	// ever diverges from the loader's shape for another reason, the editor would
	// describe a different file than the runtime reads.
	type Node = Record<string, unknown>;

	/** Every path where `additionalProperties: false` was added. */
	function addedClosures(permissive: unknown, closed: unknown, path: string[] = []): string[] {
		if (typeof permissive !== "object" || permissive === null || typeof closed !== "object" || closed === null) {
			return [];
		}
		const a = permissive as Node;
		const b = closed as Node;
		const found: string[] = [];
		if (a.additionalProperties === undefined && b.additionalProperties === false) found.push(path.join(".") || "/");

		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys) {
			if (key === "additionalProperties") continue;
			found.push(...addedClosures(a[key], b[key], [...path, key]));
		}
		return found;
	}

	/** The two trees with those flags removed, which must then be identical. */
	function withoutClosures(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(withoutClosures);
		if (typeof value !== "object" || value === null) return value;
		return Object.fromEntries(
			Object.entries(value as Node)
				.filter(([key, entry]) => !(key === "additionalProperties" && entry === false))
				.map(([key, entry]) => [key, withoutClosures(entry)]),
		);
	}

	test("differs from the loader's shape only by additionalProperties: false", () => {
		expect(withoutClosures(ClosedModelsJsonSchema)).toEqual(withoutClosures(PermissiveModelsJsonSchema));
	});

	test("closes provider and model objects", () => {
		const closed = addedClosures(PermissiveModelsJsonSchema, ClosedModelsJsonSchema);
		expect(closed.some((path) => path.includes("providers"))).toBe(true);
	});

	test("leaves a declared record open", () => {
		// `samplingParams` is `Record<string, unknown>`; its keys are data, so a
		// closed object there would reject every sampling parameter.
		const schema = ClosedModelsJsonSchema as unknown as {
			properties: {
				providers: {
					patternProperties: Record<
						string,
						{
							properties: {
								models: { items: { properties: Record<string, { additionalProperties?: unknown }> } };
							};
						}
					>;
				};
			};
		};
		const provider = Object.values(schema.properties.providers.patternProperties)[0]!;
		const model = provider.properties.models.items;
		expect(model.properties.samplingParams?.additionalProperties).not.toBe(false);
		expect(model.properties.headers?.additionalProperties).not.toBe(false);
	});
});

describe("the accepted configuration surface is pinned", () => {
	/**
	 * The schema is generated from the TypeBox definitions, so deleting a field
	 * there removes it from the schema in the same commit and
	 * `check:config-schema` still passes. That makes an accidental removal look
	 * like an intentional one: replacing `model-config.ts` during a branch sync
	 * once dropped a desktop-only field, and nothing failed until the generated
	 * schema was compared by hand.
	 *
	 * These lists are the independent record. Removing a field from the product
	 * means removing it here too, on purpose.
	 */
	const MODELS_SURFACE = {
		provider: ["api", "apiKey", "authHeader", "baseUrl", "compat", "headers", "modelOverrides", "models", "name"],
		model: [
			"api",
			"baseUrl",
			"compat",
			"contextWindow",
			"cost",
			"headers",
			"id",
			"input",
			"maxTokens",
			"name",
			"reasoning",
			"samplingParams",
			"thinkingLevelMap",
		],
		modelOverride: [
			"compat",
			"contextWindow",
			"cost",
			"headers",
			"input",
			"maxTokens",
			"name",
			"reasoning",
			"samplingParams",
			"thinkingLevelMap",
		],
	};

	/** The same lists, read back out of the committed schema. */
	function modelsSurface(): typeof MODELS_SURFACE {
		const schema = ClosedModelsJsonSchema as unknown as {
			properties: {
				providers: {
					patternProperties: Record<
						string,
						{
							properties: {
								models: { items: { properties: Record<string, unknown> } };
								modelOverrides: { patternProperties: Record<string, { properties: Record<string, unknown> }> };
								[key: string]: unknown;
							};
						}
					>;
				};
			};
		};
		const provider = Object.values(schema.properties.providers.patternProperties)[0]!;
		const override = Object.values(provider.properties.modelOverrides.patternProperties)[0]!;
		return {
			provider: Object.keys(provider.properties).sort(),
			model: Object.keys(provider.properties.models.items.properties).sort(),
			modelOverride: Object.keys(override.properties).sort(),
		};
	}

	test("models.json keeps every provider, model and override field", () => {
		const actual = modelsSurface();
		expect(actual.provider).toEqual([...MODELS_SURFACE.provider].sort());
		expect(actual.model).toEqual([...MODELS_SURFACE.model].sort());
		expect(actual.modelOverride).toEqual([...MODELS_SURFACE.modelOverride].sort());
	});

	test("the telemetry table keeps every field a host reads", () => {
		// `readGlobalStepDefaults` reads these three out of `[telemetry]`.
		const telemetry = (
			ConfigTomlSchema as unknown as {
				properties: { telemetry: { properties: Record<string, unknown> } };
			}
		).properties.telemetry;
		expect(Object.keys(telemetry.properties).sort()).toEqual(["enabled", "endpoint", "spool"]);
	});
});

describe("hand-written declarations agree with the schema", () => {
	// `StepMcpServerConfig` is written by hand next to the loader. A field can be
	// declared, documented and read while the schema does not know it, which is
	// what happened to `transport`, `shared` and `stepcode_source`: the docs
	// showed `shared = false` and `config check` rejected it.
	test("StepMcpServerConfig declares nothing the schema lacks", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "src", "step", "config-toml.ts"), "utf8");
		const start = source.indexOf("export interface StepMcpServerConfig {");
		expect(start).toBeGreaterThan(0);
		const body = source.slice(start, source.indexOf("\n}", start));
		const declared = [...body.matchAll(/^\t([a-z_]+)\??:/gm)].map((match) => match[1]!);
		expect(declared.length).toBeGreaterThan(10);

		const mcp = (
			ConfigTomlSchema as unknown as {
				properties: { mcp_servers: { patternProperties: Record<string, { properties: Record<string, unknown> }> } };
			}
		).properties.mcp_servers;
		const server = Object.values(mcp.patternProperties)[0]!;
		expect(declared.filter((field) => !(field in server.properties))).toEqual([]);
	});

	test("every top-level key a loader reads is in the schema", () => {
		// `readGlobalStepDefaults`, the search tool and MCP discovery read the
		// document by name instead of through the settings schema, so a key they
		// read has to be listed for the editor to accept it.
		const dir = join(import.meta.dirname, "..", "src", "step");
		const read = new Set<string>();
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.includes(".test."))) {
			const source = readFileSync(join(dir, file), "utf8");
			for (const match of source.matchAll(/\bdocument\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) read.add(match[1]!);
		}
		expect(read.size).toBeGreaterThan(2);
		expect([...read].filter((key) => !(key in configProperties))).toEqual([]);
	});
});
