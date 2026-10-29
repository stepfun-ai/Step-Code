import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Replace only Electron's transport; retain the real preload, handlers, sender checks and disk store.
const electron = `
const handlers = new Map();
export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
export const contextBridge = { exposeInMainWorld: (name, value) => { globalThis[name] = value; } };
export const ipcRenderer = { invoke: async (channel, ...args) => handlers.get(channel)(globalThis.event, ...args) };
export const app = {}, dialog = {}, shell = {};
`;
const hook = `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
	return specifier === "electron" ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(electron)}`)}, shortCircuit: true } : next(specifier, context);
} });
`;

test("preload IPC persists before immediate close and rejects unowned, iframe, wrong-origin and invalid calls", () => {
	const directory = mkdtempSync(join(tmpdir(), "desktop-group-ipc-"));
	const path = join(directory, "desktop-state.json");
	try {
		const output = execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { mkdirSync, readFileSync, rmSync } from "node:fs";
			import { installDesktopIpc } from ${JSON.stringify(new URL("../src/ipc.ts", import.meta.url).href)};
			import ${JSON.stringify(new URL("../src/preload.ts", import.meta.url).href)};
			import { TagGroupCloseOwner } from ${JSON.stringify(new URL("../src/tag-group-close.ts", import.meta.url).href)};
			import { DesktopStateStore } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
			const frame = { url: "http://127.0.0.1:51234/" };
			const contents = { mainFrame: frame };
			let destroyed = false;
			let origin = "http://127.0.0.1:51234";
			let closes = 0;
			const window = { webContents: contents, isDestroyed: () => destroyed, close: () => { closes++; } };
			const groupClose = new TagGroupCloseOwner(() => {});
			const owned = { sender: contents, senderFrame: frame };
			globalThis.event = owned;
			const state = new DesktopStateStore(${JSON.stringify(path)});
			state.update({ window: { width: 800, height: 600, maximized: false }, lastWorkspace: ${JSON.stringify(directory)} });
			installDesktopIpc({ state, groupClose, getWindow: () => window, getServerOrigin: () => origin, onDirectoryPicked: () => {} });
			const bridge = globalThis.stepcodeDesktop;
			const data = { version: 1, groups: [{ key: "red", name: "Confirmed" }], tags: [["s1", "red"]] };
			assert.equal(await bridge.readTagGroups(), null);
			await bridge.saveTagGroups(data);
			assert.equal(await bridge.getTheme(), null);
			await bridge.setTheme("violet");
			assert.deepEqual(await bridge.readTagGroups(), data);
			await bridge.saveTagGroups(data);
			assert.equal(await bridge.getTheme(), "violet");
			const diskBeforeFailure = readFileSync(${JSON.stringify(path)}, "utf8");
			const temporary = ${JSON.stringify(path)} + '.' + process.pid + '.tmp';
			mkdirSync(temporary);
			await assert.rejects(bridge.setTheme("dark"), /Could not persist desktop theme/);
			assert.equal(await bridge.getTheme(), "dark");
			assert.deepEqual(await bridge.readTagGroups(), data);
			assert.equal(readFileSync(${JSON.stringify(path)}, "utf8"), diskBeforeFailure);
			rmSync(temporary, { recursive: true });
			await bridge.setTheme("violet");
			for (const choice of [null, {}, "DARK", "invalid"]) {
				await assert.rejects(bridge.setTheme(choice), /valid theme choice/);
			}
			assert.deepEqual(await bridge.readTagGroups(), data);
			assert.equal(await bridge.beginTagGroupClose(), null, "reload cannot create native intent");
			groupClose.nativeClose(window);
			const attempt = await bridge.beginTagGroupClose();
			assert.ok(attempt);
			await assert.rejects(bridge.completeTagGroupClose(attempt.attemptId, "unknown"), /Invalid/);
			assert.equal(await bridge.completeTagGroupClose("stale", "saved"), false);
			assert.equal(await bridge.completeTagGroupClose(attempt.attemptId, "failed"), true);
			assert.equal(closes, 0);
			for (const event of [{ ...owned, sender: {} }, { ...owned, senderFrame: { url: frame.url } }, { ...owned, senderFrame: null }]) {
				globalThis.event = event;
				await assert.rejects(bridge.readTagGroups(), /unowned renderer/);
				await assert.rejects(bridge.getTheme(), /unowned renderer/);
				await assert.rejects(bridge.setTheme("dark"), /unowned renderer/);
				await assert.rejects(bridge.beginTagGroupClose(), /unowned renderer/);
				await assert.rejects(bridge.completeTagGroupClose(attempt.attemptId, "saved"), /unowned renderer/);
				await assert.rejects(bridge.saveTagGroups(data), /unowned renderer/);
			}
			globalThis.event = owned;
			for (const url of ["https://example.test/", "not a URL", "about:blank"]) {
				frame.url = url;
				await assert.rejects(bridge.saveTagGroups(data), /unowned renderer/);
				await assert.rejects(bridge.getTheme(), /unowned renderer/);
				await assert.rejects(bridge.setTheme("dark"), /unowned renderer/);
			}
			frame.url = "http://127.0.0.1:51234/";
			destroyed = true;
			await assert.rejects(bridge.readTagGroups(), /unowned renderer/);
			destroyed = false;
			origin = undefined;
			await assert.rejects(bridge.saveTagGroups(data), /unowned renderer/);
			origin = "http://127.0.0.1:51234";
			await assert.rejects(bridge.saveTagGroups({ ...data, tags: [["s1", "purple"]] }), /Invalid/);
			// A new random server origin in the same application reads the same stable file.
			origin = "http://127.0.0.1:54321";
			frame.url = origin;
			assert.deepEqual(await bridge.readTagGroups(), data);
			console.log("confirmed before close");
			process.exit(0);
		`], { encoding: "utf8" });
		assert.match(output, /confirmed before close/);
		const disk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(disk.tagGroups.groups[0].name, "Confirmed");
		assert.equal(disk.lastWorkspace, directory);
		assert.equal(disk.window.width, 800);
		assert.equal(disk.theme, "violet");
	} finally {
		rmSync(directory, { recursive: true });
	}
});
