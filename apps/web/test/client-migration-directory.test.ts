import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chooseResourceDirectory, closeWorkspaceBrowser, confirmWorkspaceBrowser } from "../client/src/features/workspace/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
const fetchBefore = globalThis.fetch;
after(() => {
	for (const [key, descriptor] of [["window", windowBefore], ["document", documentBefore]] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globalThis.fetch = fetchBefore;
});

test("native migration pick has resource purpose and does not register or switch a draft", async () => {
	setState({ ...createInitialState(), draftCwd: "/fixture/current" });
	const requests: unknown[] = [];
	Object.defineProperty(globalThis, "window", { configurable: true, value: { stepcodeDesktop: {
		platform: "darwin", pickDirectory: async (input: unknown) => { requests.push(input); return "/fixture/target"; },
	} } });
	globalThis.fetch = async () => { throw new Error("Native target selection should not call workspace APIs"); };
	assert.equal(await chooseResourceDirectory(), "/fixture/target");
	assert.equal((requests[0] as { purpose: string }).purpose, "resource");
	assert.equal(getState().draftCwd, "/fixture/current");
	assert.deepEqual(getState().workspaces, []);
	assert.equal(getState().pickingFolder, false);
});

test("browser fallback resolves the selected directory without adding a workspace", async () => {
	Reflect.deleteProperty(globalThis, "window");
	Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: () => null } });
	setState({ ...createInitialState(), draftCwd: "/fixture/current", directoryPicker: "browse" });
	const urls: string[] = [];
	globalThis.fetch = async (input) => {
		urls.push(String(input));
		return Response.json({ path: "/fixture/current", parent: "/fixture", directories: [] });
	};
	const pending = chooseResourceDirectory();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getState().ui.workspaceBrowserPurpose, "resource");
	await confirmWorkspaceBrowser("/fixture/target");
	assert.equal(await pending, "/fixture/target");
	assert.ok(urls.every((url) => url.startsWith("/api/v1/directories")));
	assert.equal(getState().draftCwd, "/fixture/current");
	assert.deepEqual(getState().workspaces, []);
	assert.equal(getState().ui.workspaceBrowserOpen, false);
});

test("cancel settles a browser resource pick and releases the shared picker", async () => {
	setState({ ...createInitialState(), directoryPicker: "browse" });
	const pending = chooseResourceDirectory();
	await new Promise((resolve) => setImmediate(resolve));
	closeWorkspaceBrowser();
	assert.equal(await pending, null);
	assert.equal(getState().pickingFolder, false);
	assert.equal(getState().ui.workspaceBrowserPurpose, "workspace");
});
