/** Evidence-backed suggestions only. Opening a template never launches or installs a service. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { normalizeExtensionDescription } from "./lib/extension-text.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const path = join(root, "client/src/features/market/catalog/catalog.json");
const catalog = JSON.parse(await readFile(path, "utf8"));
/** Local package folder per registry package name; the two naming schemes do not map. */
const localFolders = {
	"54yyyu__zotero-mcp": "Zotero MCP",
	"ChromeDevTools__chrome-devtools-mcp": "Chrome DevTools",
	"Coding-Solo__godot-mcp": "Godot MCP",
	"CoplayDev__unity-mcp": "Unity MCP",
	"GongRzhe__Office-PowerPoint-MCP-Server": "PowerPoint MCP",
	"GongRzhe__Office-Word-MCP-Server": "Word MCP",
	"MausRundung__mcp-explorer": "MCP Explorer",
	"ahujasid__mcp-for-blender": "Blender MCP",
	"aliyun__alibabacloud-devops-mcp-server": "阿里云云效 DevOps",
	"chongdashu__unreal-mcp": "Unreal MCP",
	"datalayer__jupyter-mcp-server": "Jupyter MCP",
	"excalidraw__excalidraw-mcp": "Excalidraw MCP",
	"haris-musa__excel-mcp-server": "Excel MCP",
	"hashicorp__terraform-mcp-server": "Terraform MCP",
	"microsoft__playwright": "Playwright MCP",
};
const localRoot = resolve(process.argv[2] ?? join(root, "../../../stepcode/连接器"));

async function readJson(file) {
	return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
}
/** A one-line description from the package's own manifest, never from its README body. */
async function manifestDescription(folder) {
	const server = await readJson(join(folder, "server.json"));
	if (typeof server?.description === "string" && server.description.trim()) return server.description.trim();
	const npm = await readJson(join(folder, "package.json"));
	if (typeof npm?.description === "string" && npm.description.trim()) return npm.description.trim();
	for (const relative of ["pyproject.toml", "Python/pyproject.toml", "Server/pyproject.toml"]) {
		const file = join(folder, relative);
		if (!existsSync(file)) continue;
		const project = parseToml(await readFile(file, "utf8")).project;
		if (typeof project?.description === "string" && project.description.trim()) return project.description.trim();
	}
	return undefined;
}
const recipes = {
	"54yyyu__zotero-mcp": { serverName: "zotero-mcp", configuration: { command: "uvx", args: ["zotero-mcp-server==0.9.1", "serve"], env: { ZOTERO_LOCAL: "true" } }, evidence: "server.json:13-29; Zotero local API must be enabled" },
	"ChromeDevTools__chrome-devtools-mcp": { serverName: "chrome-devtools-mcp", configuration: { command: "npx", args: ["-y", "chrome-devtools-mcp@1.12.0"] }, evidence: "server.json:11-21; Chrome required" },
	"Coding-Solo__godot-mcp": { serverName: "godot-mcp", configuration: { command: "npx", args: ["-y", "@coding-solo/godot-mcp@0.1.1"] }, evidence: "README.md:89-100; npm package version/repository verified 2026-11-09; Godot required" },
	"CoplayDev__unity-mcp": { serverName: "unity-mcp", configuration: { command: "uvx", args: ["--from", "mcpforunityserver==10.3.0", "mcp-for-unity", "--transport", "stdio"] }, evidence: "Server/README.md:44-58; Unity editor integration required" },
	"GongRzhe__Office-PowerPoint-MCP-Server": { serverName: "powerpoint-mcp", configuration: { command: "uvx", args: ["--from", "office-powerpoint-mcp-server==2.0.7", "ppt_mcp_server"] }, evidence: "README.md:179-190; pyproject.toml:6-7,42-43" },
	"GongRzhe__Office-Word-MCP-Server": { serverName: "word-mcp", configuration: { command: "uvx", args: ["--from", "office-word-mcp-server==1.1.11", "word_mcp_server"] }, evidence: "README.md:172-182; pyproject.toml:6-7,39-40" },
	"MausRundung__mcp-explorer": { serverName: "mcp-project-explorer", configuration: { command: "npx", args: ["-y", "@team-jd/mcp-project-explorer@0.1.9", "<WORKSPACE_DIR>"] }, evidence: "README.md:19-29; package.json version and npm release verified 2026-11-09; choose an explicit project directory" },
	"ahujasid__mcp-for-blender": { serverName: "blender-mcp", configuration: { command: "uvx", args: ["mcp-for-blender==2.2.6"] }, evidence: "README.md:99-105; Blender addon must be installed and running" },
	"aliyun__alibabacloud-devops-mcp-server": { serverName: "aliyun-devops", configuration: { url: "https://openapi-rdc.aliyuncs.com/ai/mcp", bearer_token_env_var: "YUNXIAO_ACCESS_TOKEN" }, evidence: "README.zh-cn.md hosted MCP section; configure YUNXIAO_ACCESS_TOKEN" },
	"chongdashu__unreal-mcp": { serverName: "unreal-mcp", configuration: { command: "uv", args: ["--directory", "<UNREAL_MCP_PYTHON_DIR>", "run", "unreal_mcp_server.py"] }, evidence: "mcp.json:4-9; choose the local Unreal MCP Python source directory and install editor integration" },
	"datalayer__jupyter-mcp-server": { serverName: "jupyter-mcp", configuration: { url: "https://mcp.datalayer.run/mcp", oauth: {} }, evidence: "README.md:29-36,65-78; browser OAuth required" },
	"excalidraw__excalidraw-mcp": { serverName: "excalidraw", configuration: { url: "https://mcp.excalidraw.com" }, evidence: "README.md:11-15" },
	"haris-musa__excel-mcp-server": { serverName: "excel-mcp", configuration: { command: "uvx", args: ["excel-mcp-server==2.2.6", "stdio", "--allow-dir", "<WORKSPACE_DIR>"] }, evidence: "server.json:21-31; README.md:93-107; choose workbook directory" },
	"hashicorp__terraform-mcp-server": { serverName: "terraform-mcp", configuration: { command: "docker", args: ["run", "--rm", "-i", "hashicorp/terraform-mcp-server:1.4.1"] }, evidence: "server.json:11-18; Docker required, configure Terraform authentication separately" },
	"microsoft__playwright": { serverName: "playwright", configuration: { command: "npx", args: ["-y", "@playwright/mcp@0.0.84"] }, evidence: "npm package version/repository verified 2026-11-09; local playwright-internal source version is not the MCP package version; browser/runtime dependencies may be downloaded on launch" },
};
for (const entry of catalog.entries.filter((entry) => entry.kind === "connectors")) {
	const recipe = recipes[entry.package];
	if (!recipe) throw new Error(`Missing connector recipe: ${entry.package}`);
	if (!entry.description?.trim()) entry.description = normalizeExtensionDescription(await manifestDescription(join(localRoot, localFolders[entry.package] ?? ""))) || entry.components;
	entry.connection = { ...entry.connection, ...recipe, auth: recipe.configuration.oauth ? "oauth" : recipe.configuration.bearer_token_env_var ? "bearer" : "unknown", transport: recipe.configuration.url ? "http" : "stdio", source: "readme", url: recipe.configuration.url ?? "" };
	entry.notes = ["配置模板来自包内证据；请核对路径、外部应用、依赖和授权后保存。打开模板不会安装依赖或启动服务。", recipe.evidence];
	if (entry.package === "microsoft__playwright") entry.name = "Playwright MCP";
}
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Updated ${catalog.entries.filter((entry) => entry.kind === "connectors").length} evidence-backed connector templates; no connector was registered or launched.`);
