#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
// The process entry moved to the @step-harness/cli app (S3). The bundle's `step`
// entry is that app's compiled main; the `index` library entry stays here. The
// package directory is parameterised so a future move only touches this const.
const appEntryDir = join(repoRoot, "apps", "cli");
const appEntryDistDir = join(appEntryDir, "dist");
const aiDir = join(repoRoot, "packages", "providers");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const stepBuildDefines = readStepBuildDefines();
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@silvia-odwyer/photon-node",
	"jiti",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Workflow's isolated runtime is a native optional dependency loaded at runtime.
	"isolated-vm",
	// Optional debug output coloring.
	"supports-color",
]);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: aiDir,
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { STEP_BUNDLED_NODE: "true", ...stepBuildDefines },
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source uses jiti/static so Bun embeds its Babel transform. The Node
		// package replaces it with a synchronous lazy require so jiti loads only
		// when importing an extension; Babel remains deferred until a cache miss
		// needs transformation.
		plugins: [lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

/**
 * Embed release identity in the Step bundle. Esbuild does not inherit Bun's
 * compile-time environment substitution, so a Node-installed `step` package
 * would otherwise fall back to the Pi package version (or to a stale runtime
 * environment) after publishing. Keep the defines conditional so local builds
 * still allow explicit runtime overrides.
 */
function readStepBuildDefines() {
	const defines = {};
	const version = process.env.STEPCODE_BUILD_VERSION;
	const channel = process.env.STEPCODE_BUILD_CHANNEL;
	const commit = process.env.STEPCODE_BUILD_COMMIT;
	const feedbackEndpoint = process.env.STEPCODE_FEEDBACK_ENDPOINT;
	const feedbackBundleEndpoint = process.env.STEPCODE_FEEDBACK_BUNDLE_ENDPOINT;
	const aliases = [
		["STEPCODE_BUILD_VERSION", version],
		["STEPCODE_BUILD_CHANNEL", channel],
		["STEPCODE_BUILD_COMMIT", commit],
		["STEPCODE_FEEDBACK_ENDPOINT", feedbackEndpoint],
		["STEPCODE_FEEDBACK_BUNDLE_ENDPOINT", feedbackBundleEndpoint],
	];
	for (const [name, value] of aliases) {
		if (typeof value === "string" && value.trim()) {
			defines[`process.env.${name}`] = JSON.stringify(value.trim());
		}
	}
	return defines;
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

// The bundle's `step` entry is the compiled app. Compile it here (against the
// coding-agent dist produced by build:unbundled) so coding-agent's `build`
// stays self-contained despite the entry now living in the app package. Always
// rebuild rather than trusting a pre-existing dist/main.js: a stale app compile
// from an earlier checkout would otherwise be baked into the bundle.
execFileSync("npm", ["--prefix", appEntryDir, "run", "build"], { stdio: "inherit", cwd: repoRoot });

for (const entry of [
	join(appEntryDistDir, "main.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		step: join(appEntryDistDir, "main.js"),
		index: join(codingAgentDistDir, "index.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");

// The image-resize worker is reached through a worker URL, so the main bundle
// cannot follow it. Emit a self-contained worker file beside the code that
// resolves it (the image-resize implementation).
const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	},
	outdir: dirname(imageResizeOutput),
	splitting: false,
});

validateExternalImports([mainResult.metafile, lazyResult.metafile]);
chmodSync(join(bundleDir, "step.js"), 0o755);

const files = new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size;
const mib = outputBytes([mainResult.metafile, lazyResult.metafile]) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
