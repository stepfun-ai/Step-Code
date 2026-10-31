import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run production main/window/preload/IPC together; replace only Electron and process-host boundaries.
const electron = `
import { EventEmitter } from 'node:events';
export const app = new EventEmitter();
let directory = process.env.STEPCODE_DESKTOP_USER_DATA_DIR;
Object.assign(app, { isPackaged: false, dock: { setIcon() {} }, exit: (code) => { process.exitCode = code; }, setPath: (_, value) => { directory = value; },
 setAppLogsPath: () => {}, getPath: () => directory, getVersion: () => 'test', whenReady: async () => {},
 requestSingleInstanceLock: () => true, isReady: () => true, quit: () => { app.emit('before-quit', { preventDefault() {} }); } });
const handlers = new Map();
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
export const contextBridge = { exposeInMainWorld: (name, value) => { globalThis[name] = value; } };
export const ipcRenderer = { invoke: async (name, ...args) => handlers.get(name)(globalThis.event, ...args) };
export const dialog = {}, shell = { openExternal: async () => {}, openPath: async () => {} }, systemPreferences = {};
export const nativeTheme = { shouldUseDarkColors: false }, screen = { getAllDisplays: () => [] };
export const session = { defaultSession: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} } };
export const Menu = { buildFromTemplate: () => ({ popup() {} }) };
export class BrowserWindow extends EventEmitter {
 constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter();
  Object.assign(this.webContents, { mainFrame: { url: 'about:blank' }, setWindowOpenHandler() {} });
  globalThis.target = this; }
 isDestroyed() { return this.destroyed; } isMinimized() { return false; } isFullScreen() { return false; }
 isMaximized() { return false; } getNormalBounds() { return { width: 800, height: 600 }; }
 show() {} focus() {} restore() {} maximize() {}
 loadURL(url) {
  if (globalThis.dirty && this.webContents.mainFrame.url.startsWith('http:')) {
   globalThis.veto?.(); return Promise.reject(new Error('ERR_ABORTED')); }
  this.webContents.mainFrame.url = url; globalThis.event = { sender: this.webContents, senderFrame: this.webContents.mainFrame };
  this.webContents.emit('did-navigate', {}, url);
  if (url.startsWith('http:')) globalThis.loaded?.();
  return Promise.resolve(); }
 close() { this.emit('close', {}); if (globalThis.dirty) { globalThis.veto?.(); return; }
  this.destroyed = true; this.emit('closed'); app.emit('window-all-closed'); }
}
`;
const server = `
export const resolveWebServerEntry = () => process.env.STEPCODE_WEB_PUBLIC_DIR + '/server.js';
export const resolveNodeExecutable = () => 'node';
export const launchWebServer = async () => {
 const running = { origin: 'http://127.0.0.1:51234', launchUrl: 'http://127.0.0.1:51234/', pid: 1,
 exited: new Promise(resolve => { globalThis.hostExit = resolve; }),
 stop: async () => { globalThis.stops = (globalThis.stops ?? 0) + 1; } };
 return running;
};
`;
function data(source: string): string { return `data:text/javascript,${encodeURIComponent(source)}`; }

test("actual main/window invoke chain keeps Host through failed quit, drains restart, and closes clean loading pages", () => {
	const directory = mkdtempSync(join(tmpdir(), "desktop-group-main-"));
	writeFileSync(join(directory, "index.html"), "fixture");
	const replacements = {
		"electron": data(electron),
		"server-host.ts": data(server),
		"shell-environment.ts": data("export const readShellEnvironment = async () => ({ environment: {} });"),
		"node-environment.ts": data("export const addBundledNodeToPath = async ({ environment }) => environment;"),
		"release-envelope.ts": data("export const readReleaseEnvelope = () => undefined;"),
		"menu.ts": data("export const installApplicationMenu = (options) => { globalThis.restartServer = options.restartServer; };"),
	};
	const hook = `import { registerHooks } from 'node:module';
const replacements = ${JSON.stringify(replacements)};
registerHooks({ resolve(specifier, context, next) {
 const key = specifier === 'electron' ? specifier : specifier.split('/').at(-1);
 return replacements[key] ? { url: replacements[key], shortCircuit: true } : next(specifier, context);
} });`;
	try {
		const output = execFileSync(process.execPath, ["--import", data(hook), "--input-type=module", "-e", `
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { app } from 'electron';
import { loadingPageUrl, errorPageUrl } from ${JSON.stringify(new URL("../src/pages.ts", import.meta.url).href)};
import ${JSON.stringify(new URL("../src/preload.ts", import.meta.url).href)};
import ${JSON.stringify(new URL("../src/main.ts", import.meta.url).href)};
let loaded; const ready = new Promise(resolve => { loaded = resolve; }); globalThis.loaded = loaded;
await ready;
mock.timers.enable({ apis: ['setTimeout', 'Date'] });
const bridge = globalThis.stepcodeDesktop;
const target = globalThis.target;
assert.equal(await bridge.getTheme(), null);
await bridge.setTheme('violet');
assert.equal(await bridge.getTheme(), 'violet');
assert.equal(target.options.webPreferences.sandbox, true);
assert.equal(await bridge.beginTagGroupClose(), null);
globalThis.dirty = true;
let claim; globalThis.veto = () => { claim = bridge.beginTagGroupClose(); };
app.quit(); const failed = await claim;
assert.ok(failed); assert.equal(globalThis.stops ?? 0, 0);
assert.equal(await bridge.completeTagGroupClose(failed.attemptId, 'failed'), true);
assert.equal(target.isDestroyed(), false); assert.equal(globalThis.stops ?? 0, 0);
await assert.rejects(bridge.completeTagGroupClose({}, 'saved'), /Invalid/);
// Unexpected Host exit must not discard dirty page or its trusted userData IPC origin.
globalThis.hostExit({ requested: false, signal: null, code: 1, stderr: 'fixture host exit' });
await Promise.resolve(); await Promise.resolve();
assert.equal(target.webContents.mainFrame.url, 'http://127.0.0.1:51234/');
assert.equal(target.isDestroyed(), false);
await bridge.saveTagGroups({ version: 1, groups: [{ key: 'blue', name: 'Protected' }], tags: [['s', 'blue']] });
// Failed explicit restart retains the page and does not clear origin or stop the old Host.
globalThis.restartServer(); const cancelledRestart = await claim;
assert.ok(cancelledRestart);
assert.equal(await bridge.completeTagGroupClose(cancelledRestart.attemptId, 'failed'), true);
await Promise.resolve(); await Promise.resolve();
assert.equal(globalThis.stops ?? 0, 0);
assert.equal((await bridge.readTagGroups()).groups[0].name, 'Protected');
// Explicit restart uses native navigation while retaining origin and invoke access.
globalThis.restartServer(); const restart = await claim;
assert.ok(restart); assert.equal(globalThis.stops ?? 0, 0);
await bridge.saveTagGroups({ version: 1, groups: [{ key: 'blue', name: 'Restart' }], tags: [['s', 'blue']] });
globalThis.dirty = false;
assert.equal(await bridge.completeTagGroupClose(restart.attemptId, 'saved'), true);
mock.timers.tick(0);
await new Promise(resolve => { globalThis.loaded = resolve; });
assert.equal(globalThis.stops, 1); assert.equal(target.isDestroyed(), false);
assert.equal((await bridge.readTagGroups()).groups[0].name, 'Restart');
assert.equal(await bridge.getTheme(), 'violet');
// Clean loading/error pages have no admitted renderer work and close without group invoke access.
await target.loadURL(loadingPageUrl());
await assert.rejects(bridge.readTagGroups(), /unowned renderer/);
target.close(); assert.equal(globalThis.stops, 1);
app.emit('activate');
const errorWindow = globalThis.target;
await errorWindow.loadURL(errorPageUrl('Fixture error', 'fixture', ${JSON.stringify(directory)}));
await assert.rejects(bridge.beginTagGroupClose(), /unowned renderer/);
errorWindow.close(); assert.equal(globalThis.stops, 1);
// macOS activation reconstructs a window on the same stable profile without restarting Host.
app.emit('activate');
assert.equal((await bridge.readTagGroups()).groups[0].name, 'Restart');
assert.equal(await bridge.getTheme(), 'violet');
globalThis.dirty = true;
app.quit(); const quit = await claim;
assert.ok(quit); assert.equal(globalThis.stops, 1);
globalThis.dirty = false;
assert.equal(await bridge.completeTagGroupClose(quit.attemptId, 'saved'), true);
mock.timers.tick(0);
await Promise.resolve(); await Promise.resolve();
assert.equal(globalThis.stops, 2);
console.log('actual lifecycle passed');
`], { encoding: "utf8", timeout: 10000, env: { ...process.env, STEPCODE_DESKTOP_USER_DATA_DIR: directory, STEPCODE_WEB_PUBLIC_DIR: directory, STEPCODE_DESKTOP_SMOKE: "0" } });
		assert.match(output, /actual lifecycle passed/);
	} finally { rmSync(directory, { recursive: true }); }
});
