import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
const root=fileURLToPath(new URL("../..",import.meta.url));
const fixtureId=join(root,"client","extension-management-fixture.tsx");
const chrome=[process.env.CHROME_PATH,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/chromium"].find(path=>path&&existsSync(path));
const skip=chrome?false:"Chrome unavailable";
const fixture=`
import React from "react";import {createRoot} from "react-dom/client";
import "/src/styles/global.css";import {IconSprite} from "/src/ui";import {I18nProvider} from "/src/i18n";
import {SettingsView} from "/src/features/settings";import {Composer} from "/src/features/composer";import {MarketView} from "/src/features/market";import {ErrorToast} from "/src/features/shell";
import {setState,setUi,getState} from "/src/state/store.ts";import {openSettings} from "/src/features/settings/actions.ts";
setState({booted:true,locale:"zh-CN",bootstrapCwd:"/fixture",draftCwd:"/fixture"});setUi({settingsPage:"plugins"});
window.openFixtureSettings=page=>openSettings(page);window.fixtureState=getState;
window.openFixtureMarket=()=>setUi({settingsPage:null,settingsEditor:null,settingsDialog:null,midView:"market"});
createRoot(document.getElementById("root")).render(<I18nProvider><IconSprite/><div className="app"><aside className="sidebar"/><main className="main"><MarketView/><div style={{flex:1}}/><div className="composer-zone"><Composer/></div></main></div><SettingsView/><ErrorToast/></I18nProvider>);
`;
let server,browser,url,cacheDir;
before(async()=>{
 if(skip)return;
 cacheDir=await mkdtemp(join(tmpdir(),'stepcode-management-vite-'));
 server=await createServer({cacheDir,configFile:join(root,"vite.config.ts"),root:join(root,"client"),server:{host:"127.0.0.1",port:0,proxy:{}},plugins:[{name:"management-fixture",resolveId(id){if(id==="/management-fixture.js"||id===fixtureId)return fixtureId;},load(id){if(id===fixtureId)return fixture;},configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=="/management-fixture")return next();res.setHeader("Content-Type","text/html");res.end(`<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/management-fixture.js"></script></body></html>`);});}}]});
 await server.listen();url=`http://127.0.0.1:${server.httpServer.address().port}/management-fixture`;
 browser=await chromium.launch({executablePath:chrome,headless:true});
});
after(async()=>{await browser?.close();await server?.close();if(cacheDir)await rm(cacheDir,{recursive:true,force:true});});
const plugins={installed:["market","custom","stepcode"].map(origin=>({id:`plugin-${origin}`,name:`Plugin ${origin}`,origin,mcpServers:[],warnings:[]})),available:[],marketplaces:[],warnings:[]};
const skills=["market","custom","stepcode","plugin"].map(origin=>({id:`/fixture/${origin}/SKILL.md`,name:`skill-${origin}`,description:"Skill description",origin,source:origin==="plugin"||origin==="stepcode"?"plugin":"user",pluginName:"Provider",location:`/fixture/${origin}`,enabled:true,toggleable:origin==="custom",deletable:origin==="custom"}));
const servers=["custom","stepcode","plugin"].map(origin=>({name:`server-${origin}`,source:origin==="custom"?"user":"plugin",origin,pluginName:"Provider",transport:"stdio",enabled:true,status:"connected",toolCount:1})).concat([{name:"server-disabled",source:"user",origin:"custom",transport:"stdio",enabled:false,status:"disabled",toolCount:0}]);
async function prepare(page){await page.route("**/api/**",route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==="/api/v1/settings/plugins"?plugins:path==="/api/v1/settings/skills"||path==="/api/v1/workspace/skills"?{skills}:path==="/api/v1/settings/mcp"?{servers}:{models:[],presets:[],workspaces:[],sessions:[]}});});}
const creationPrompt=kind=>kind==='skills'?'我想要创建一个新的技能，请引导我补充细节，并在信息完整后帮我创建和安装':'我想要创建一个新的插件，请引导我补充细节，并在信息完整后帮我创建和安装';

test("zero-count source groups stay hidden in every management page",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);
 await page.route('**/api/v1/settings/plugins',route=>route.fulfill({json:{...plugins,installed:plugins.installed.filter(item=>item.origin==='stepcode')}}));
 await page.route('**/api/v1/settings/skills',route=>route.fulfill({json:{skills:skills.filter(item=>item.origin==='plugin')}}));
 await page.route('**/api/v1/settings/mcp',route=>route.fulfill({json:{servers:servers.filter(item=>item.origin==='custom')}}));
 try{
  await page.goto(url);await page.locator('[data-plugin="plugin-stepcode"]').waitFor();
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(node=>node.dataset.extensionOrigin)),['stepcode']);
  await page.locator('[data-settings-page="skills"]').click();await page.locator('[data-source-fold="plugin"] summary').click();await page.locator('[data-skill="skill-plugin"]').waitFor();
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(node=>node.dataset.extensionOrigin)),['plugin']);
  await page.locator('[data-settings-page="mcp"]').click();await page.locator('[data-mcp-server="server-custom"]').waitFor();
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(node=>node.dataset.extensionOrigin)),['custom']);
  await page.locator('.extension-management-search input').fill('no-matching-resource');
  assert.equal(await page.locator('[data-extension-origin]').count(),0);
  assert.equal(await page.locator('#settingsMcpNew').isVisible(),true);
 }finally{await page.close();}
});

test("market and management New menus stay identical and isolated by kind",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);const posts=[];
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/'))posts.push(request.url());});
 try{
  await page.goto(url);
  for(const kind of ['plugins','skills']){
   await page.evaluate(()=>window.openFixtureMarket());await page.locator(`[data-market-kind="${kind}"]`).click();
   await page.locator('#extensionMarketNew').click();
   const marketItems=await page.locator('#extensionMarketAddMenu [role="menuitem"]').allTextContents();
   assert.deepEqual(marketItems,[kind==='plugins'?'导入插件':'导入技能','通过 StepCode 创建']);
   assert.deepEqual(await page.locator('#extensionMarketAddMenu').evaluate(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,border:style.borderTopWidth,shadow:style.boxShadow};}),{background:'rgba(0, 0, 0, 0)',border:'0px',shadow:'none'});
   assert.equal(await page.locator('#extensionMarketAddMenu [data-extension-upload]').count(),1);
   await page.keyboard.press('Escape');await page.locator('.extension-market-manage').click();
   await page.locator(kind==='plugins'?'#settingsPluginNew':'#settingsSkillNew').click();
   assert.deepEqual(await page.locator('.extension-management-create-popover [role="menuitem"]').allTextContents(),marketItems);
   await page.keyboard.press('Escape');await page.locator('#settingsBack').click();
   await page.locator('#extensionMarketNew').click();await page.locator(`#extensionMarketAddMenu [data-extension-create="${kind}"]`).click();
   await page.waitForFunction(text=>document.getElementById('prompt')?.innerText?.trim()===text,creationPrompt(kind));
   assert.equal(await page.locator('#marketView').isVisible(),false);
  }
  assert.deepEqual(posts,[]);
 }finally{await page.close();}
});

async function capture(page,name){if(!process.env.MANAGEMENT_SCREENSHOT_DIR)return;await mkdir(process.env.MANAGEMENT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({animations:'disabled',path:join(process.env.MANAGEMENT_SCREENSHOT_DIR,`${name}.png`)});}

test("management rows expose the shared overflow menu and trash only where permissions allow",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);
 try{
  await page.goto(url);await page.locator('[data-plugin]').first().waitFor();
  assert.equal(await page.locator('[data-extension-menu]').count(),3);
  assert.equal(await page.locator('[data-extension-menu]').first().evaluate(e=>getComputedStyle(e).opacity),'1');
  assert.equal(await page.locator('[data-extension-menu] svg use').first().getAttribute('href'),'#i-more');
  await page.locator('[data-plugin="plugin-market"] [data-extension-menu]').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['试用','删除']);
  assert.equal(await page.getByRole('menuitem').first().locator('use').getAttribute('href'),'#i-play');
  assert.equal(await page.getByRole('menuitem').nth(1).locator('use').getAttribute('href'),'#i-trash');
  await page.keyboard.press('Escape');
  await capture(page,'plugin-row-menu');
  await page.locator('[data-settings-page="skills"]').click();await page.locator('[data-skill]').first().waitFor();
  assert.equal(await page.locator('[data-extension-menu]').count(),4);
  assert.equal(await page.locator('[data-skill="skill-custom"] [data-extension-menu]').evaluate(e=>getComputedStyle(e).opacity),'1');
  await page.locator('[data-skill="skill-custom"] [data-extension-menu]').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['试用','删除']);
  await page.keyboard.press('Escape');
  await page.locator('[data-source-fold="plugin"] summary').click();
   await page.locator('[data-skill="skill-plugin"] [data-extension-menu]').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['试用']);
  await page.keyboard.press('Escape');
  await capture(page,'skill-row-menu');
  await page.locator('[data-settings-page="mcp"]').click();await page.locator('[data-mcp-server]').first().waitFor();
  assert.equal(await page.locator('[data-extension-menu]').count(),4);
  await page.locator('[data-mcp-server="server-custom"] [data-extension-menu]').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['试用','删除']);await page.keyboard.press('Escape');
  await page.locator('[data-source-fold="plugin"] summary').click();
  await page.locator('[data-mcp-server="server-plugin"] [data-extension-menu]').click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['试用']);await page.keyboard.press('Escape');
  await capture(page,'shared-delete-ui');
 }finally{await page.close();}
});

test("plugin management switch persists real state and retains uninstall UI",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);let enabled=true;const patches=[];
 await page.route('**/api/v1/settings/plugins**',r=>{if(r.request().method()==='PATCH'){const data=r.request().postDataJSON();patches.push(data);enabled=data.enabled;}return r.fulfill({json:{...plugins,installed:[{id:'test-plugin',name:'Test plugin',origin:'custom',enabled,mcpServers:[],warnings:[]}]}});});
 try{
  await page.goto(url);await page.locator('[data-plugin="test-plugin"]').waitFor();
  assert.equal(await page.locator('[data-plugin="test-plugin"] [role="switch"]').count(),1);
  await capture(page,'plugin-enabled');
  await page.locator('[data-plugin="test-plugin"] [role="switch"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-plugin="test-plugin"] [role="switch"]')?.getAttribute('aria-checked')==='false');
  assert.equal(await page.locator('[data-extension-menu]').count(),1);
  await capture(page,'plugin-disabled');
  await page.locator('[data-plugin="test-plugin"] [role="switch"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-plugin="test-plugin"] [role="switch"]')?.getAttribute('aria-checked')==='true');
  assert.deepEqual(patches,[{enabled:false},{enabled:true}]);
 }finally{await page.close();}
});

test("management pages omit bottom helper links while keeping top controls",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);
 try{
  await page.goto(url);await page.locator('#settingsPluginNew').waitFor();
  assert.equal(await page.locator('.settings-footnote').count(),0);
  assert.equal(await page.locator('.extension-management-links').count(),0);
  assert.equal(await page.locator('#settingsView button[aria-label="刷新"]').count(),1);
  await page.locator('[data-settings-page="skills"]').click();await page.locator('#settingsSkillNew').waitFor();
  assert.equal(await page.locator('.extension-management-links').count(),0);
  await page.locator('[data-settings-page="mcp"]').click();await page.locator('#settingsMcpNew').waitFor();
  assert.equal(await page.locator('.extension-management-links').count(),0);
  await page.locator('#settingsMcpNew').click();await page.locator('#settingsMcpEditor').waitFor();
 }finally{await page.close();}
});

test("management groups resources by actual origin with compact source sections",{skip},async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await prepare(page);
 try{
  await page.goto(url);await page.locator('[data-plugin="plugin-market"]').waitFor();
  assert.match(await page.locator('.settings-nav').innerText(),/拓展管理/);
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(n=>n.dataset.extensionOrigin)),['market','custom','stepcode']);
  assert.equal(await page.locator('[data-extension-origin="stepcode"] [data-plugin="plugin-stepcode"]').count(),1);
  await page.locator('[data-settings-page="skills"]').click();await page.locator('[data-skill="skill-custom"]').waitFor();
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(n=>n.dataset.extensionOrigin)),['market','custom','stepcode','plugin']);
  assert.equal(await page.locator('.settings-empty-box').count(),0);
  if(process.env.MANAGEMENT_SCREENSHOT_DIR){await mkdir(process.env.MANAGEMENT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({animations:'disabled',path:join(process.env.MANAGEMENT_SCREENSHOT_DIR,'skills-management.png')});}
  await page.locator('[data-settings-page="mcp"]').click();await page.locator('[data-mcp-server="server-custom"]').waitFor();
  assert.deepEqual(await page.locator('[data-extension-origin]').evaluateAll(nodes=>nodes.map(n=>n.dataset.extensionOrigin)),['custom','stepcode','plugin']);
  await page.locator('#settingsMcpNew').click();await page.locator('#settingsMcpEditor').waitFor();
 }finally{await page.close();}
});

test("StepCode creation starts a new draft with the exact requested prompt without sending",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);const sent=[];
 page.on('request',request=>{if(request.method()==='POST'&&/\/(prompt|messages|sessions)(\/|$)/.test(new URL(request.url()).pathname))sent.push(request.url());});
 try{
  await page.goto(url);await page.locator('#settingsPluginNew').waitFor();
  
  for(const [kind,id] of [['plugins','settingsPluginNew'],['skills','settingsSkillNew']]){
   const expected=creationPrompt(kind);
   await page.evaluate(kind=>window.openFixtureSettings(kind),kind);await page.locator(`#${id}`).click();
   const before=await page.evaluate(()=>window.fixtureState().composerDraftId);
   await page.locator(`[data-extension-create="${kind}"]`).click();
   await page.waitForFunction(text=>document.getElementById('prompt')?.innerText?.trim()===text,expected);
   assert.notEqual(await page.evaluate(()=>window.fixtureState().composerDraftId),before);
   assert.equal(await page.locator('#settingsView').isVisible(),false);
   assert.equal(await page.evaluate(()=>window.fixtureState().current),null);
  }
  assert.deepEqual(sent,[]);
 }finally{await page.close();}
});
test("slash menu offers plugin, skill and connector references with token-safe insertion",{skip},async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await prepare(page);const mutations=[];
 page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/'))mutations.push(request.method());});
 try{
  await page.goto(url);await page.locator('#settingsBack').click();
  const prompt=page.locator('#prompt');await prompt.fill('/');
  await page.locator('[data-slash-kind="plugin"]').first().waitFor();await page.locator('[data-slash-kind="connector"]').first().waitFor();
  assert.match(await page.locator('#slashMenu').innerText(),/插件/);assert.match(await page.locator('#slashMenu').innerText(),/技能/);assert.match(await page.locator('#slashMenu').innerText(),/连接器/);
  assert.equal(await page.locator('[data-slash-jump]').count(),3);
  await page.locator('[data-slash-jump="plugins"]').click();
  assert.equal(await page.locator('.slash-item.active').getAttribute('data-slash-kind'),'plugin');
  assert.equal(await page.locator('[data-slash-kind="connector"][data-slash-key="server-disabled"]').getAttribute('aria-disabled'),'true');
  await prompt.fill('/plugin:market');await page.locator('[data-slash-kind="plugin"][data-slash-key="plugin-market"]').click();
  assert.equal(await page.locator('[data-pick-kind="plugin"]').count(),1);assert.equal(await prompt.innerText(),'');
  await prompt.fill('/connector:server-custom');await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-pick-kind="connector"]').count(),1);assert.equal(await prompt.innerText(),'');
  await prompt.fill('/skill:skill-custom');await page.locator('[data-slash-kind="skill"][data-slash-key="skill-custom"]').click();
  assert.match(await prompt.textContent(),/\/skill:skill-custom/);
  await page.keyboard.type(' 整理资料 /connector:server-stepcode');await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-pick-kind="connector"]').count(),2);
  assert.match(await prompt.textContent(),/\/skill:skill-custom/);assert.match(await prompt.textContent(),/整理资料/);assert.doesNotMatch(await prompt.textContent(),/connector:server-stepcode/);
  await page.locator('[data-pick-kind="connector"]').first().locator('button').click();assert.equal(await page.locator('[data-pick-kind="connector"]').count(),1);
  await prompt.fill('/connector:server-disabled');await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-pick-kind="connector"]').count(),1);
  assert.deepEqual(mutations,[]);
  await prompt.fill('/');
  if(process.env.MANAGEMENT_SCREENSHOT_DIR){await mkdir(process.env.MANAGEMENT_SCREENSHOT_DIR,{recursive:true});await page.locator('[data-slash-kind="plugin"]').first().scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:join(process.env.MANAGEMENT_SCREENSHOT_DIR,'slash-references.png')});}
 }finally{await page.close();}
});

test("slash references keep available groups when another resource source fails",{skip},async()=>{
 const page=await browser.newPage();await prepare(page);
 await page.route('**/api/v1/settings/plugins',route=>route.fulfill({status:500,json:{error:'fixture unavailable'}}));
 try{
  await page.goto(url);await page.locator('#settingsBack').click();await page.locator('#prompt').fill('/');
  await page.locator('[data-slash-kind="skill"]').first().waitFor();await page.locator('[data-slash-kind="connector"]').first().waitFor();
  assert.match(await page.locator('#slashMenu [role="alert"]').innerText(),/部分拓展读取失败/);
  assert.equal(await page.locator('[data-slash-kind="plugin"]').count(),0);
 }finally{await page.close();}
});

test("plugin import previews bytes and reports success only after server installation", {skip}, async () => {
 const page=await browser.newPage(); await prepare(page); let fail=true, imported=false, dialogs=0; const requests=[];
 const preview={id:'imported',name:'Imported plugin',fingerprint:'b'.repeat(64),skills:[],commands:[],mcpServers:[],requiresEnv:[],warnings:[]};
 page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
 await page.route('**/api/v1/settings/plugins**',route=>{
  const request=route.request(); const path=new URL(request.url()).pathname;
  if(path.endsWith('/import')) {
   const data=request.postDataJSON(); requests.push(data); assert.ok(data.data.length>0);
   if(fail) return route.fulfill({status:400,json:{error:'Invalid ZIP contents'}});
   if(data.confirmed) {assert.equal(data.fingerprint,preview.fingerprint);imported=true;}
   return route.fulfill({json:{preview,installed:Boolean(data.confirmed)}});
  }
  return route.fulfill({json:{installed:imported?[{id:'imported',name:'Imported plugin',origin:'custom',enabled:true,mcpServers:[],warnings:[]}]:[],available:[],marketplaces:[],warnings:[]}});
 });
 const select=()=>page.locator('#settingsView input[accept=".zip"]').setInputFiles({name:'plugin.zip',mimeType:'application/zip',buffer:Buffer.from('transport fixture')});
 try {
  await page.goto(url); await page.locator('#settingsPluginNew').waitFor();
  await select();await page.locator('#errorToast').filter({hasText:'Invalid ZIP contents'}).waitFor();
  assert.equal(requests.length,1); assert.equal(imported,false); assert.equal(await page.locator('[data-plugin="imported"]').count(),0);
  
  fail=false; await select(); await page.locator('[data-plugin="imported"]').waitFor();assert.equal(dialogs,0);
  assert.equal(requests.at(-1).confirmed,true); assert.match(await page.locator('#errorToast').innerText(),/Imported plugin 已安装/);
 } finally {await page.close();}
});

test("skill market installation is confirmed, refreshes management and allows disabling", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let dialogs=0,installed=false,enabled=true,posts=0;
 const id='skills-user_3b34947d__ppt-generator-skill';
 const preview={id:'ppt-generator',name:'ppt-generator',fingerprint:'c'.repeat(64),skills:['ppt-generator'],commands:[],mcpServers:[],requiresEnv:[],warnings:[]};
 page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
 await page.route('**/api/v1/settings/skills**',route=>{
  const request=route.request();const path=new URL(request.url()).pathname;
  if(path.includes('/catalog/'))return route.fulfill({json:preview});
  if(request.method()==='POST'){posts++;assert.equal(request.postDataJSON().fingerprint,preview.fingerprint);installed=true;return route.fulfill({json:preview});}
  if(request.method()==='PATCH')enabled=request.postDataJSON().enabled;
  return route.fulfill({json:{skills:installed?[{id:'/fixture/ppt/SKILL.md',name:'ppt-generator',description:'PPT',source:'user',origin:'market',catalogId:id,location:'~/skills/ppt-generator',enabled,toggleable:true,deletable:true}]:[]}});
 });
 try{
  await page.goto(url);await page.evaluate(()=>window.openFixtureMarket());await page.locator('[data-market-kind="skills"]').click();
  await page.locator(`[data-market-entry="${id}"]`).click();const install=page.locator('.extension-detail [data-market-not-installed]');
  
  await install.click();await page.locator('.extension-detail [data-market-installed]').waitFor();assert.equal(posts,1);assert.equal(dialogs,0);
  await page.locator('.extension-detail-back button').click();await page.locator('.extension-market-manage').click();await page.locator('[data-skill="ppt-generator"]').waitFor();
  await page.locator('[data-skill="ppt-generator"] [role="switch"]').click();await page.waitForFunction(()=>document.querySelector('[data-skill="ppt-generator"] [role="switch"]')?.getAttribute('aria-checked')==='false');
  await capture(page,'skill-installed-disabled');
 }finally{await page.close();}
});

test("skill upload reads SKILL.md, confirms API result and keeps failures uninstalled", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let installed=false,fail=false,dialogs=0;const posts=[];
 const preview={id:'imported-skill',name:'imported-skill',fingerprint:'d'.repeat(64),skills:['imported-skill'],commands:[],mcpServers:[],requiresEnv:[],warnings:[]};
 page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
 await page.route('**/api/v1/settings/skills**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path.endsWith('/upload')){const data=request.postDataJSON();posts.push(data);assert.equal(data.format,'markdown');
   assert.match(Buffer.from(data.data,'base64').toString(),/name: imported-skill/);
   if(fail)return route.fulfill({status:400,json:{error:'Invalid skill contents'}});
   installed=Boolean(data.confirmed);return route.fulfill({json:{preview,installed}});
  }
  return route.fulfill({json:{skills:installed?[{id:'/fixture/imported/SKILL.md',name:'imported-skill',description:'Test',source:'user',origin:'custom',location:'~/skills/imported',enabled:true,toggleable:true,deletable:true}]:[]}});
 });
 try{
  await page.goto(url);await page.locator('[data-settings-page="skills"]').click();await page.locator('#settingsSkillNew').waitFor();
  const select=()=>page.locator('#settingsView input[accept=".zip,.skill,.md"]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: imported-skill\ndescription: Test\n---\n# Test')});
  fail=true;await select();await page.locator('#errorToast').filter({hasText:'Invalid skill contents'}).waitFor();assert.equal(installed,false);
  fail=false;await select();await page.locator('[data-skill="imported-skill"]').waitFor();assert.equal(posts.at(-1).confirmed,true);
  assert.match(await page.locator('#errorToast').innerText(),/imported-skill 已安装/);assert.equal(dialogs,0);
 }finally{await page.close();}
});

test("connector catalog opens an editable template, saves by consent and exposes trial", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let saved;const posts=[];
 page.on('dialog',dialog=>dialog.accept());
 await page.route('**/api/v1/settings/mcp**',route=>{
  if(route.request().method()==='POST'){saved=route.request().postDataJSON();posts.push(saved);return route.fulfill({json:{ok:true}});}
  return route.fulfill({json:{servers:saved?[{name:saved.name,source:'user',origin:'custom',transport:'stdio',config:saved.config,enabled:true}]:[]}});
 });
 try{
  await page.goto(url);await page.evaluate(()=>window.openFixtureMarket());await page.locator('[data-market-kind="connectors"]').click();
  await page.locator('[data-market-entry="connectors-microsoft__playwright"]').click();await page.locator('[data-market-configure]').click();await page.locator('#settingsMcpEditor').waitFor();
  assert.equal(posts.length,0);await page.getByRole('button',{name:'JSON',exact:true}).click();
  const json=await page.locator('#settingsMcpEditor textarea').inputValue();assert.match(json,/@playwright\/mcp@latest/);assert.match(json,/playwright/);
  await page.locator('#settingsMcpEditor button[type="submit"]').click();await page.locator('[data-mcp-server="playwright"]').waitFor();assert.equal(posts.length,1);
  await page.locator('[data-mcp-server="playwright"] [data-extension-menu]').click();await page.getByRole('menuitem',{name:'试用'}).click();
  await page.locator('#settingsView').waitFor({state:'hidden'});assert.match(await page.locator('[data-pick-kind="connector"]').innerText(),/playwright/);assert.equal((await page.locator('#prompt').innerText()).trim(),'');
  await capture(page,'connector-template-trial');
 }finally{await page.close();}
});

test("trial stages exactly one extension reference and leaves the message body empty", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);const mutations=[];
 page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/'))mutations.push(request.method());});
 try {
  await page.goto(url);await page.locator('#settingsBack').click();await page.locator('#prompt').fill('Previous draft text');
  for(const [settings,row,kind,name] of [
   ['plugins','[data-plugin="plugin-custom"]','plugin','Plugin custom'],
   ['skills','[data-skill="skill-custom"]','skill','skill-custom'],
   ['mcp','[data-mcp-server="server-custom"]','connector','server-custom'],
   ['skills','[data-skill="skill-custom"]','skill','skill-custom'],
  ]) {
   const before=await page.evaluate(()=>window.fixtureState().composerDraftId);
   await page.evaluate(settings=>window.openFixtureSettings(settings),settings);await page.locator(`${row} [data-extension-menu]`).click();
   await page.getByRole('menuitem',{name:'试用'}).click();await page.locator('#settingsView').waitFor({state:'hidden'});
   assert.notEqual(await page.evaluate(()=>window.fixtureState().composerDraftId),before);
   assert.equal(await page.locator(`[data-pick-kind="${kind}"]`).count(),1);assert.equal(await page.locator('[data-pick-kind]').count(),1);
   assert.match(await page.locator(`[data-pick-kind="${kind}"]`).innerText(),new RegExp(name));
   assert.equal((await page.locator('#prompt').innerText()).trim(),'');
   assert.equal(await page.evaluate(()=>window.fixtureState().ui.promptDraftRequest),undefined);
  }
  await capture(page,'trial-reference-only');await page.locator('[data-pick-kind] button').click();assert.equal(await page.locator('[data-pick-kind]').count(),0);
  assert.deepEqual(mutations,[]);
 }finally{await page.close();}
});

test("catalog and live detail trials reference actual installed identities without body text", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);const mutations=[];
 page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/'))mutations.push(request.method());});
 await page.route('**/api/v1/settings/plugins',route=>route.fulfill({json:{installed:[{id:'lark-cli',name:'Local Lark Tools',enabled:true,mcpServers:[],warnings:[]}],available:[],marketplaces:[],warnings:[]}}));
 await page.route('**/api/v1/settings/skills',route=>route.fulfill({json:{skills:[{id:'/fixture/ppt/SKILL.md',name:'ppt-generator',description:'PPT',source:'user',catalogId:'skills-user_3b34947d__ppt-generator-skill',location:'~/skills/ppt',enabled:true,toggleable:true,deletable:true}]}}));
 await page.route('**/api/v1/settings/mcp',route=>route.fulfill({json:{servers:[{name:'playwright',source:'user',transport:'stdio',enabled:true},{name:'local-live',source:'user',transport:'stdio',enabled:true}]}}));
 try {
  await page.goto(url);
  for(const [kind,id,reference,name] of [
   ['plugins','plugins-larksuite__cli','plugin','Local Lark Tools'],
   ['skills','skills-user_3b34947d__ppt-generator-skill','skill','ppt-generator'],
   ['connectors','connectors-microsoft__playwright','connector','playwright'],
   ['connectors','connector:local-live','connector','local-live'],
  ]) {
   await page.evaluate(()=>window.openFixtureMarket());await page.locator(`[data-market-kind="${kind}"]`).click();
   await page.locator(`[data-market-entry="${id}"]`).click();await page.locator('[data-market-trial]').click();
   await page.locator(`[data-pick-kind="${reference}"]`).waitFor();
   assert.match(await page.locator(`[data-pick-kind="${reference}"]`).innerText(),new RegExp(name));
   assert.equal((await page.locator('#prompt').innerText()).trim(),'');assert.equal(await page.locator('[data-pick-kind]').count(),1);
  }
  assert.deepEqual(mutations,[]);
 }finally{await page.close();}
});

test("MCP editor hides developer notes and keeps Form/JSON horizontal at responsive widths", {skip}, async () => {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await prepare(page);
 try{
  await page.goto(url);await page.evaluate(()=>window.openFixtureMarket());await page.locator('[data-market-kind="connectors"]').click();
  await page.locator('[data-market-entry="connectors-aliyun__alibabacloud-devops-mcp-server"]').click();await page.locator('[data-market-configure]').click();await page.locator('#settingsMcpEditor').waitFor();
  const header=page.locator('#settingsMcpEditor .settings-editor-head');
  assert.doesNotMatch(await header.innerText(),/配置模板仅|来源：|README|configure YUNXIAO/);
  await header.locator('h1').evaluate(element=>element.textContent='添加 MCP 服务器连接器配置 '.repeat(8));
  for(const width of [1440,900,760,600]){
   await page.setViewportSize({width,height:1000});
   const layout=await header.evaluate(element=>{
    const control=element.querySelector('.settings-mode-switch'),buttons=[...control.querySelectorAll('button')];
    return {right:control.getBoundingClientRect().right,headerRight:element.getBoundingClientRect().right,
     heights:buttons.map(button=>button.getBoundingClientRect().height),whiteSpace:buttons.map(button=>getComputedStyle(button).whiteSpace),shrink:getComputedStyle(control).flexShrink};
   });
   assert.equal(layout.shrink,'0');assert.ok(layout.whiteSpace.every(value=>value==='nowrap'));
   assert.ok(Math.abs(layout.heights[0]-layout.heights[1])<1);assert.ok(layout.heights.every(height=>height<40));
   assert.ok(layout.right<=layout.headerRight+1);
  }
  await page.setViewportSize({width:1440,height:1000});await header.locator('h1').evaluate(element=>element.textContent='添加 MCP 服务器');
  await page.getByRole('button',{name:'JSON',exact:true}).click();assert.match(await page.locator('#settingsMcpEditor textarea').inputValue(),/openapi-rdc.aliyuncs.com/);
  await page.getByRole('button',{name:'表单',exact:true}).click();assert.equal(await page.locator('#settingsMcpEditor input[value="aliyun-devops"]').count(),1);
  await capture(page,'mcp-editor-clean-layout');
 }finally{await page.close();}
});

test("plugin and skill Install clicks complete without any second confirmation dialog", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let dialogs=0;const posts=[];
 page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
 for(const [kind,catalogId,name] of [['plugins','plugins-larksuite__cli','lark-cli'],['skills','skills-user_3b34947d__ppt-generator-skill','ppt-generator']]){
  let installed=false;const preview={id:name,name,fingerprint:'e'.repeat(64),skills:[],commands:[],mcpServers:[],requiresEnv:[],warnings:[]};
  await page.route(`**/api/v1/settings/${kind}**`,route=>{
   if(new URL(route.request().url()).pathname.includes('/catalog/'))return route.fulfill({json:preview});
   if(route.request().method()==='POST'){const input=route.request().postDataJSON();assert.equal(input.fingerprint,preview.fingerprint);assert.equal(input.confirmed,true);posts.push(kind);installed=true;return route.fulfill({json:preview});}
   return route.fulfill({json:kind==='plugins'?{installed:installed?[{id:name,name,enabled:true,mcpServers:[],warnings:[]}]:[],available:[],marketplaces:[],warnings:[]}:{skills:installed?[{id:`/fixture/${name}/SKILL.md`,name,description:'Test',source:'user',catalogId,location:'~/skills/test',enabled:true,toggleable:true,deletable:true}]:[]}});
  });
 }
 try{
  await page.goto(url);
  for(const [kind,id] of [['plugins','plugins-larksuite__cli'],['skills','skills-user_3b34947d__ppt-generator-skill']]){
   await page.evaluate(()=>window.openFixtureMarket());await page.locator(`[data-market-kind="${kind}"]`).click();await page.locator(`[data-market-entry="${id}"]`).click();
   await Promise.all([page.waitForResponse(r=>r.url().includes(`/settings/${kind}/catalog/`)),page.locator('.extension-detail [data-market-not-installed]').click()]);
   await page.waitForFunction(()=>document.querySelector('.extension-detail [data-market-not-installed]')?.disabled!==true);
   assert.equal(dialogs,0);await page.locator('.extension-detail [data-market-installed]').waitFor();await page.locator('.extension-detail-back button').click();
  }
  assert.deepEqual(posts,['plugins','skills']);
 }finally{await page.close();}
});

test("plugin dependency status supports automatic preparation and shows first-use configuration", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let prepared=false,dialogs=0;
 const dependency=()=>({command:'dws',status:prepared?'installed':'setup_required',reason:prepared?undefined:'missing',setupCommand:'dws auth login',firstUseConfiguration:true});
 page.on('dialog',dialog=>{dialogs++;void dialog.dismiss();});
 await page.route('**/api/v1/settings/plugins**',route=>{
  if(new URL(route.request().url()).pathname.endsWith('/prepare')){prepared=true;return route.fulfill({json:{dependency:dependency()}});}
  return route.fulfill({json:{installed:[{id:'dingtalk-cli',name:'钉钉 CLI',enabled:true,origin:'market',dependency:dependency(),mcpServers:[],warnings:[]}],available:[],marketplaces:[],warnings:[]}});
 });
 try {
  await page.goto(url);await page.locator('[data-plugin="dingtalk-cli"]').waitFor();
  assert.match(await page.locator('[data-plugin-setup]').innerText(),/首次使用需要配置/);
  await page.getByRole('button',{name:'准备 CLI',exact:true}).click();await page.locator('[data-plugin-setup="installed"]').waitFor();
  const message=await page.locator('#errorToast').innerText();assert.match(message,/已自动安装/);assert.match(message,/首次使用需要配置/);
  assert.doesNotMatch(message,/请另行安装|本次未执行依赖安装/);assert.equal(dialogs,0);
  await capture(page,'plugin-cli-prepared-first-use');
 }finally{await page.close();}
});

test("dependency installation failure reports setup-needed rather than full readiness", {skip}, async () => {
 const page=await browser.newPage();await prepare(page);let installed=false;
 const preview={id:'dingtalk-cli',name:'钉钉 CLI',fingerprint:'f'.repeat(64),skills:['skills'],commands:[],mcpServers:[],requiresEnv:[],provisionCommand:'dws',warnings:[]};
 const dependency={command:'dws',status:'setup_required',reason:'install_failed',setupCommand:'dws auth login',firstUseConfiguration:true};
 await page.route('**/api/v1/settings/plugins**',route=>{
  if(new URL(route.request().url()).pathname.includes('/catalog/'))return route.fulfill({json:preview});
  if(route.request().method()==='POST'){installed=true;return route.fulfill({json:{...preview,dependency}});}
  return route.fulfill({json:{installed:installed?[{id:'dingtalk-cli',name:'钉钉 CLI',enabled:true,dependency,mcpServers:[],warnings:[]}]:[],available:[],marketplaces:[],warnings:[]}});
 });
 try{
  await page.goto(url);await page.evaluate(()=>window.openFixtureMarket());await page.locator('[data-market-entry="plugins-DingTalk-Real-AI__dingtalk-workspace-cli"]').click();
  await page.locator('[data-market-not-installed]').click();await page.locator('[data-market-installed]').waitFor();
  const toast=page.locator('#errorToast');assert.match(await toast.innerText(),/首次使用需要配置/);assert.match(await toast.innerText(),/自动安装失败/);assert.equal(await toast.getAttribute('data-tone'),'neutral');
  await capture(page,'plugin-cli-needs-setup');
 }finally{await page.close();}
});

test("disabled plugins disappear from references and enabled plugin trials leave settings", {skip}, async () => {
 const page=await browser.newPage(); await prepare(page);
 await page.route('**/api/v1/settings/plugins',route=>route.fulfill({json:{...plugins,installed:[
  {id:'enabled',name:'Enabled plugin',origin:'custom',enabled:true,mcpServers:[],warnings:[]},
  {id:'disabled',name:'Disabled plugin',origin:'custom',enabled:false,mcpServers:[],warnings:[]},
 ]}}));
 try {
  await page.goto(url); await page.locator('[data-plugin="enabled"]').waitFor();
  await page.locator('[data-plugin="disabled"] [data-extension-menu]').click(); assert.equal(await page.getByRole('menuitem',{name:'试用'}).isEnabled(),false); await page.keyboard.press('Escape');
  await page.locator('[data-plugin="enabled"] [data-extension-menu]').click(); await page.getByRole('menuitem',{name:'试用'}).click();
  await page.locator('#settingsView').waitFor({state:'hidden'}); assert.match(await page.locator('[data-pick-kind="plugin"]').innerText(),/Enabled plugin/);assert.equal((await page.locator('#prompt').innerText()).trim(),'');
  await page.locator('#prompt').fill('/'); await page.locator('[data-slash-kind="plugin"]').waitFor(); assert.equal(await page.locator('[data-slash-key="disabled"]').count(),0);
  await page.locator('#prompt').fill(''); await page.locator('#plusTrigger').click(); await page.locator('[data-plus-sub="plugins"]').hover();
  await page.locator('.plus-sub-row').filter({hasText:'Enabled plugin'}).waitFor(); assert.equal(await page.locator('.plus-sub-row').filter({hasText:'Disabled plugin'}).count(),0);
 } finally {await page.close();}
});

test("composer directly stages removable plugin, skill and connector references without enabling services",{skip},async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await prepare(page);const mutations=[];
 page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/'))mutations.push(request.method());});
 try{
  await page.goto(url);await page.locator('#settingsBack').click();
  for(const [sub,name,kind] of [['plugins','Plugin market','plugin'],['skills','skill-custom','skill'],['connectors','server-custom','connector']]){
   await page.locator('#plusTrigger').click();await page.locator(`[data-plus-sub="${sub}"]`).hover();
   const row=page.locator('.plus-sub-row').filter({hasText:name});await row.waitFor();
   if(sub==='connectors')assert.equal(await page.locator('.plus-sub-row').filter({hasText:'server-disabled'}).isEnabled(),false);
   await row.click();assert.equal(await page.locator(`[data-pick-kind="${kind}"]`).count(),1);
  }
  assert.equal(await page.locator('[data-pick-kind]').count(),3);
  assert.match(await page.locator('[data-pick-kind="connector"]').getAttribute('title'),/不自动启用/);
  if(process.env.MANAGEMENT_SCREENSHOT_DIR){await mkdir(process.env.MANAGEMENT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({animations:'disabled',path:join(process.env.MANAGEMENT_SCREENSHOT_DIR,'references.png')});}
  await page.locator('[data-pick-kind="connector"] button').click();assert.equal(await page.locator('[data-pick-kind="connector"]').count(),0);
  await page.evaluate(()=>window.openFixtureSettings('plugins'));await page.locator('#settingsPluginNew').click();
  await page.locator('[data-extension-create="plugins"]').click();
  await page.waitForFunction(()=>document.getElementById('prompt')?.innerText?.includes('我想要创建一个新的插件'));
  assert.equal(await page.locator('[data-pick-kind]').count(),0);
  assert.deepEqual(mutations,[]);
 }finally{await page.close();}
});
