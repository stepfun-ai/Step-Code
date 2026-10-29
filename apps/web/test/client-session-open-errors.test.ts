import assert from "node:assert/strict";
import test from "node:test";
import { openSession, openSessionWithOutcome } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

for (const reportErrors of [false, true]) {
	test(`session open ${reportErrors ? "reports errors by default" : "can quietly refuse an unavailable import"}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		setState({ ...createInitialState(), current: { id: "existing", cwd: "/project", status: "idle" } });
		t.after(() => setState(createInitialState()));
		t.mock.method(globalThis, "fetch", async () => Response.json({ error: "technical open diagnostic" }, { status: 500 }));
		if (reportErrors) await openSession("unavailable");
		else await openSession("unavailable", { reportErrors: false });
		assert.equal(getState().current?.id, "existing");
		assert.equal(getState().ui.openingSession, null);
		assert.equal(getState().toast?.message, reportErrors ? "technical open diagnostic" : undefined);
	});
}

test("reopening the current ID fails explicitly rather than reporting its old snapshot as new success", async (t) => {
	setState({ ...createInitialState(), current: { id: "same", cwd: "/fixture", status: "idle" } });
	t.after(() => setState(createInitialState()));
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 500 }));
	assert.equal(await openSessionWithOutcome("same", { reportErrors: false }), "failed");
	assert.equal(getState().current?.id, "same");
});

test("a superseded opening cannot claim success or clear the newer opening, even for the same ID", async (t) => {
	setState({ ...createInitialState(), current: { id: "same", cwd: "/fixture", status: "idle" } });
	t.after(() => setState(createInitialState()));
	const responses: ((response: Response) => void)[] = [];
	t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => responses.push(resolve)));
	const first = openSessionWithOutcome("same", { reportErrors: false });
	const second = openSessionWithOutcome("same", { reportErrors: false });
	responses[0]!(Response.json({ id: "same", entries: [], status: "idle" }));
	assert.equal(await first, "superseded");
	assert.equal(getState().ui.openingSession, "same");
	responses[1]!(Response.json({ error: "unavailable" }, { status: 500 }));
	assert.equal(await second, "failed");
	assert.equal(getState().ui.openingSession, null);
});

test("quiet migration session opening still reports expired authentication globally", async (t) => {
	setState(createInitialState());
	t.after(() => setState(createInitialState()));
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
	await openSession("unavailable", { reportErrors: false });
	assert.equal(getState().ui.authExpired, true);
	assert.equal(getState().toast, null);
	assert.equal(getState().ui.openingSession, null);
});
