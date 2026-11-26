import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Guard what `cli/args.ts` pulls in at startup.
 *
 * Every invocation loads this module, including `--help`. A commit on this
 * branch once imported the config schema from it for one line of help text,
 * which took the process from ~25 to ~148 modules and added about half a second
 * to every command. Nothing failed in review; the first symptom was an
 * unrelated test's child process timing out.
 *
 * The import graph is read statically rather than measured, so the result does
 * not depend on the machine. Type-only imports are skipped: they are erased at
 * compile time and cost nothing at startup.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const ENTRY = resolve(packageRoot, "src/cli/args.ts");

/**
 * Modules the entry must never reach at runtime. Each one belongs to the config
 * subsystem, whose own entry point is `step config`, not every command.
 */
const FORBIDDEN_MODULES = [
	"src/step/config-schema.ts",
	"src/step/config-toml.ts",
	"src/step/command-compat.ts",
	"src/step/settings-manager.ts",
	"src/step/schema-files.ts",
	"src/step/subagent-limits.ts",
	"src/core/model-config.ts",
	"src/core/settings-manager.ts",
	"src/theme/theme.ts",
];

/** Packages the entry must never reach at runtime. */
const FORBIDDEN_PACKAGES = ["typebox", "smol-toml", "undici", "highlight.js"];

/** `main` sits at 8 files; the allowance is for an unrelated addition. */
const MAX_FILES = 12;

interface Graph {
	readonly files: string[];
	readonly packages: string[];
}

/** Follow runtime imports from `entry`, ignoring type-only ones. */
function runtimeImportGraph(entry: string): Graph {
	const files = new Set<string>();
	const packages = new Set<string>();

	const walk = (file: string): void => {
		if (files.has(file)) return;
		files.add(file);

		const source = readFileSync(file, "utf8");
		// `import type` / `export type` are erased at compile time.
		const runtime = source.replace(/(?:^|\n)\s*(?:import|export)\s+type\s[^;]*?;/g, "\n");

		// `import "./x.ts"` has no `from`, and `import()` is an expression; a graph
		// that only follows `from` would miss both.
		const specifiers = [
			...runtime.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g),
			...runtime.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g),
			...runtime.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
		].map((match) => match[1]!);

		for (const specifier of specifiers) {
			if (!specifier.startsWith(".")) {
				packages.add(specifier);
				continue;
			}
			const base = resolve(dirname(file), specifier);
			const resolved = [base, `${base}.ts`, `${base}/index.ts`].find(
				(candidate) => candidate.endsWith(".ts") && existsSync(candidate),
			);
			if (resolved) walk(resolved);
		}
	};

	walk(entry);
	return { files: [...files], packages: [...packages] };
}

describe("cli/args.ts startup import graph", () => {
	const graph = runtimeImportGraph(ENTRY);

	test("does not reach the config subsystem", () => {
		const paths = graph.files.map((file) => relative(packageRoot, file));
		const reached = FORBIDDEN_MODULES.filter((module) => paths.includes(module));
		expect(reached, "cli/args.ts must not import these at runtime").toEqual([]);
	});

	test("does not pull in a heavy package", () => {
		const reached = FORBIDDEN_PACKAGES.filter((name) =>
			graph.packages.some((specifier) => specifier === name || specifier.startsWith(`${name}/`)),
		);
		expect(reached, "cli/args.ts must not import these at runtime").toEqual([]);
	});

	test("stays within the file budget", () => {
		const paths = graph.files.map((file) => relative(packageRoot, file));
		expect(paths.length, `cli/args.ts reaches ${paths.length} files:\n${paths.join("\n")}`).toBeLessThanOrEqual(
			MAX_FILES,
		);
	});
});
