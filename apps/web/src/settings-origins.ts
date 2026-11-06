import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { InstalledStepPlugin, MarketplacePluginEntry, MarketplaceSource } from "@step-harness/coding-agent";

export type ResourceOrigin = "market" | "custom" | "stepcode" | "plugin";

/** Origin is presentation metadata, never a permission or safety verdict. */
async function directorySignature(root: string): Promise<string | undefined> {
	const hash = createHash("sha256");
	let entries = 0;
	let bytes = 0;
	const visit = async (directory: string, depth: number): Promise<boolean> => {
		if (depth > 8 || !(await lstat(directory)).isDirectory()) return false;
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (++entries > 512) return false;
			const path = join(directory, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) return false;
			hash.update(`${relative(root, path)}\0`);
			if (info.isDirectory()) {
				hash.update("directory\0");
				if (!(await visit(path, depth + 1))) return false;
			} else if (info.isFile()) {
				bytes += info.size;
				if (info.size > 512 * 1024 || bytes > 8 * 1024 * 1024) return false;
				hash.update(`file:${info.size}\0`);
				hash.update(await readFile(path));
			} else return false;
		}
		return true;
	};
	try {
		if ((await lstat(root)).isSymbolicLink()) return undefined;
		return (await visit(root, 0)) ? hash.digest("hex") : undefined;
	} catch {
		// Unreadable, changing or unbounded trees remain custom; no resource is hidden or trusted by this fallback.
		return undefined;
	}
}

function contains(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function marketplaceOrigin(
	entry: MarketplacePluginEntry,
	sources: readonly MarketplaceSource[],
	builtinReady: boolean,
): ResourceOrigin {
	const owner = [...sources]
		.sort((a, b) => b.path.length - a.path.length)
		.find((source) => contains(source.path, entry.sourcePath));
	if (!owner) return "custom";
	return owner.kind === "builtin" ? (builtinReady ? "stepcode" : "custom") : "market";
}

/** A same-named local plugin is not a market plugin unless its actual files match. */
export async function resolvePluginOrigins(
	plugins: readonly InstalledStepPlugin[],
	available: readonly MarketplacePluginEntry[],
	sources: readonly MarketplaceSource[],
	builtinReady: boolean,
): Promise<Map<string, ResourceOrigin>> {
	const cache = new Map<string, Promise<string | undefined>>();
	const signature = (path: string) => {
		let value = cache.get(path);
		if (!value) {
			value = directorySignature(path);
			cache.set(path, value);
		}
		return value;
	};
	const result = new Map<string, ResourceOrigin>();
	for (const plugin of plugins) {
		result.set(plugin.id, "custom");
		const installed = await signature(plugin.rootPath);
		if (!installed) continue;
		for (const entry of available.filter(
			(entry) => entry.name === plugin.id || entry.name === basename(plugin.rootPath),
		)) {
			const origin = marketplaceOrigin(entry, sources, builtinReady);
			if (origin === "custom") continue;
			if (installed === (await signature(entry.sourcePath))) {
				result.set(plugin.id, origin);
				break;
			}
		}
	}
	return result;
}
