/**
 * Write and refresh the editor schemas for `config.toml` and `models.json`.
 *
 * The committed schemas live in `packages/coding-agent/schema/`. At runtime both
 * files are rendered from the same TypeBox definitions the loaders use and
 * written next to the configuration files, so a file can reference them by a
 * relative path (`#:schema ./config.schema.json` in TOML,
 * `"$schema": "./models.schema.json"` in JSON).
 *
 * Nothing is fetched over the network and no URL is published: an editor
 * validates against the same build that wrote the file, and a schema change
 * ships as a normal code change instead of a separately versioned contract.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CONFIG_SCHEMA_FILE_NAME,
	MODELS_SCHEMA_FILE_NAME,
	renderConfigSchema,
	renderStrictModelsSchema,
} from "./config-schema.ts";

export interface SchemaFile {
	readonly fileName: string;
	readonly content: string;
}

/** The generated schemas in the order they are written. */
export function schemaFiles(): readonly SchemaFile[] {
	return [
		{ fileName: CONFIG_SCHEMA_FILE_NAME, content: renderConfigSchema() },
		{ fileName: MODELS_SCHEMA_FILE_NAME, content: renderStrictModelsSchema() },
	];
}

/**
 * Write both schemas into `root`, replacing a file only when its content
 * changed so a no-op run leaves modification times alone. Returns the paths
 * that were written or already current; a path missing from the result could
 * not be written.
 *
 * A read-only or otherwise unwritable directory is not fatal: the schemas are
 * an editor aid, and a failing launch would be a worse outcome than a missing
 * hint. Callers that must report the failure use the returned value.
 */
export function writeSchemaFiles(root: string): string[] {
	const written: string[] = [];
	for (const file of schemaFiles()) {
		const path = join(root, file.fileName);
		if (existsSync(path)) {
			let current: string | undefined;
			try {
				current = readFileSync(path, "utf8");
			} catch {
				current = undefined;
			}
			if (current === file.content) {
				written.push(path);
				continue;
			}
		}
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, file.content, { encoding: "utf8", mode: 0o644 });
			renameSync(temporary, path);
		} catch {
			// Best effort; see the doc comment.
			continue;
		}
		written.push(path);
	}
	return written;
}

/**
 * Keep the copies next to the configuration files current. Called when the
 * config file is created and on every launch, so `step update` refreshes them
 * without a separate step.
 */
export function refreshSchemaFiles(root: string): string[] {
	return writeSchemaFiles(root);
}

/** The TOML header directive that points an editor at the adjacent schema. */
export function configSchemaDirective(): string {
	return `#:schema ./${CONFIG_SCHEMA_FILE_NAME}`;
}
