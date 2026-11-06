import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "extension-market-fixture.tsx").replaceAll("\\", "/");
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {I18nProvider} from "/src/i18n";
import {SettingsView} from "/src/features/settings";
import {SidebarNav} from "/src/features/sidebar";
import {MarketView} from "/src/features/market";import {ErrorToast} from "/src/features/shell";
import {setState, setUi} from "/src/state/store.ts";
setState({booted:true,locale:"zh-CN"});setUi({midView:"market"});
window.marketLocale = locale => setState({locale});
createRoot(document.getElementById("root")).render(<I18nProvider><IconSprite/><div className="app"><aside className="sidebar"><SidebarNav/></aside><main className="main"><MarketView/></main></div><SettingsView/><ErrorToast/></I18nProvider>);
`;
let vite, browser, url, cacheDir;
before(async () => {
	if (skip) return;
	cacheDir = await mkdtemp(join(tmpdir(), "stepcode-market-vite-"));
	vite = await createServer({
		cacheDir,
		configFile: join(webRoot, "vite.config.ts"), root: join(webRoot, "client"),
		server: {host: "127.0.0.1", port: 0, proxy: {}},
		plugins: [{name: "extension-market-fixture",
			resolveId(id) { if (id === "/extension-market-fixture.js" || id === fixtureId) return fixtureId; },
			load(id) { if (id === fixtureId) return fixture; },
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (["/api/v1/settings/plugins","/api/v1/settings/skills","/api/v1/settings/mcp"].includes(new URL(req.url,"http://x").pathname)) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({installed:[],available:[],marketplaces:[],warnings:[],skills:[],servers:[]})); return; }
					if (req.url !== "/extension-market-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/extension-market-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/extension-market-fixture`;
	browser = await chromium.launch({executablePath: chromePath, headless: true});
});
after(async () => { await browser?.close(); await vite?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });
async function capture(page, name) {
	if (!process.env.MARKET_SCREENSHOT_DIR) return;
	await mkdir(process.env.MARKET_SCREENSHOT_DIR, {recursive: true});
	await page.screenshot({animations: "disabled", path: join(process.env.MARKET_SCREENSHOT_DIR, `${name}.png`)});
}

test("sidebar market entry remains below New conversation and outside Settings", {skip}, async () => {
	const page = await browser.newPage();
	await page.route("**/api/**", route => route.fulfill({json:{models:[],providers:[],workspaces:[],sessions:[]}}));
	try {
		await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
		assert.equal(await page.locator("#newSession").evaluate(element => element.nextElementSibling?.id), "marketButton");
		assert.equal(await page.locator("#marketButton").innerText(), "拓展市场");
		assert.equal(await page.locator('[data-settings-page="extensionMarket"]').count(), 0);
		assert.equal(await page.locator('#marketClose').count(),0);await page.locator('#newSession').click();assert.equal(await page.locator("#marketView").isVisible(), false);
		await page.locator("#marketButton").focus();await page.keyboard.press("Enter");
		await page.locator(".extension-market-row").first().waitFor();
		assert.equal(await page.locator("#marketButton").getAttribute("aria-current"), "page");
		await page.locator("#newSession").click();await page.locator("#marketView").waitFor({state:"hidden"});
	} finally { await page.close(); }
});

test("market tabs keep plugin/skill filters and add connectors", {skip}, async () => {
	const page = await browser.newPage({viewport:{width:1440,height:1000}});
	try {
		await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
		assert.deepEqual(await page.locator("[data-market-kind]").allTextContents(), ["插件","技能","连接器"]);
		assert.equal(await page.locator('[data-market-kind="connectors"]').count(), 1);
		assert.equal(await page.locator(".extension-market-category").allTextContents().then(text => text.join("｜")), "全部｜办公效率｜创意设计｜代码开发｜其他");
		assert.equal(await page.locator('.extension-market-note').count(),0);
		assert.equal(await page.locator(".extension-market-section h2").count(), 0);
		assert.equal(await page.locator('.extension-market-title').count(),0);
		await page.locator('[data-market-kind="connectors"]').click();assert.equal(await page.locator('.extension-market-title').count(),0);
		assert.ok(await page.evaluate(()=>document.querySelector('.extension-market-search').getBoundingClientRect().top-document.querySelector('.extension-market-toolbar').getBoundingClientRect().bottom<=36));
		for (const [kind,total] of [["plugins",29],["skills",36]]) {
			await page.locator(`[data-market-kind="${kind}"]`).click();
			await page.locator('[data-market-category="all"]').click();
			assert.equal(await page.locator(".extension-market-row").count(), total);
			assert.equal(await page.locator(".extension-market-origin").count(), 0);
			for (const category of ["office","creative","code","other"]) {
				await page.locator(`[data-market-category="${category}"]`).click();
				const count=await page.locator(".extension-market-row").count();
				if(kind==="plugins"&&category==="other") assert.equal(count,0);
				else assert.ok(count>0);
			}
		}
		await page.locator('[data-market-category="all"]').click();
		await page.locator(".extension-market-search input").fill("ppt-generator");
		await page.waitForFunction(() => document.querySelectorAll(".extension-market-row").length === 1);
		assert.equal(await page.locator(".extension-market-origin").count(), 0);
		await page.locator(".extension-market-search input").fill("不存在的关键词");
		await page.locator(".extension-market .empty-list").waitFor();
		await page.locator(".extension-market-search input").fill("");
		await capture(page, "skills");
		await page.locator('[data-market-kind="plugins"]').click();await capture(page, "plugins");
		await page.evaluate(() => document.documentElement.setAttribute("data-theme","dark"));await capture(page,"dark");
		await page.setViewportSize({width:800,height:900});
		assert.equal(await page.locator(".extension-market-grid").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1);
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
		await page.evaluate(() => window.marketLocale("en-US"));
		await page.waitForFunction(() => document.querySelector('[data-market-category="all"]')?.textContent === "All");
		assert.deepEqual(await page.locator("[data-market-kind]").allTextContents(), ["Plugins","Skills","Connectors"]);
	} finally { await page.close(); }
});

test("market New isolates plugin and skill options and shares the management menu", {skip}, async () => {
	const page = await browser.newPage();const mutations=[];
	page.on("request", request => {if(request.url().includes("/api/") && request.method()!=="GET")mutations.push(request.method());});
	try {
		await page.goto(url);await page.locator(".extension-market-create").waitFor();
		const add=page.locator(".extension-market-create");
		assert.equal(await add.isEnabled(), true);
		for(const kind of ["plugins","skills"]){
			await page.locator(`[data-market-kind="${kind}"]`).click();await add.click();
			assert.equal(await page.locator("#extensionMarketAddMenu [role=menuitem]").count(),2);
			assert.equal(await page.locator(`#extensionMarketAddMenu [data-extension-upload="${kind}"]`).count(),1);
			assert.equal(await page.locator(`#extensionMarketAddMenu [data-extension-upload="${kind === "plugins" ? "skills" : "plugins"}"]`).count(),0);
			assert.equal(await page.locator(`#extensionMarketAddMenu [data-extension-create="${kind}"]`).count(),1);
			await page.keyboard.press("ArrowDown");await page.keyboard.press("Escape");
			assert.equal(await page.locator("#extensionMarketAddMenu").count(),0);
		}
		await add.click();await capture(page,"add-menu");await page.keyboard.press('Escape');
		await page.route('**/api/v1/settings/skills/upload',route=>route.fulfill({status:400,json:{error:'Invalid SKILL.md or ZIP contents'}}));
		for(const [kind,name,type] of [["skills","SKILL.md","text/markdown"],["skills","example.skill","application/zip"]]){
			await page.locator(`[data-market-kind="${kind}"]`).click();await add.click();
			const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.locator(`[data-market-upload="${kind}"]`).click()]);
			await Promise.all([page.waitForResponse(r=>r.url().includes('/settings/skills/upload')),chooser.setFiles({name,mimeType:type,buffer:Buffer.from("preview")})]);
			await page.locator('#errorToast').filter({hasText:'Invalid SKILL.md or ZIP contents'}).waitFor();
			assert.equal(await page.locator('#errorToast').getAttribute('data-tone'),'danger');
		}
		await page.locator('[data-market-kind="plugins"]').click();
		await page.locator('input[accept=".zip"]').setInputFiles({name:"bad.exe",mimeType:"application/octet-stream",buffer:Buffer.from("preview")});
		const failure=page.locator("#errorToast");
		await failure.filter({hasText:"插件导入失败"}).waitFor();
		assert.match(await failure.innerText(),/32 MiB/);
		assert.equal(await failure.getAttribute("data-tone"),"danger");
		assert.equal(await failure.locator(".toast-icon use").getAttribute("href"),"#i-circleX");
		await capture(page,"upload-failure");
		await page.locator('[data-market-kind="skills"]').click();
		await page.locator('input[accept=".zip,.skill,.md"]').setInputFiles({name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("x")});
		await failure.filter({hasText:"技能导入失败"}).waitFor();
		assert.match(await failure.innerText(),/SKILL\.md/);
		await capture(page,"upload-failure-skill");
		await page.locator('[data-market-kind="plugins"]').click();
		assert.equal(await page.locator("#settingsMcpEditor").count(),0);
		assert.deepEqual(mutations,["POST","POST"]);
	}finally{await page.close();}
});

test("plugin README and skill SKILL.md render fully with source and file views", {skip}, async () => {
	const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[],external=[],consoleErrors=[];
	const catalog=JSON.parse(await readFile(join(webRoot,"client/src/features/market/catalog/catalog.json"),"utf8")).entries;
	page.on("console",message=>{if(message.type()==="error")consoleErrors.push(message.text());});
	page.on("pageerror",error=>errors.push(error.message));
	page.on("request",request=>{if(/^https?:/.test(request.url()) && new URL(request.url()).origin!==new URL(url).origin)external.push(request.url());});
	try{
		await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
		for(const [kind,packageName,tableCount,codeCount] of [["plugins","larksuite__cli",4,20],["skills","user_3b34947d__ppt-generator-skill",7,9]]){
			const entry=catalog.find(item=>item.package===packageName);
			await page.locator(`[data-market-kind="${kind}"]`).click();
			await page.locator('[data-market-category="all"]').click();
			await page.locator(".extension-market-search input").fill(entry.name);
			await page.locator(".extension-market-open").first().focus();await page.keyboard.press("Enter");
			await page.waitForFunction(count=>document.querySelectorAll(".extension-detail-markdown table").length===count,tableCount);
			assert.ok(await page.locator(".extension-detail-markdown h1,.extension-detail-markdown h2,.extension-detail-markdown h3,.extension-detail-markdown h4").count()>0);
			assert.equal(await page.locator(".extension-detail-markdown .code-block").count(),codeCount);
			assert.equal(await page.locator(".extension-detail-previews").count(),0);
			assert.equal(await page.locator(".extension-detail-markdown img,.extension-detail-markdown script,.extension-detail-markdown iframe").count(),0);
			assert.equal(await page.locator(".extension-detail-markdown a a,.extension-detail-markdown button button").count(),0);
			assert.equal(await page.locator(".extension-detail-header .extension-market-origin").count(),0);
			await capture(page,`${kind}-document`);
			assert.equal(await page.locator(".extension-detail-tabs").count(),0);
			assert.equal(await page.locator(".extension-detail-markdown").count(),1);
			await page.locator(".extension-detail-back button").click();
			assert.equal(await page.locator(".extension-market-search input").inputValue(),entry.name);
			await page.waitForFunction(()=>document.activeElement?.classList.contains("extension-market-open"));
			await page.locator(".extension-market-search input").fill("");
		}
		await page.setViewportSize({width:800,height:900});
		assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
		assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(consoleErrors,[]);
	}finally{await page.close();}
});

test("catalog installation state is shared and a recorded fingerprint is verified", {skip}, async () => {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const catalog=JSON.parse(await readFile(join(webRoot,"client/src/features/market/catalog/catalog.json"),"utf8")).entries;
 const entry=catalog.find(item=>item.package==="user_3b34947d__ppt-generator-skill");
 const installation={source:'skillhub',registryId:'@user_3b34947d/ppt-generator-skill',sourceUrl:'https://skillhub.cn/skills/user_3b34947d/ppt-generator-skill',version:'1.0.2',skillSha256:entry.document.sha256};
 const skill={id:'/tmp/skills/ppt-generator/SKILL.md',name:'ppt-generator',description:'PPT',source:'user',origin:'market',location:'~/skills/ppt-generator',enabled:true,toggleable:true,deletable:true,installation};
 let current=[skill];
 await page.route('**/api/v1/settings/skills',route=>route.fulfill({json:{skills:current}}));
 try {
  await page.goto(url);await page.locator('[data-market-kind="skills"]').click();
  await page.locator('[data-market-installed]').waitFor();
  const installedRow=page.locator('.extension-market-row').filter({has:page.locator(`[data-market-entry="skills-${entry.package}"]`)});
  await installedRow.scrollIntoViewIfNeeded();
  await capture(page,'installed-idle');
  const check=installedRow.locator('.extension-market-check');
  const more=installedRow.locator('.extension-market-more');
  assert.equal(await check.evaluate(e=>getComputedStyle(e).opacity),'1');
  assert.equal(await more.evaluate(e=>getComputedStyle(e).opacity),'0');
  await installedRow.hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.extension-market-more')).opacity==='1');
  assert.equal(await check.evaluate(e=>getComputedStyle(e).opacity),'0');
  await more.click();await page.getByRole('menuitem').first().waitFor();assert.equal(await page.getByRole('menuitem').count(),2);
  await capture(page,'installed-menu');
  assert.equal(await page.getByRole('menuitem',{name:'试用'}).count(),1);
  assert.equal(await page.getByRole('menuitem',{name:'试用'}).locator('use').getAttribute('href'),'#i-play');
  await page.keyboard.press('Escape');
  const otherRow=page.locator('.extension-market-row').nth(1);
  assert.equal(await otherRow.locator('.extension-market-add').evaluate(e=>getComputedStyle(e).opacity),'0');
  await otherRow.hover();
  await page.waitForTimeout(200);
  assert.equal(await otherRow.locator('.extension-market-add').evaluate(e=>getComputedStyle(e).opacity),'1');
  await page.locator(`[data-market-entry="skills-${entry.package}"]`).click();await page.locator('.extension-detail [data-market-installed]').waitFor();
  assert.equal(await page.locator('.extension-detail [data-market-trial]').count(),1);
  assert.match(await page.locator('.extension-detail [data-market-trial]').innerText(),/试用/);
  assert.equal(await page.locator('.extension-detail [data-market-trial] use').getAttribute('href'),'#i-play');
  assert.equal(await page.locator('.extension-detail [data-extension-remove="skills"]').count(),1);
  assert.equal(await page.locator('.extension-detail [data-market-not-installed]').count(),0);
  await capture(page,'installed-detail');
  assert.match(await page.locator('.extension-detail-header .extension-detail-byline').innerText(),/@user_3b34947d/);
  assert.equal(await page.locator('.extension-detail-sidebar').count(),0);
  assert.equal(await page.locator('.extension-detail-provenance').count(),0);
  await page.locator('.extension-detail-back button').click();
  await page.locator('.extension-market-manage').click();await page.locator('.settings-content[data-page="skills"]').waitFor();
  assert.match(await page.locator('.extension-management-group[data-extension-origin="market"]').innerText(),/ppt-generator/);
  current=[];await page.locator('#settingsBack').click();
  await page.waitForFunction(()=>!document.querySelector('[data-market-installed]'));
  current=[{...skill,installation:{...installation,skillSha256:"0".repeat(64)}}];
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/v1/settings/skills')),page.locator('button[aria-label="刷新"]').click()]);
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="刷新"]').disabled);
  assert.equal(await page.locator('[data-market-installed]').count(),0);
  await page.locator(`[data-market-entry="skills-${entry.package}"]`).click();
  assert.equal(await page.locator('.extension-detail button.extension-market-create').isDisabled(),false);
  assert.match(await page.locator('.extension-detail button.extension-market-create').innerText(),/安装/);
  assert.equal(await page.locator('.extension-detail [data-market-trial]').count(),0);
  await capture(page,'not-installed-detail');
  await page.locator('.extension-detail-back button').click();
  current=[skill];await page.locator('button[aria-label="刷新"]').click();await page.locator('[data-market-installed]').waitFor();
  await capture(page,'catalog-installed');
 }finally{await page.close();}
});

test("connector market displays real MCP metadata and opens existing configuration without mutations", {skip}, async () => {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const writes=[];
 let servers=[
  {name:'local-http',source:'user',origin:'custom',transport:'http',enabled:false,status:'disabled',config:{url:'https://example.test/PRIVATE_SENTINEL',http_headers:{Authorization:'PRIVATE_SENTINEL'}}},
  {name:'official-tools',source:'plugin',origin:'stepcode',pluginName:'Official',transport:'stdio',enabled:true,status:'connected',toolCount:3},
  {name:'plugin-tools',source:'plugin',origin:'plugin',pluginName:'Provider',transport:'stdio',enabled:true,status:'failed',error:'PRIVATE_SENTINEL'},
 ];
 page.on('request',r=>{if(r.url().includes('/api/')&&r.method()!=='GET')writes.push(r.method());});
 await page.route('**/api/v1/settings/mcp',r=>r.fulfill({json:{servers}}));
 try {
  await page.goto(url);assert.equal(await page.locator('[data-market-kind="connectors"]').count(),1);
  await page.locator('[data-market-category="office"]').click();
  await page.locator('[data-market-kind="connectors"]').click();await page.locator('[data-market-connector]').first().waitFor();
  assert.equal(await page.locator('.extension-market-categories').count(),0);
  assert.equal(await page.locator('.extension-market-note').count(),0);
  assert.equal(await page.locator('[data-market-connector]').count(),3);
  assert.equal(await page.locator('[data-market-connector="official-tools"] .extension-market-origin').innerText(),'StepFun 官方');
  assert.equal(await page.locator('[data-market-connector="plugin-tools"] .extension-market-origin').count(),0);
  assert.match(await page.locator('[data-market-connector="local-http"]').innerText(),/已停用/);
  assert.equal(await page.locator('[data-market-not-installed]').count(),0);
  assert.equal((await page.locator('#marketView').innerText()).includes('PRIVATE_SENTINEL'),false);
  await page.locator('[data-market-entry="connector:plugin-tools"]').click();await page.locator('[data-connector-detail="plugin-tools"]').waitFor();
  assert.equal((await page.locator('[data-connector-detail]').innerText()).includes('PRIVATE_SENTINEL'),false);
  await page.locator('.extension-detail-back button').click();
  await page.locator('[data-market-entry="connector:local-http"]').click();await page.locator('[data-connector-detail="local-http"]').waitFor();
  const liveFacts=await page.locator('.extension-detail-facts').innerText();
  assert.match(liveFacts,/传输协议\s*HTTP/);assert.match(liveFacts,/认证方式\s*请求头认证/);assert.match(liveFacts,/服务地址\s*https:\/\/example\.test/);
  assert.equal((await page.locator('[data-connector-detail]').innerText()).includes('PRIVATE_SENTINEL'),false);
  await page.locator('.extension-detail-back button').click();
  assert.equal(await page.locator('.extension-market-categories').count(),0);assert.equal(await page.locator('[data-market-connector]').count(),3);
  await page.locator('.extension-market-search input').fill('Provider');assert.equal(await page.locator('[data-market-connector]').count(),1);
  await page.locator('.extension-market-search input').fill('');
  await capture(page,'connectors-market');
  await page.locator('#extensionMarketNew').click();await page.locator('#settingsMcpEditor').waitFor();
  await page.locator('#settingsBack').click();await page.locator('[data-market-connector]').first().waitFor();
  servers=[];await page.locator('.extension-market-actions button[aria-label="刷新"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-market-connector]'));
  assert.deepEqual(writes,[]);
 }finally{await page.close();}
});

test("market deletions share management behavior: cancel, fail, succeed and preserve catalog entries", {skip}, async()=>{
 const page=await browser.newPage();const catalog=JSON.parse(await readFile(join(webRoot,"client/src/features/market/catalog/catalog.json"),"utf8")).entries;
 const entry=catalog.find(item=>item.package==="user_3b34947d__ppt-generator-skill");
 const installation={source:'skillhub',registryId:'@user_3b34947d/ppt-generator-skill',sourceUrl:'https://skillhub.cn/skills/user_3b34947d/ppt-generator-skill',version:'1.0.2',skillSha256:entry.document.sha256};
 const skill={id:'/fixture/ppt/SKILL.md',name:'ppt-generator',source:'user',origin:'market',location:'~/skills/ppt',enabled:true,deletable:true,toggleable:true,installation};
 let skills=[skill],accept=false,fail=false,deletes=0;
 page.on('dialog',d=>accept?d.accept():d.dismiss());
 await page.route('**/api/v1/settings/skills**',r=>{if(r.request().method()==='DELETE'){deletes++;if(fail)return r.fulfill({status:500,json:{error:'Test deletion failure'}});skills=[];}return r.fulfill({json:{skills}});});
 try {
  await page.goto(url);await page.locator('[data-market-kind="skills"]').click();await page.locator('[data-market-installed]').waitFor();
  const row=page.locator('.extension-market-row').filter({has:page.locator(`[data-market-entry="skills-${entry.package}"]`)});
  const openMenu=async()=>{await row.hover();await row.locator('.extension-market-more').click();await page.getByRole('menuitem').first().waitFor();};
  const deleteItem=page.getByRole('menuitem',{name:'删除'});
  await openMenu();assert.equal(await page.getByRole('menuitem').count(),2);
  await deleteItem.click();assert.equal(deletes,0);
  accept=true;fail=true;await deleteItem.click();
  await page.waitForFunction(()=>![...document.querySelectorAll('[role="menuitem"]')].some(item=>item.disabled));assert.equal(await page.locator('[data-market-installed]').count(),1);
  fail=false;await deleteItem.click();await page.waitForFunction(()=>!document.querySelector('[data-market-installed]'));
  assert.equal(await page.locator(`[data-market-entry="skills-${entry.package}"]`).count(),1);
  await page.locator('.extension-market-manage').click();await page.locator('.settings-content[data-page="skills"]').waitFor();
  assert.equal(await page.locator('.extension-management-group').count(),0);await page.locator('#settingsBack').click();
  skills=[{...skill,deletable:false}];await page.locator('.extension-market-actions button[aria-label="刷新"]').click();await page.locator('[data-market-installed]').waitFor();
  await openMenu();assert.equal(await page.getByRole('menuitem').count(),1);assert.equal(await page.getByRole('menuitem',{name:'删除'}).count(),0);assert.equal(deletes,2);
 }finally{await page.close();}
});

test("connector deletion is shared with management while plugin resources remain protected",{skip},async()=>{
 const page=await browser.newPage();let servers=[{name:'owned',source:'user',origin:'custom',transport:'http',enabled:false},{name:'provided',source:'plugin',origin:'plugin',pluginName:'Provider',transport:'stdio',enabled:true}];let count=0;
 page.on('dialog',d=>d.accept());
 await page.route('**/api/v1/settings/mcp**',r=>{if(r.request().method()==='DELETE'){count++;servers=servers.filter(s=>s.name!=='owned');}return r.fulfill({json:{servers}});});
 try{
  await page.goto(url);await page.locator('[data-market-kind="connectors"]').click();await page.locator('[data-market-connector="owned"]').waitFor();
  assert.equal(await page.locator('[data-market-connector="provided"] [data-extension-remove]').count(),0);
  await page.locator('[data-market-entry="connector:owned"]').click();await page.locator('[data-connector-detail] [data-extension-remove]').click();
  await page.locator('[data-market-connector="provided"]').waitFor();assert.equal(await page.locator('[data-connector-detail]').count(),0);
  await page.locator('.extension-market-actions .extension-market-manage').click();await page.locator('[data-source-fold="plugin"] summary').click();await page.locator('[data-mcp-server="provided"]').waitFor();
  assert.equal(await page.locator('[data-mcp-server="owned"]').count(),0);assert.equal(count,1);
 }finally{await page.close();}
});

test("plugin uninstallation refreshes the market and management using the installed plugin ID",{skip},async()=>{
 const page=await browser.newPage();let installed=[{id:'lark-cli',name:'飞书 CLI',origin:'custom',version:'1.0.96',mcpServers:[],warnings:[]}];let count=0;
 page.on('dialog',d=>d.accept());await page.route('**/api/v1/settings/plugins**',r=>{if(r.request().method()==='DELETE'){count++;installed=[];}return r.fulfill({json:{installed,available:[],marketplaces:[],warnings:[]}});});
 try{
  await page.goto(url);await page.locator('[data-market-installed]').waitFor();
  await page.locator('.extension-market-manage').click();await page.locator('.settings-list-row').first().waitFor();
  await page.locator('[data-plugin="lark-cli"] [data-extension-menu]').click();
  await page.getByRole('menuitem',{name:'删除'}).click();
  await page.waitForFunction(()=>!document.querySelector('.settings-list-row'));await page.locator('#settingsBack').click();
  await page.waitForFunction(()=>!document.querySelector('[data-market-installed]'));
  assert.equal(await page.locator('[data-market-entry="plugins-larksuite__cli"]').count(),1);assert.equal(count,1);
 }finally{await page.close();}
});

test("catalog details list concrete components first and documentation below without a sidebar card", {skip}, async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 try{
  await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
  assert.ok(await page.locator('.extension-market-placeholder img').count()>10);
  await page.locator(".extension-market-search input").fill("飞书 CLI");
  await page.locator('[data-market-entry="plugins-larksuite__cli"]').click();
  await page.locator('[data-component-section]').first().waitFor();
  assert.equal(await page.locator('.extension-detail-icon img').count(),1);
  const header=await page.locator('.extension-detail-header').innerText();
  assert.match(header,/@larksuite/);assert.match(header,/代码开发/);assert.match(header,/—\s*次安装/);
  assert.equal(await page.locator('.extension-detail-header .extension-detail-provenance').count(),0);
  assert.match(await page.locator('[data-component-section]').first().innerText(),/^技能\s*28/);
  const firstSection=page.locator('[data-component-section]').first();
  assert.equal(await firstSection.locator(".extension-detail-items > li").count(),6);
  assert.equal(await firstSection.locator(".extension-detail-expand").getAttribute("aria-expanded"),"false");
  const description=firstSection.locator(".extension-detail-item-desc").first();
  assert.equal(await description.evaluate(element=>getComputedStyle(element).webkitLineClamp),"1");
  await description.click();assert.equal(await description.getAttribute("data-expanded"),"true");
  await firstSection.locator(".extension-detail-expand").click();
  assert.equal(await firstSection.locator(".extension-detail-items > li").count(),28);
  assert.match(await firstSection.locator(".extension-detail-expand").innerText(),/收起/);
  await firstSection.locator(".extension-detail-expand").click();
  assert.equal(await firstSection.locator(".extension-detail-items > li").count(),6);
  assert.match(await firstSection.innerText(),/lark-approval/);
  assert.equal(await page.locator(".extension-detail-docs-head h2").innerText(),"说明");
  assert.equal(await page.locator(".extension-detail-tabs").count(),0);
  assert.equal(await page.evaluate(()=>{const component=document.querySelector('[data-component-section]');const docs=document.querySelector('[data-extension-docs]');return Boolean(component&&docs&&(component.compareDocumentPosition(docs)&Node.DOCUMENT_POSITION_FOLLOWING));}),true);
  assert.equal(await page.locator(".extension-detail-sidebar").count(),0);
  await page.locator(".extension-detail-back button").click();
  await page.locator(".extension-market-search input").fill("PDF Tools");
  await page.locator('[data-market-entry="plugins-Open-Document-Alliance__PDF-Tools"]').click();
  await page.locator('[data-component-section]').nth(1).waitFor();
  assert.equal(await page.locator('[data-component-section] .extension-detail-items > li').count(),4);
  assert.match(await page.locator('[data-component-section]').nth(1).innerText(),/HTTP/);
  await page.locator(".extension-detail-back button").click();
  await page.locator('[data-market-kind="connectors"]').click();await page.locator(".extension-market-search input").fill("playwright");
  await page.locator('[data-market-entry="connectors-microsoft__playwright"]').click();
  await page.locator('[data-component-section]').waitFor();
  assert.match(await page.locator('[data-component-section]').innerText(),/MCP 服务/);
  assert.match(await page.locator('.extension-detail-facts').innerText(),/传输协议\s*stdio/);
  assert.match(await page.locator('.extension-detail-facts').innerText(),/服务地址\s*本地 stdio 进程/);
  assert.match(await page.locator('.extension-detail-connector-summary').innerText(),/从包内 README 提取/);
  assert.equal(await page.locator(".extension-detail-docs-head h2").innerText(),"Connector 说明");
  assert.equal(await page.locator(".extension-detail-tabs").count(),0);
  assert.equal(await page.locator(".extension-detail-sidebar").count(),0);
  await capture(page,"connector-catalog-detail");
 }finally{await page.close();}
});

test("plugin catalog installs only after confirmed preview and refreshes installed state", {skip}, async () => {
 const page = await browser.newPage(); let failing = true, dialogs = 0, installed = [], posts = 0;
 const preview = { id:'lark-cli', name:'飞书 CLI', fingerprint:'a'.repeat(64), skills:['skills'], commands:[], mcpServers:[], requiresEnv:[], provisionCommand:'lark-cli', warnings:[] };
 page.on('dialog', dialog => {dialogs++;void dialog.dismiss();});
 await page.route('**/api/v1/settings/plugins**', route => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  if(path.includes('/catalog/')) return route.fulfill({json:preview});
  if(request.method()==='POST') {
   posts++; assert.equal(request.postDataJSON().confirmed,true); assert.equal(request.postDataJSON().fingerprint,preview.fingerprint);
   if(failing) return route.fulfill({status:409,json:{error:'Installation conflict'}});
   installed=[{id:'lark-cli',name:'飞书 CLI',origin:'market',enabled:true,mcpServers:[],warnings:[]}];
   return route.fulfill({json:preview});
  }
  return route.fulfill({json:{installed,available:[],marketplaces:[],warnings:[]}});
 });
 try {
  await page.goto(url); await page.locator('[data-market-entry="plugins-larksuite__cli"]').click();
  const install=page.locator('.extension-detail [data-market-not-installed]'); assert.equal(await install.isEnabled(),true);
  await install.click(); await page.locator('#errorToast').filter({hasText:'Installation conflict'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.extension-detail [data-market-not-installed]')?.disabled===false);
  assert.equal(await page.locator('[data-market-installed]').count(),0);
  failing=false; await install.click(); await page.locator('.extension-detail [data-market-installed]').waitFor();
  assert.equal(posts,2);assert.equal(dialogs,0); assert.equal(await page.locator('.extension-detail [data-market-not-installed]').count(),0);
  await page.locator('.extension-detail-back button').click(); await page.locator('.extension-market-manage').click();
  await page.locator('[data-plugin="lark-cli"]').waitFor(); assert.equal(await page.locator('[data-extension-origin="market"]').count(),1);
  await capture(page,'plugin-installed-management');
 } finally { await page.close(); }
});

test("market rows render plain descriptions without README markup", {skip}, async () => {
	const page=await browser.newPage({viewport:{width:1440,height:1000}});
	await page.route("**/api/**",route=>route.fulfill({json:{models:[],providers:[],workspaces:[],sessions:[]}}));
	try{
		await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
		for(const kind of ["plugins","skills","connectors"]){
			await page.locator(`[data-market-kind="${kind}"]`).click();
			const texts=await page.locator(".extension-market-description").allTextContents();
			assert.ok(texts.length>0);
			for(const text of texts){
				assert.ok(text.trim().length>0,`${kind} has an empty description`);
				assert.doesNotMatch(text,/<[a-zA-Z!/]|<!--|!\[|\[[^\]]*\]\(|\*\*|&lt;|&gt;/u,`${kind}: ${text.slice(0,80)}`);
			}
		}
		await capture(page,"plain-descriptions");
	}finally{await page.close();}
});

test("existing Settings management including MCP remains available outside the market", {skip}, async () => {
	const page=await browser.newPage();const errors=[];
	page.on("pageerror",error=>errors.push(error.message));
	await page.route("**/api/**",route=>route.fulfill({json:{installed:[],available:[],marketplaces:[],warnings:[],skills:[],servers:[],models:[],providers:[]}}));
	try{
		await page.goto(url);await page.locator(".extension-market-row").first().waitFor();
		for(const kind of ["plugins","skills"]){
			await page.locator(`[data-market-kind="${kind}"]`).click();
			await page.locator(".extension-market-manage").click();
			await page.locator(`.settings-content[data-page="${kind}"]`).waitFor();
			assert.equal(await page.locator('[data-settings-page="extensionMarket"]').count(),0);
			await page.locator("#settingsBack").click();await page.locator(".extension-market-row").first().waitFor();
			assert.equal(await page.locator(`[data-market-kind="${kind}"]`).getAttribute("aria-pressed"),"true");
		}
		await page.locator(".extension-market-manage").click();
		await page.locator('[data-settings-page="mcp"]').click();
		await page.locator("#settingsMcpNew").click();await page.locator("#settingsMcpEditor").waitFor();
		await page.locator("#settingsBack").click();
		assert.equal(await page.locator('[data-market-kind="connectors"]').count(),1);
		assert.deepEqual(errors,[]);
	}finally{await page.close();}
});
