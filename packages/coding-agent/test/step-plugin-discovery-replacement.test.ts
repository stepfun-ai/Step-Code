import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ResourcesDiscoverEvent } from "../src/core/extensions/types.ts";
import { createStepPluginResourcesExtension } from "../src/step/plugins.ts";

/**
 * `resources_discover` runs while a session starts. Replacing that session
 * (fork, `/new`, reload) disposes its extension runner, whose context getters
 * then throw. The handler awaited discovery and then touched `ctx.sessionManager`
 * and `ctx.ui`: the read threw, and the throw from its own catch (which called
 * `ctx.ui.notify`) escaped as an extension error, so following a fork could pop
 * a toast about the session it had just left.
 *
 * The handler now reads what it needs before awaiting, so a replacement during
 * discovery neither rejects nor reports an error from the old session.
 */

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function captureHandler(): (event: ResourcesDiscoverEvent, ctx: ExtensionContext) => Promise<unknown> {
	let handler: ((event: ResourcesDiscoverEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
	const api = {
		on: (name: string, registered: unknown) => {
			if (name === "resources_discover")
				handler = registered as (event: ResourcesDiscoverEvent, ctx: ExtensionContext) => Promise<unknown>;
		},
	} as unknown as ExtensionAPI;
	createStepPluginResourcesExtension()(api);
	if (!handler) throw new Error("the plugin extension registered no resources_discover handler");
	return handler;
}

/** A context whose every getter throws once the runner says it is stale. */
function replaceableContext(cwd: string) {
	const state = { stale: false, notices: [] as Array<{ message: string; level?: string }> };
	const active = (): void => {
		if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	const sessionManager = {};
	const ctx = {
		get cwd() {
			active();
			return cwd;
		},
		isProjectTrusted() {
			active();
			return true;
		},
		get sessionManager() {
			active();
			return sessionManager;
		},
		get ui() {
			active();
			return {
				notify: (message: string, level?: string) => state.notices.push({ message, level }),
			};
		},
	} as unknown as ExtensionContext;
	return { ctx, state };
}

test("a replacement during plugin discovery does not reject with a stale context", async () => {
	const root = await mkdtemp(join(tmpdir(), "step-plugin-replacement-"));
	roots.push(root);
	const previous = process.env.STEPCODE_STORAGE_ROOT_DIR;
	// Read plugins from the fixture, never the developer's own storage root.
	process.env.STEPCODE_STORAGE_ROOT_DIR = root;
	const handler = captureHandler();
	const { ctx, state } = replaceableContext(root);
	try {
		const discovering = handler({ type: "resources_discover", cwd: root, reason: "startup" }, ctx);
		// The session is replaced while discovery is still awaiting.
		state.stale = true;
		await expect(discovering).resolves.toEqual({ skillPaths: [], promptPaths: [] });
		expect(state.notices).toEqual([]);
	} finally {
		if (previous === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
		else process.env.STEPCODE_STORAGE_ROOT_DIR = previous;
	}
});

test("a live session still hears why its plugin resources are missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "step-plugin-context-failure-"));
	roots.push(root);
	const previous = process.env.STEPCODE_STORAGE_ROOT_DIR;
	process.env.STEPCODE_STORAGE_ROOT_DIR = root;
	const handler = captureHandler();
	const notices: Array<{ message: string; level?: string }> = [];
	const ctx = {
		get cwd() {
			return root;
		},
		isProjectTrusted() {
			throw new Error("trust store unreadable");
		},
		get sessionManager() {
			return {};
		},
		get ui() {
			return { notify: (message: string, level?: string) => notices.push({ message, level }) };
		},
	} as unknown as ExtensionContext;
	try {
		await expect(handler({ type: "resources_discover", cwd: root, reason: "startup" }, ctx)).resolves.toEqual({});
		expect(notices).toEqual([
			{ message: "Could not read plugin resources: trust store unreadable", level: "warning" },
		]);
	} finally {
		if (previous === undefined) delete process.env.STEPCODE_STORAGE_ROOT_DIR;
		else process.env.STEPCODE_STORAGE_ROOT_DIR = previous;
	}
});
