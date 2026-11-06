/**
 * Walks the extension market through every flow and state and drops one screenshot per
 * state, so a design review does not need a live install to photograph the UI.
 *
 *   pnpm --filter @step-harness/web walkthrough [outputDir]
 *
 * It boots the same Vite fixture the market e2e uses (real components, stubbed
 * `/api/v1/settings/*`), temporarily flags one catalog entry as StepFun's own so the
 * official badge is visible, and restores the catalog afterwards. Chrome must be
 * installed (or set CHROME_PATH).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const clientRoot = join(webRoot, "client");
const catalogPath = join(clientRoot, "src", "features", "market", "catalog", "catalog.json");
const outputDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(homedir(), "Desktop", "market-walkthrough");

const chromePath = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].find((path) => path && existsSync(path));
if (!chromePath) {
	console.error("No Chrome found; install it or set CHROME_PATH");
	process.exit(1);
}

/** The entry the walkthrough badges and installs, so one row shows every plugin state. */
const OFFICIAL_PACKAGE = "DingTalk-Real-AI__dingtalk-workspace-cli";
const NOT_INSTALLED_PACKAGE = "larksuite__cli";
const SKILL_PACKAGE = "user_3b34947d__ppt-generator-skill";

const catalogText = await readFile(catalogPath, "utf8");
const catalog = JSON.parse(catalogText);
const official = catalog.entries.find((entry) => entry.package === OFFICIAL_PACKAGE);
const skill = catalog.entries.find((entry) => entry.package === SKILL_PACKAGE);
if (!official || !skill) throw new Error("walkthrough entries missing from the catalog");

const plugins = {
	installed: [{ id: official.identifier, name: official.name, origin: "custom", version: "1.0.0", mcpServers: [], warnings: [] }],
	available: [],
	marketplaces: [],
	warnings: [],
};
const skills = [
	{
		id: "/fixture/ppt-generator/SKILL.md",
		name: skill.name.replace(/-skill$/u, ""),
		description: "智能 PPT 生成助手。",
		source: "user",
		origin: "market",
		location: "~/skills/ppt-generator",
		enabled: true,
		toggleable: true,
		deletable: true,
		installation: {
			source: "skillhub",
			registryId: "@user_3b34947d/ppt-generator-skill",
			sourceUrl: "https://skillhub.cn/skills/user_3b34947d/ppt-generator-skill",
			version: "1.0.2",
			skillSha256: skill.document.sha256,
		},
	},
];
const servers = [
	{ name: "official-tools", source: "plugin", origin: "stepcode", pluginName: "Official", transport: "stdio", enabled: true, status: "connected", toolCount: 3 },
	{ name: "local-http", source: "user", origin: "custom", transport: "http", enabled: false, status: "disabled", config: { url: "https://example.test/mcp" } },
];

const fixtureId = join(clientRoot, "market-walkthrough-fixture.tsx");
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {I18nProvider} from "/src/i18n";
import {SettingsView} from "/src/features/settings";
import {SidebarNav} from "/src/features/sidebar";
import {MarketView} from "/src/features/market";
import {ErrorToast} from "/src/features/shell";
import {setState,setUi} from "/src/state/store.ts";
setState({booted:true,locale:"zh-CN"});setUi({midView:"market"});
createRoot(document.getElementById("root")).render(<I18nProvider><IconSprite/><div className="app"><aside className="sidebar"><SidebarNav/></aside><main className="main"><MarketView/></main></div><SettingsView/><ErrorToast/></I18nProvider>);
`;

await mkdir(outputDir, { recursive: true });
const patched = JSON.stringify(
	{ ...catalog, entries: catalog.entries.map((entry) => (entry === official ? { ...entry, selfMade: true } : entry)) },
	null,
	2,
);
await writeFile(catalogPath, patched);

let vite;
let browser;
let captured = 0;
try {
	const cacheDir = await mkdtemp(join(tmpdir(), "stepcode-walkthrough-"));
	vite = await createServer({
		cacheDir,
		configFile: join(webRoot, "vite.config.ts"),
		root: clientRoot,
		server: { host: "127.0.0.1", port: 0, proxy: {} },
		plugins: [
			{
				name: "market-walkthrough-fixture",
				resolveId(id) {
					if (id === "/market-walkthrough.js" || id === fixtureId) return fixtureId;
				},
				load(id) {
					if (id === fixtureId) return fixture;
				},
				configureServer(server) {
					server.middlewares.use((req, res, next) => {
						const path = new URL(req.url ?? "/", "http://x").pathname;
						if (path === "/api/v1/settings/plugins") {
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(plugins));
							return;
						}
						if (path === "/api/v1/settings/skills") {
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ skills }));
							return;
						}
						if (path === "/api/v1/settings/mcp") {
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ servers }));
							return;
						}
						if (req.url !== "/market-walkthrough") return next();
						res.setHeader("Content-Type", "text/html");
						res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/market-walkthrough.js"></script></body></html>`);
					});
				},
			},
		],
	});
	await vite.listen();
	const url = `http://127.0.0.1:${vite.httpServer.address().port}/market-walkthrough`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await page.goto(url);
	await page.locator(".extension-market-row").first().waitFor();

	const shot = async (name) => {
		await page.screenshot({ animations: "disabled", path: join(outputDir, `${name}.png`) });
		captured += 1;
		console.log(`  ✓ ${name}.png`);
	};
	/** A row's overflow/install button only turns opaque while the row is hovered. */
	const waitForRowAction = (entryId, actionClass) =>
		page.waitForFunction(
			([id, cls]) => {
				const row = document.querySelector(`.extension-market-row:has([data-market-entry="${id}"])`);
				const button = row?.querySelector(`.${cls}`);
				return Boolean(button) && getComputedStyle(button).opacity === "1";
			},
			[entryId, actionClass],
		);
	const row = (entryId) => page.locator(".extension-market-row").filter({ has: page.locator(`[data-market-entry="${entryId}"]`) });
	const officialRow = row(`plugins-${OFFICIAL_PACKAGE}`);
	const plainRow = row(`plugins-${NOT_INSTALLED_PACKAGE}`);
	const skillRow = row(`skills-${SKILL_PACKAGE}`);

	console.log("walkthrough:");
	await shot("01-plugins-list");

	await plainRow.hover();
	await waitForRowAction(`plugins-${NOT_INSTALLED_PACKAGE}`, "extension-market-add");
	await shot("02-row-hover-install");

	await officialRow.hover();
	await waitForRowAction(`plugins-${OFFICIAL_PACKAGE}`, "extension-market-more");
	await shot("03-row-hover-installed");

	await officialRow.locator(".extension-market-more").click();
	await page.getByRole("menuitem").first().waitFor();
	await shot("04-installed-menu");
	await page.keyboard.press("Escape");

	await plainRow.locator(".extension-market-open").click();
	await page.locator(".extension-detail").waitFor();
	await shot("05-detail-not-installed");
	await page.locator(".extension-detail-back button").click();

	await officialRow.locator(".extension-market-open").click();
	await page.locator(".extension-detail [data-market-trial]").waitFor();
	await shot("06-detail-installed-official");
	await page.locator(".extension-detail-back button").click();

	await page.locator("#extensionMarketNew").click();
	await page.locator("#extensionMarketAddMenu [role=menuitem]").first().waitFor();
	await shot("07-add-menu");

	const [chooser] = await Promise.all([
		page.waitForEvent("filechooser"),
		page.locator('[data-market-upload="plugins"]').click(),
	]);
	await chooser.setFiles({ name: "demo-plugin.zip", mimeType: "application/zip", buffer: Buffer.from("preview") });
	await page.locator("#errorToast").filter({ hasText: "demo-plugin.zip" }).waitFor();
	await shot("08-upload-success");

	await page.locator('input[accept=".zip"]').setInputFiles({
		name: "broken.exe",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("x"),
	});
	await page.locator("#errorToast").filter({ hasText: "插件导入失败" }).waitFor();
	await shot("09-upload-failure");
	await page.locator('[data-market-kind="skills"]').click();
	await page.locator(".extension-market-row").first().waitFor();
	await page.locator('input[accept=".zip,.skill,.md"]').setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("x"),
	});
	await page.locator("#errorToast").filter({ hasText: "技能导入失败" }).waitFor();
	await shot("09b-upload-failure-skill");
	await page.locator('[data-market-kind="plugins"]').click();
	await page.locator(".extension-market-row").first().waitFor();

	await page.locator(".extension-market-search input").fill("不存在的插件");
	await page.locator(".extension-market .empty-list").waitFor();
	await shot("10-search-empty");
	await page.locator(".extension-market-search input").fill("");

	await page.locator('[data-market-category="office"]').click();
	await shot("11-category-office");
	await page.locator('[data-market-category="all"]').click();

	await page.locator('[data-market-kind="connectors"]').click();
	await page.locator("[data-market-connector]").first().waitFor();
	await shot("12-connectors-list");
	await page.locator('[data-market-entry="connector:official-tools"]').click();
	await page.locator("[data-connector-detail]").waitFor();
	await shot("13-connector-detail");
	await page.locator(".extension-detail-back button").click();

	await page.locator('[data-market-kind="skills"]').click();
	await page.locator(".extension-market-row").first().waitFor();
	await skillRow.scrollIntoViewIfNeeded();
	await shot("14-skills-list");
	await skillRow.locator(".extension-market-open").click();
	await page.locator(".extension-detail [data-market-trial]").waitFor();
	await shot("15-skill-detail-installed");
	await page.locator(".extension-detail-back button").click();

	await page.locator('[data-market-kind="plugins"]').click();
	await page.locator(".extension-market-row").first().waitFor();
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await shot("16-dark-plugins-list");

	console.log(`\n${captured} screenshots in ${outputDir}`);
} finally {
	await browser?.close();
	await vite?.close();
	await writeFile(catalogPath, catalogText);
	console.log("catalog restored");
}
