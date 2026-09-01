import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageRoot(fromUrl = import.meta.url) {
	return resolve(dirname(fileURLToPath(fromUrl)), "..");
}

export async function resolveStepEntrypoint(options = {}) {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const repoRoot = options.repoRoot ?? resolve(packageRoot, "../..");
	const argv = options.argv ?? process.argv.slice(2);
	const packageResolver = options.packageResolver ?? defaultPackageResolver;
	const sourceEntry = join(packageRoot, "src", "step-cli.ts");
	const bundleEntry = join(packageRoot, "dist", "bundle", "step.js");
	const tsconfigPath = join(repoRoot, "tsconfig.json");

	if ((await fileExists(sourceEntry)) && (await fileExists(tsconfigPath))) {
		const tsxPath = resolvePackagePath("tsx", repoRoot, packageResolver);
		if (tsxPath) {
			return {
				kind: "source",
				command: process.execPath,
				args: ["--import", tsxPath, sourceEntry, ...argv],
				env: { TSX_TSCONFIG_PATH: tsconfigPath },
			};
		}
	}

	if (await fileExists(bundleEntry)) {
		return {
			kind: "bundle",
			command: process.execPath,
			args: [bundleEntry, ...argv],
			env: {},
		};
	}

	throw new Error(
		`Unable to run Step. Checked source entry ${sourceEntry} and bundle entry ${bundleEntry}. ` +
			"Install workspace dependencies for source mode or build the coding-agent package.",
	);
}

export async function runResolvedEntrypoint(entrypoint, options = {}) {
	const child = spawn(entrypoint.command, entrypoint.args, {
		cwd: options.cwd ?? process.cwd(),
		env: { ...(options.env ?? process.env), ...entrypoint.env },
		stdio: "inherit",
	});

	await new Promise((resolvePromise, rejectPromise) => {
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}
			process.exitCode = code ?? 1;
			resolvePromise();
		});
	});
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function resolvePackagePath(specifier, repoRoot, packageResolver) {
	try {
		return packageResolver(specifier, repoRoot);
	} catch {
		return undefined;
	}
}

function defaultPackageResolver(specifier, repoRoot) {
	return createRequire(join(repoRoot, "package.json")).resolve(specifier);
}
