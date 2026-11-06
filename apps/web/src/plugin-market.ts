import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
	ensurePluginDependency,
	installPreparedPlugin,
	MAX_PLUGIN_ARCHIVE_BYTES,
	type PluginDependencyState,
	type PluginFile,
	PluginInstallError,
	pluginPackageMatchesDirectory,
	preparePluginPackage,
	readPluginZip,
} from "@step-harness/coding-agent";

interface Bundle {
	readonly catalogId: string;
	readonly id: string;
	readonly data: string;
}
let bundles: Promise<readonly Bundle[]> | undefined;
async function marketBundles(): Promise<readonly Bundle[]> {
	bundles ??= (async () => {
		const path = import.meta.url.endsWith(".ts")
			? new URL("../resources/plugin-market.json", import.meta.url)
			: new URL("./plugin-market.json", import.meta.url);
		let content: { schemaVersion: number; packages: Bundle[] };
		try {
			content = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; packages: Bundle[] };
		} catch (error) {
			// The payload archive ships separately from the source tree. Without it the market
			// still browses from catalog.json and installation reports a clear 404.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		if (content.schemaVersion !== 1 || !Array.isArray(content.packages))
			throw new Error("Invalid packaged plugin catalog");
		return content.packages;
	})();
	return bundles;
}
async function curatedPackage(catalogId: string) {
	const bundle = (await marketBundles()).find((entry) => entry.catalogId === catalogId);
	if (!bundle) throw new PluginInstallError("Plugin is not in the curated catalog", 404);
	const raw = JSON.parse(
		gunzipSync(Buffer.from(bundle.data, "base64"), { maxOutputLength: 96 * 1024 * 1024 }).toString("utf8"),
	) as Array<{ path: string; data: string; executable?: boolean }>;
	const files: PluginFile[] = raw.map((file) => ({ ...file, data: Buffer.from(file.data, "base64") }));
	const pkg = preparePluginPackage(files);
	if (pkg.manifest.id !== bundle.id) throw new Error("Packaged plugin identifier mismatch");
	return pkg;
}
export async function previewCuratedPlugin(catalogId: string) {
	return (await curatedPackage(catalogId)).preview;
}
export type DependencyPreparer = (command: string) => Promise<PluginDependencyState>;
async function completeInstallation(pkg: ReturnType<typeof preparePluginPackage>, prepare: DependencyPreparer) {
	const preview = await installPreparedPlugin(pkg);
	if (!preview.provisionCommand) return preview;
	let dependency: PluginDependencyState;
	try {
		dependency = await prepare(preview.provisionCommand);
	} catch {
		dependency = {
			command: preview.provisionCommand,
			status: "setup_required",
			reason: "install_failed",
			firstUseConfiguration: true,
		};
	}
	return { ...preview, dependency };
}
export async function installCuratedPlugin(
	catalogId: string,
	fingerprint: unknown,
	confirmed: unknown,
	prepare: DependencyPreparer = ensurePluginDependency,
) {
	const pkg = await curatedPackage(catalogId);
	if (confirmed !== true || fingerprint !== pkg.preview.fingerprint)
		throw new PluginInstallError("Review and confirm this plugin before installing", 409);
	return completeInstallation(pkg, prepare);
}
export async function importPluginArchive(
	input: Record<string, unknown>,
	prepare: DependencyPreparer = ensurePluginDependency,
) {
	if (
		typeof input.data !== "string" ||
		input.data.length > Math.ceil(MAX_PLUGIN_ARCHIVE_BYTES / 3) * 4 ||
		!input.data.length
	)
		throw new PluginInstallError("Plugin upload must be a ZIP archive no larger than 32 MiB");
	const archive = Buffer.from(input.data, "base64");
	if (archive.toString("base64") !== input.data) throw new PluginInstallError("Invalid base64 archive");
	const pkg = preparePluginPackage(readPluginZip(archive));
	if (input.confirmed !== true) return { preview: pkg.preview, installed: false };
	if (input.fingerprint !== pkg.preview.fingerprint)
		throw new PluginInstallError("Plugin changed after preview; review it again", 409);
	return { preview: await completeInstallation(pkg, prepare), installed: true };
}
export async function curatedPluginOrigin(id: string, path: string): Promise<boolean> {
	const bundle = (await marketBundles()).find((entry) => entry.id === id);
	return Boolean(bundle && (await pluginPackageMatchesDirectory(await curatedPackage(bundle.catalogId), path)));
}
