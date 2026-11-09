/** Package reviewed skill resources; source directories are never changed or executed. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeExtensionDescription } from "./lib/extension-text.mjs";
import { parse, stringify } from "yaml";
import { gzipSync } from "node:zlib";
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const source = resolve(process.argv[2] ?? join(webRoot, "../../../stepcode/技能"));
const catalogPath = join(webRoot, "client/src/features/market/catalog/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const original = catalog.entries.filter((entry) => entry.kind === "skills");
const entries = [], packages = [];
for (const directory of await readdir(source, { withFileTypes: true })) {
	if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
	const root = join(source, directory.name);
	const raw = await readFile(join(root, "SKILL.md"), "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	if (!match) throw new Error(`Missing frontmatter: ${directory.name}`);
	let metadata, normalized = false;
	try { metadata = parse(match[1]); } catch {
		metadata = parse(match[1], { uniqueKeys: false }); normalized = true;
	}
	if (typeof metadata.name !== "string" || !metadata.name.trim() || typeof metadata.description !== "string" || !metadata.description.trim()) throw new Error(`Invalid skill metadata: ${directory.name}`);
	const name = metadata.name.trim();
	const body = normalized ? `---\n${stringify(metadata)}---\n${raw.slice(match[0].length)}` : raw;
	const previous = original.find((entry) => entry.name === name);
	const packageName = previous?.package ?? `local__${name}`;
	const files = new Map(); let bytes = 0;
	async function collect(relative) {
		if (relative.split("/").some((part) => [".git", "node_modules", ".DS_Store", "__pycache__"].includes(part))) return;
		if (/(^|\/)(\.env|auth\.json|\.credentials\.json|id_rsa)$|\.(pem|key)$/u.test(relative)) throw new Error(`Credential-like resource: ${name}`);
		const path = join(root, relative), info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Linked resource: ${name}`);
		if (info.isDirectory()) { for (const child of (await readdir(path)).sort()) await collect(`${relative}/${child}`); return; }
		if (!info.isFile()) throw new Error(`Unsupported resource: ${name}`);
		if (files.has(relative)) return;
		const data = relative === "SKILL.md" ? Buffer.from(body) : await readFile(path);
		bytes += data.length; if (bytes > 128 * 1024 * 1024 || files.size >= 16000) throw new Error(`Oversized skill: ${name}`);
		files.set(relative, { path: relative, data: data.toString("base64"), executable: Boolean(info.mode & 0o111) });
	}
	for (const item of await readdir(root, { withFileTypes: true })) {
		if ([".git", "node_modules", ".DS_Store", ".history", "e2etests"].includes(item.name) ||
			(name === "svg-optimize" && ["ReadHub", "cart-stepper", "SVG-master"].includes(item.name))) {
			console.log(`Excluded non-runtime skill resource: ${name}/${item.name}`); continue;
		}
		if (name === "svg-optimize" && item.name === "Font-Awesome-7.x") {
			for (const child of await readdir(join(root, item.name))) {
				if (["svgs", "svgs-full", "sprites", "metadata", "LICENSE.txt"].includes(child)) await collect(`${item.name}/${child}`);
				else console.log(`Excluded unused icon-library resource: ${name}/${item.name}/${child}`);
			}
		} else await collect(item.name);
	}
	const id = previous?.id ?? `skills-${packageName}`;
	const paths = [...files.keys()].sort();
	entries.push({ ...previous, id, kind: "skills", package: packageName, identifier: name, name,
		description: previous?.description?.trim() ? previous.description : normalizeExtensionDescription(metadata.description) || "1 技能", version: metadata.version?.toString() ?? previous?.version ?? "",
		publisher: previous?.publisher ?? metadata.author ?? "本地精选", license: metadata.license ?? previous?.license ?? "",
		categories: previous?.categories ?? ["creative"], components: "1 技能", items: { skills: [{ name, description: metadata.description.trim() }], connectors: [], commands: [] },
		files: paths, notes: ["目录收录不代表安装、运行或安全认证。", ...(normalized ? ["分发副本的 YAML 头部已规范化，原始文件未改动。"] : [])],
		document: { filename: "SKILL.md", path: "SKILL.md", raw: body, sha256: createHash("sha256").update(body).digest("hex") } });
	packages.push({ catalogId: id, id: name, data: gzipSync(JSON.stringify([...files.values()]), { level: 9 }).toString("base64") });
	console.log(`${name}: ${files.size} files, ${bytes} bytes${normalized ? ' (frontmatter normalized)' : ''}`);
}
if (entries.length !== 36) throw new Error(`Expected current 36 skills, found ${entries.length}`);
catalog.entries = [...catalog.entries.filter((entry) => entry.kind === "plugins"), ...entries, ...catalog.entries.filter((entry) => entry.kind === "connectors")];
await mkdir(join(webRoot, "resources"), { recursive: true });
await writeFile(join(webRoot, "resources/skill-market.json"), `${JSON.stringify({ schemaVersion: 1, packages })}\n`);
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log("Updated current catalog and 36 portable skill bundles; source packages unchanged.");
