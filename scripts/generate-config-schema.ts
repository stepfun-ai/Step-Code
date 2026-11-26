#!/usr/bin/env tsx
/**
 * Write the editor schemas that ship with the binary.
 *
 * The schemas are generated from the TypeBox definitions the runtime loads
 * through, so they are committed instead of hand-maintained. `--check` verifies
 * the committed files without writing, and is run by `pnpm check`, so a change
 * to a settings key cannot land with a stale schema.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	renderConfigSchema,
	renderStrictModelsSchema,
	renderThemeSchema,
} from "../packages/coding-agent/src/step/config-schema.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(repoRoot, "packages/coding-agent/schema");

const files = [
	{ path: join(schemaDir, "config.schema.json"), content: renderConfigSchema() },
	{ path: join(schemaDir, "models.schema.json"), content: renderStrictModelsSchema() },
	// Shipped beside the built-in themes, which reference it as ./theme-schema.json.
	{ path: join(repoRoot, "packages/coding-agent/src/theme/theme-schema.json"), content: renderThemeSchema() },
];

const check = process.argv.includes("--check");
let failed = false;

for (const file of files) {
	let current: string | undefined;
	try {
		current = readFileSync(file.path, "utf8");
	} catch {
		current = undefined;
	}
	const label = relative(repoRoot, file.path);

	if (check) {
		if (current === file.content) {
			console.log(`ok ${label}`);
			continue;
		}
		failed = true;
		console.error(
			current === undefined
				? `missing ${label}`
				: `stale ${label}: regenerate with \`pnpm run generate:config-schema\``,
		);
		continue;
	}

	if (current === file.content) {
		console.log(`unchanged ${label}`);
		continue;
	}
	writeFileSync(file.path, file.content, "utf8");
	console.log(`wrote ${label}`);
}

if (failed) process.exit(1);
