import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cancelBrowserSignIn, signInWithApiKey, signInWithBrowser } from "../client/src/features/login/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	setState(createInitialState());
});
const report = {
	source: "auth.json",
	configured: true,
	validity: "valid",
	profile: "platform_cn",
	session: { state: "missing" },
	loginCommand: "step login",
	planUrl: "https://platform.stepfun.com/step-plan",
};

test("API key sign-in updates the account projection, but an aborted page never publishes a late response", async () => {
	setState(createInitialState());
	let finish!: () => void;
	globalThis.fetch = async () => {
		await new Promise<void>((resolve) => { finish = resolve; });
		return Response.json({ login: report });
	};
	const controller = new AbortController();
	const pending = signInWithApiKey("platform_cn", "fixture-only", controller.signal);
	controller.abort();
	finish();
	assert.equal((await pending).kind, "ok");
	assert.equal(getState().login, null);
	globalThis.fetch = async () => Response.json({ login: report });
	assert.equal((await signInWithApiKey("platform_cn", "fixture-only")).kind, "ok");
	assert.deepEqual(getState().login, report);
});

test("API key rejection and provider outage retain distinct feedback without replacing the account", async () => {
	for (const code of ["invalid_key", "unavailable"]) {
		globalThis.fetch = async () => Response.json({ code, error: "fixture" }, { status: 400 });
		assert.equal((await signInWithApiKey("platform_cn", "fixture-only")).kind, code === "invalid_key" ? "invalid" : "unavailable");
		assert.equal(getState().login, null);
	}
});

test("a failed browser start is reported without waiting for a poll", async () => {
	globalThis.fetch = async () => Response.json({ state: "failed", error: "fixture start failure" });
	await assert.rejects(signInWithBrowser("step_plan", () => {}), /fixture start failure/);
});

test("cancel waits for an in-flight start and a replacement start waits for cleanup", async () => {
	const calls: string[] = [];
	let finishStart!: () => void;
	let finishDelete!: () => void;
	globalThis.fetch = async (_url, init) => {
		const method = init?.method ?? "GET";
		calls.push(method);
		if (calls.length === 1) await new Promise<void>((resolve) => { finishStart = resolve; });
		if (method === "DELETE") await new Promise<void>((resolve) => { finishDelete = resolve; });
		return Response.json({ state: method === "POST" ? "failed" : "idle", error: "replacement fixture" });
	};
	const first = signInWithBrowser("step_plan", () => assert.fail("cancelled start must not open a URL"));
	await new Promise((resolve) => setImmediate(resolve));
	cancelBrowserSignIn();
	const next = signInWithBrowser("step_plan_oversea", () => {});
	const rejected = assert.rejects(next, /replacement fixture/);
	assert.deepEqual(calls, ["POST"]);
	finishStart();
	assert.deepEqual(await first, { outcome: "cancelled" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["POST", "DELETE"]);
	finishDelete();
	await rejected;
	assert.deepEqual(calls, ["POST", "DELETE", "POST"]);
});

test("Log out calls the Step sign-out route and reloads without the credential", async () => {
	setState(createInitialState());
	setState({ login: { ...report, session: { state: "ready" } } });
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		requests.push(String(input));
		return Response.json({
			removed: true,
			accountSessionRemoved: true,
			remainingSource: null,
			login: { ...report, source: "none", configured: false, validity: undefined, session: { state: "missing" } },
		});
	};
	let reloaded = 0;
	const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: {
			reload: () => {
				reloaded += 1;
			},
		},
	});
	try {
		const { confirmLogout } = await import("../client/src/features/shell/actions.ts");
		await confirmLogout();
		assert.deepEqual(requests, ["/api/v1/logout"]);
		assert.equal(getState().login?.configured, false);
		assert.equal(getState().account, null);
		assert.equal(reloaded, 1);
	} finally {
		if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
		else Reflect.deleteProperty(globalThis, "location");
	}
});

test("Log out is offered only when a local credential or account session exists", async () => {
	const { canLogout } = await import("../client/src/features/shell/actions.ts");
	assert.equal(canLogout(null), false);
	assert.equal(
		canLogout({ ...report, source: "environment", configured: true, session: { state: "missing" } }),
		false,
	);
	assert.equal(canLogout({ ...report, source: "auth.json", configured: true }), true);
	assert.equal(
		canLogout({ ...report, source: "environment", configured: false, session: { state: "expired" } }),
		true,
	);
});

/** Run `confirmLogout` against a scripted sign-out report; returns what it left in sessionStorage. */
async function signOutWith(customModels: boolean): Promise<Map<string, string>> {
	setState(createInitialState());
	setState({ login: { ...report, session: { state: "ready" } } });
	globalThis.fetch = async () =>
		Response.json({
			removed: true,
			accountSessionRemoved: true,
			remainingSource: null,
			customModels,
			login: { ...report, source: "none", configured: false, validity: undefined, session: { state: "missing" } },
		});
	const stored = new Map<string, string>();
	const globals = globalThis as unknown as Record<string, unknown>;
	const originalStorage = globals.sessionStorage;
	globals.sessionStorage = {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key),
	};
	try {
		const { confirmLogout } = await import("../client/src/features/shell/actions.ts");
		await confirmLogout();
	} finally {
		if (originalStorage === undefined) Reflect.deleteProperty(globals, "sessionStorage");
		else globals.sessionStorage = originalStorage;
	}
	return stored;
}

test("Log out asks for a sign-in only when no custom model is left", async () => {
	const withoutModels = await signOutWith(false);
	assert.equal(withoutModels.get("stepcode:signInRequired"), "1");
	assert.equal(withoutModels.has("stepcode:logoutNotice"), false);

	const withModels = await signOutWith(true);
	assert.equal(withModels.has("stepcode:signInRequired"), false, "custom models keep the app open");
	assert.match(withModels.get("stepcode:logoutNotice") ?? "", /自定义模型|custom models/u);
});

test("the sign-in gate waits only when no model can run", async () => {
	const { signInGateNeeded } = await import("../client/src/state/session.ts");
	const signedOut = { ...report, source: "none", configured: false, session: { state: "missing" as const } };
	const gate = (input: Partial<Parameters<typeof signInGateNeeded>[0]>) =>
		signInGateNeeded({ desktop: true, signedOut: false, login: signedOut, customModels: false, ...input });
	assert.equal(gate({}), true, "Desktop with nothing to run asks");
	assert.equal(gate({ customModels: true }), false, "custom models need no Step account");
	assert.equal(gate({ login: report }), false, "a Step credential needs no gate");
	assert.equal(gate({ login: null }), false, "no report, no gate");
	assert.equal(gate({ desktop: false }), false, "plain Web keeps its terminal path on a first visit");
	assert.equal(gate({ desktop: false, signedOut: true }), true, "plain Web asks after an explicit sign-out");
	assert.equal(gate({ desktop: false, signedOut: true, customModels: true }), false);
});

test("Use your own models closes the gate and opens the models settings", async () => {
	const { continueWithOwnModels } = await import("../client/src/features/login/actions.ts");
	setState(createInitialState());
	const { setUi } = await import("../client/src/state/store.ts");
	setUi({ loginRequired: true });
	continueWithOwnModels();
	assert.equal(getState().ui.loginRequired, false);
	assert.equal(getState().ui.settingsPage, "models");
});
