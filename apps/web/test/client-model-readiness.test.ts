import assert from "node:assert/strict";
import test from "node:test";
import { after, before } from "node:test";
import { sendMessage } from "../client/src/features/composer/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousFetch = globalThis.fetch;
before(() => {
	Object.defineProperty(globalThis, "window", { configurable: true, value: { stepcodeDesktop: { platform: "darwin" } } });
	globalThis.fetch = async () => { throw new Error("A blocked prompt must not create a session or send an HTTP request"); };
});
after(() => {
	if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
	else Reflect.deleteProperty(globalThis, "window");
	globalThis.fetch = previousFetch;
});

test("Desktop send without a usable model keeps attachments and requests configuration before mutation", async () => {
	const state = createInitialState();
	setState({ ...state, attachments: [{ name: "fixture.txt", mimeType: "text/plain", data: "Zml4dHVyZQ==", kind: "text" }],
		draftModels: { models: [], availableThinkingLevels: [] } });
	const attachments = getState().attachments;
	assert.equal(await sendMessage("fixture unsent prompt"), false);
	assert.equal(getState().attachments, attachments);
	assert.equal(getState().pendingTurn, null);
	assert.equal(getState().current, null);
	assert.equal(getState().ui.settingsPage, "models");
	assert.match(getState().toast?.message ?? "", /保留|kept/u);
});

import { modelConfigurationRequired } from "../client/src/features/composer/model-readiness.ts";

test("a selected usable custom model does not require a Step account", () => {
	assert.equal(modelConfigurationRequired({ model: { provider: "custom", id: "fixture" },
		models: [{ provider: "custom", id: "fixture" }] }), false);
});
test("missing models and removed selections request configuration rather than silently sending", () => {
	assert.equal(modelConfigurationRequired({}), true);
	assert.equal(modelConfigurationRequired({ model: { provider: "custom", id: "removed" },
		models: [{ provider: "custom", id: "available" }] }), true);
	assert.equal(modelConfigurationRequired({ models: [{ provider: "custom", id: "available" }] }), true);
});
