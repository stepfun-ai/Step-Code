/** Build portable plugin resources from reviewed local packages. Never runs their scripts. */
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(process.argv[2] ?? join(webRoot, "../../../stepcode/插件"));
const catalogPath = join(webRoot, "client/src/features/market/catalog/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const packages = [];
for (const directory of await readdir(sourceRoot, { withFileTypes: true })) {
	if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
	const root = join(sourceRoot, directory.name);
	const manifest = JSON.parse(await readFile(join(root, "step.plugin.json"), "utf8"));
	const entry = catalog.entries.find((item) => item.kind === "plugins" && item.identifier === manifest.id);
	if (!entry) continue;
	const files = new Map();
	let bytes = 0;
	async function collect(relative) {
		if (relative.split("/").some((part) => [".git", "node_modules", ".DS_Store"].includes(part))) return;
		if (/(^|\/)(\.env|auth\.json|\.credentials\.json|id_rsa)$|\.(pem|key)$/u.test(relative))
			throw new Error(`Credential-like resource is not distributable: ${manifest.id}`);
		const path = join(root, relative);
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Symlink resource is not distributable: ${manifest.id}`);
		if (info.isDirectory()) {
			for (const name of (await readdir(path)).sort()) await collect(`${relative}/${name}`);
		} else if (info.isFile() && !files.has(relative)) {
			bytes += info.size;
			if (bytes > 64 * 1024 * 1024 || files.size >= 6000) throw new Error(`Oversized plugin: ${manifest.id}`);
			files.set(relative, { path: relative, data: (await readFile(path)).toString("base64"), executable: Boolean(info.mode & 0o111) });
		} else if (!info.isFile()) throw new Error(`Unsupported resource: ${manifest.id}`);
	}
	const roots = new Set(["step.plugin.json", entry.document.path, ...(manifest.skills ?? []), ...(manifest.commands ?? [])]);
	if (typeof manifest.mcpServers === "string") roots.add(manifest.mcpServers);
	for (const item of await readdir(root, { withFileTypes: true })) {
		if (item.isFile() && /^(readme|license|licence|notice|copyright|接入说明)(\.|$)/iu.test(item.name)) roots.add(item.name);
		if (item.isDirectory() && ["scripts", "references", "assets"].includes(item.name)) roots.add(item.name);
	}
	for (const declared of roots) {
		const path = declared.replace(/^(?:\.\/)+/u, "");
		if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("Unsafe declared resource");
		await collect(path);
	}
	if (![...files.keys()].some((path) => /^readme(?:\.|$)/iu.test(path))) {
		const document = files.get(entry.document.path.replace(/^(?:\.\/)+/u, ""));
		if (!document) throw new Error(`Missing catalog document: ${manifest.id}`);
		bytes += Buffer.from(document.data, "base64").length;
		if (bytes > 64 * 1024 * 1024 || files.size >= 6000) throw new Error(`Oversized plugin: ${manifest.id}`);
		files.set("README.md", { ...document, path: "README.md", executable: false });
	}
	packages.push({ catalogId: entry.id, id: manifest.id, data: gzipSync(JSON.stringify([...files.values()].sort((a, b) => a.path.localeCompare(b.path))), { level: 9 }).toString("base64") });
	console.log(`${manifest.id}: ${files.size} files, ${bytes} bytes`);
}
if (packages.length !== catalog.entries.filter((entry) => entry.kind === "plugins").length) throw new Error("Incomplete plugin catalog");
const destination = join(webRoot, "resources/plugin-market.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify({ schemaVersion: 1, packages })}\n`);
console.log(`Wrote ${packages.length} plugin bundles to resources/plugin-market.json`);
