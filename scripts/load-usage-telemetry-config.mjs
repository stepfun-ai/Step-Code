#!/usr/bin/env node

// Loads the usage-telemetry configuration that build steps embed.
//
// The config is one YAML document, identical for test and release builds. It is
// committed at `config/usage-telemetry.yaml`: the public tree carries it with no
// values (every key commented out), so public builds report nothing, and the
// internal main fills in the collector and the internal gateway hosts. The
// loading logic is the same on both sides; only that file's contents differ.
// `STEPCODE_USAGE_TELEMETRY_CONFIG` may point at another file (a GitLab *File*
// variable works this way) to override it for one job without editing the repo.
//
// The output is a compact JSON object on stdout, empty (`{}`) when no file is
// present. Build steps pass it to the runtime as
// `STEPCODE_BUILD_USAGE_TELEMETRY`, which the bundles inline.
//
// A malformed known field fails the build instead of silently disabling
// reporting: the failure mode we cannot afford is a release that looks fine and
// sends nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export const USAGE_TELEMETRY_CONFIG_PATH = "config/usage-telemetry.yaml";
export const USAGE_TELEMETRY_CONFIG_ENV = "STEPCODE_USAGE_TELEMETRY_CONFIG";
/** Bound on the embedded value; the runtime re-validates after parsing. */
export const MAX_CONFIG_BYTES = 4096;
const MAX_HOSTS = 64;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve, parse, and validate the config. Returns `{}` when no file exists.
 * Unknown top-level keys are preserved so a newer config can reach a newer
 * build without changing this script.
 */
export function readUsageTelemetryConfig(options = {}) {
	const explicit = options.file ?? process.env[USAGE_TELEMETRY_CONFIG_ENV]?.trim();
	const path = explicit ? resolve(options.cwd ?? process.cwd(), explicit) : resolve(repoRoot, USAGE_TELEMETRY_CONFIG_PATH);
	if (!existsSync(path)) {
		if (options.require === true) throw new Error(`usage telemetry config not found: ${path}`);
		return {};
	}
	const text = readFileSync(path, "utf8");
	let parsed;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new Error(`${path}: not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	const config = normalizeConfig(parsed, path);
	if (Buffer.byteLength(JSON.stringify(config), "utf8") > MAX_CONFIG_BYTES) {
		throw new Error(`${path}: config exceeds ${MAX_CONFIG_BYTES} bytes once serialized`);
	}
	return config;
}

/** Validate the known fields and keep the rest for forward compatibility. */
export function normalizeConfig(value, source = "config") {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: expected a mapping at the top level`);
	const config = { ...value };
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		throw new Error(`${source}: enabled must be true or false`);
	}
	if (config.endpoint !== undefined) {
		if (typeof config.endpoint !== "string") throw new Error(`${source}: endpoint must be a string`);
		if (!config.endpoint.trim()) {
			// An empty value means "not configured", the public default.
			delete config.endpoint;
		} else {
			let url;
			try {
				url = new URL(config.endpoint.trim());
			} catch {
				throw new Error(`${source}: endpoint is not a URL`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${source}: endpoint must be http(s)`);
			if (url.username || url.password) throw new Error(`${source}: endpoint must not embed credentials`);
			config.endpoint = url.toString();
		}
	}
	if (config.internalProviderHosts !== undefined) {
		const hosts = Array.isArray(config.internalProviderHosts)
			? config.internalProviderHosts
			: typeof config.internalProviderHosts === "string"
				? config.internalProviderHosts.split(",")
				: undefined;
		if (!hosts) throw new Error(`${source}: internalProviderHosts must be a list or a comma-separated string`);
		const normalized = [];
		for (const entry of hosts) {
			if (typeof entry !== "string") throw new Error(`${source}: internalProviderHosts entries must be strings`);
			const host = entry.trim().toLowerCase();
			if (!host) continue;
			if (!/^[a-z0-9.-]+$/u.test(host)) throw new Error(`${source}: invalid internal provider host "${entry}"`);
			if (!normalized.includes(host)) normalized.push(host);
		}
		if (normalized.length > MAX_HOSTS) throw new Error(`${source}: at most ${MAX_HOSTS} internal provider hosts`);
		if (normalized.length === 0) delete config.internalProviderHosts;
		else config.internalProviderHosts = normalized;
	}
	return config;
}

function isMain() {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
	const args = process.argv.slice(2);
	const fileIndex = args.indexOf("--file");
	try {
		const config = readUsageTelemetryConfig({
			...(fileIndex >= 0 ? { file: args[fileIndex + 1] } : {}),
			require: args.includes("--require"),
		});
		process.stdout.write(JSON.stringify(config));
	} catch (error) {
		process.stderr.write(`usage-telemetry config: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
