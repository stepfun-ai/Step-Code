import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
	installPreparedSkill,
	MAX_PLUGIN_ARCHIVE_BYTES,
	type PluginFile,
	PluginInstallError,
	pluginPackageMatchesDirectory,
	prepareSkillPackage,
	readPluginZip,
	SKILL_ARCHIVE_LIMITS,
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
			? new URL("../resources/skill-market.json", import.meta.url)
			: new URL("./skill-market.json", import.meta.url);
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
			throw new Error("Invalid packaged skill catalog");
		return content.packages;
	})();
	return bundles;
}
async function curatedPackage(catalogId: string) {
	const bundle = (await marketBundles()).find((entry) => entry.catalogId === catalogId);
	if (!bundle) throw new PluginInstallError("Skill is not in the current catalog", 404);
	const raw = JSON.parse(
		gunzipSync(Buffer.from(bundle.data, "base64"), { maxOutputLength: 180 * 1024 * 1024 }).toString("utf8"),
	) as Array<{ path: string; data: string; executable?: boolean }>;
	const files: PluginFile[] = raw.map((file) => ({ ...file, data: Buffer.from(file.data, "base64") }));
	const pkg = prepareSkillPackage(files);
	if (pkg.preview.id !== bundle.id) throw new Error("Packaged skill identifier mismatch");
	return pkg;
}
export async function previewCuratedSkill(catalogId: string) {
	return (await curatedPackage(catalogId)).preview;
}
export async function installCuratedSkill(catalogId: string, fingerprint: unknown, confirmed: unknown) {
	const pkg = await curatedPackage(catalogId);
	if (confirmed !== true || fingerprint !== pkg.preview.fingerprint)
		throw new PluginInstallError("Review and confirm this skill before installing", 409);
	return installPreparedSkill(pkg);
}
export async function importSkillArchive(input: Record<string, unknown>) {
	if (
		typeof input.data !== "string" ||
		!input.data.length ||
		input.data.length > Math.ceil(MAX_PLUGIN_ARCHIVE_BYTES / 3) * 4
	)
		throw new PluginInstallError("Skill upload must be no larger than 32 MiB");
	const data = Buffer.from(input.data, "base64");
	if (data.toString("base64") !== input.data) throw new PluginInstallError("Invalid base64 archive");
	if (input.format !== "markdown" && input.format !== "zip")
		throw new PluginInstallError("Skill format must be markdown or zip");
	const pkg = prepareSkillPackage(
		input.format === "markdown" ? [{ path: "SKILL.md", data }] : readPluginZip(data, SKILL_ARCHIVE_LIMITS),
	);
	if (input.confirmed !== true) return { preview: pkg.preview, installed: false };
	if (input.fingerprint !== pkg.preview.fingerprint)
		throw new PluginInstallError("Skill changed after preview; review again", 409);
	return { preview: await installPreparedSkill(pkg), installed: true };
}
export async function curatedSkillCatalogId(name: string, root: string): Promise<string | undefined> {
	const bundle = (await marketBundles()).find((entry) => entry.id === name);
	return bundle && (await pluginPackageMatchesDirectory(await curatedPackage(bundle.catalogId), root))
		? bundle.catalogId
		: undefined;
}
