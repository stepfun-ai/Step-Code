import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import { ConfigTomlSchema, ModelsJsonSchema } from "../src/step/config-schema.ts";

const packageRoot = join(import.meta.dirname, "..");
const repoRoot = join(packageRoot, "..", "..");
const compileConfig = Compile(ConfigTomlSchema);
const compileModels = Compile(ModelsJsonSchema);

/**
 * Documentation files whose TOML blocks are StepCode configuration.
 *
 * A block in one of these files is validated against the shipped schema, so a
 * documented key or value that the runtime would reject fails here instead of
 * being copied by a reader. Files that show another product's TOML are listed
 * below and skipped; adding one is a deliberate edit, not a silent opt-out.
 */
const CONFIG_DOCS = [
	join(packageRoot, "docs", "settings.md"),
	join(packageRoot, "docs", "compaction.md"),
	join(packageRoot, "docs", "context-management.md"),
	join(repoRoot, "docs", "step-configuration.md"),
	join(repoRoot, "docs", "step-unified-config-and-mcp.md"),
];

/** TOML blocks in these files belong to another tool, not to StepCode. */
const EXTERNAL_TOML_DOCS = [join(packageRoot, "docs", "terminal-setup.md")];

interface Block {
	readonly file: string;
	readonly line: number;
	readonly body: string;
}

function tomlBlocks(file: string): Block[] {
	const text = readFileSync(file, "utf8");
	const blocks: Block[] = [];
	const pattern = /```toml\n([\s\S]*?)```/g;
	for (const match of text.matchAll(pattern)) {
		const line = text.slice(0, match.index).split("\n").length;
		blocks.push({ file: relative(repoRoot, file), line, body: match[1]! });
	}
	return blocks;
}

describe("documented configuration examples", () => {
	const blocks = CONFIG_DOCS.flatMap(tomlBlocks);

	test("there are examples to validate", () => {
		expect(blocks.length).toBeGreaterThan(5);
	});

	test.each(blocks)("$file:$line parses and matches the config schema", (block) => {
		let document: unknown;
		try {
			document = parseToml(block.body);
		} catch (error) {
			throw new Error(`${block.file}:${block.line} is not valid TOML: ${(error as Error).message}`);
		}
		const errors = compileConfig.Check(document) ? [] : compileConfig.Errors(document);
		expect(
			errors.map((error) => `${error.instancePath || "/"} ${error.message}`),
			`${block.file}:${block.line}`,
		).toEqual([]);
	});

	test("files showing another product's TOML stay excluded from this check", () => {
		for (const file of EXTERNAL_TOML_DOCS) expect(tomlBlocks(file).length).toBeGreaterThan(0);
	});
});

describe("settings documentation covers the schema", () => {
	/**
	 * Keys the product writes itself and a reader should not configure. They are
	 * still in the schema so a file containing one stays valid.
	 */
	const INTERNAL_KEYS = new Set(["lastChangelogVersion"]);

	const allTopLevelKeys = Object.keys((ConfigTomlSchema as { properties: Record<string, unknown> }).properties);
	const settingsDoc = readFileSync(join(packageRoot, "docs", "settings.md"), "utf8");

	test("every configurable top-level key is documented", () => {
		const undocumented = allTopLevelKeys.filter(
			(key) => !INTERNAL_KEYS.has(key) && !settingsDoc.includes(`\`${key}`),
		);
		expect(undocumented).toEqual([]);
	});

	test("every documented setting row exists in the schema", () => {
		const rows = [...settingsDoc.matchAll(/^\| `([a-zA-Z0-9_.]+)`/gm)].map((match) => match[1]!);
		expect(rows.length).toBeGreaterThan(60);

		const properties = (ConfigTomlSchema as { properties: Record<string, JsonSchema> }).properties;
		const missing = [...new Set(rows)].filter((key) => {
			let node: JsonSchema | undefined = { properties };
			for (const part of key.split(".")) {
				node = node?.properties?.[part];
				if (!node) return true;
			}
			return false;
		});
		expect(missing).toEqual([]);
	});

	test("the documented settings file is config.toml, not a JSON settings file", () => {
		expect(settingsDoc).toContain("~/.stepcode/config.toml");
		expect(settingsDoc).not.toContain("agent/settings.json");
	});
});

describe("models documentation", () => {
	test("the models.json schema accepts a documented provider entry", () => {
		const document = {
			providers: {
				local: {
					name: "Local",
					baseUrl: "http://127.0.0.1:8000/v1",
					api: "openai-completions",
					models: [{ id: "local-model", contextWindow: 128000 }],
				},
			},
		};
		expect(compileModels.Check(document)).toBe(true);
	});

	test("the models doc points at the schema shipped beside the file", () => {
		const text = readFileSync(join(packageRoot, "docs", "models.md"), "utf8");
		expect(text).toContain("models.schema.json");
		expect(dirname(join(packageRoot, "docs"))).toBe(packageRoot);
	});
});

interface JsonSchema {
	properties?: Record<string, JsonSchema>;
}

describe("documented defaults match the schema", () => {
	/**
	 * Every numeric default is written twice: once in the schema description
	 * (which an editor shows) and once in the docs table. Regenerating the schema
	 * does not catch a hand-edited number, so this compares them.
	 */
	function schemaDescription(path: readonly string[]): string | undefined {
		let node: JsonSchema | undefined = ConfigTomlSchema as unknown as JsonSchema;
		for (const part of path) node = node?.properties?.[part];
		return (node as { description?: string } | undefined)?.description;
	}

	const documentedDefaults: Array<{ key: readonly string[]; docDefault: string }> = [
		{ key: ["compaction", "triggerRatio"], docDefault: "0.9" },
		{ key: ["compaction", "keepRecentTokens"], docDefault: "20000" },
		{ key: ["compaction", "reserveTokens"], docDefault: "16384" },
		{ key: ["branchSummary", "reserveTokens"], docDefault: "16384" },
		{ key: ["retry", "maxRetries"], docDefault: "3" },
		{ key: ["retry", "baseDelayMs"], docDefault: "2000" },
		{ key: ["editorPaddingX"], docDefault: "0" },
		{ key: ["autocompleteMaxVisible"], docDefault: "5" },
		{ key: ["terminal", "imageWidthCells"], docDefault: "60" },
		{ key: ["subagent", "max_concurrency"], docDefault: "8" },
		{ key: ["subagent", "background_timeout_seconds"], docDefault: "3600" },
	];

	test.each(documentedDefaults)("$key default appears in the schema description", ({ key, docDefault }) => {
		expect(schemaDescription(key), key.join(".")).toContain(docDefault);
	});

	test("the settings table default column agrees with the schema description", () => {
		const settingsDoc = readFileSync(join(packageRoot, "docs", "settings.md"), "utf8");
		const rows = [...settingsDoc.matchAll(/^\| `([a-zA-Z0-9_.]+)` \| [^|]+ \| ([^|]+) \|/gm)];
		const mismatched: string[] = [];
		for (const [, key, rawDefault] of rows) {
			const expected = documentedDefaults.find((entry) => entry.key.join(".") === key);
			if (!expected) continue;
			const documented = rawDefault!.trim().replace(/`/g, "");
			if (documented !== expected.docDefault) {
				mismatched.push(`${key}: table says ${documented}, schema says ${expected.docDefault}`);
			}
		}
		expect(mismatched).toEqual([]);
	});
});
