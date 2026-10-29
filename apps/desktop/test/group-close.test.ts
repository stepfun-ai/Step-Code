import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { TagGroupCloseOwner } from "../src/tag-group-close.ts";

function fixture(context: TestContext) {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	let cancelled = 0;
	const owner = new TagGroupCloseOwner(() => { cancelled++; });
	let closes = 0;
	const target = { close: () => { closes++; } };
	return { owner, target, closes: () => closes, cancelled: () => cancelled };
}

test("native close tokens are one-time and document-bound; repeated close joins", (context) => {
	const { owner, target, closes } = fixture(context);
	owner.nativeClose(target);
	const attempt = owner.begin(target);
	assert.ok(attempt);
	owner.nativeClose(target);
	assert.deepEqual(owner.begin(target), attempt);
	assert.equal(owner.complete(target, attempt.attemptId, "saved"), true);
	context.mock.timers.tick(0);
	assert.equal(closes(), 1);
	assert.equal(owner.complete(target, attempt.attemptId, "saved"), false);
	owner.closed(target);
	owner.nativeClose(target);
	const stale = owner.begin(target)!;
	owner.documentChanged(target);
	assert.equal(owner.complete(target, stale.attemptId, "saved"), false);
	assert.equal(owner.begin(target), null, "reload must not inherit native intention");
});

test("failure and 10s expiry cancel intention, late ack cannot close, later manual retry works", (context) => {
	const { owner, target, closes, cancelled } = fixture(context);
	owner.nativeClose(target);
	const first = owner.begin(target)!;
	assert.equal(owner.complete(target, first.attemptId, "failed"), true);
	assert.equal(cancelled(), 1);
	owner.nativeClose(target);
	const expired = owner.begin(target)!;
	context.mock.timers.tick(10000);
	assert.equal(cancelled(), 2);
	assert.equal(owner.complete(target, expired.attemptId, "saved"), false);
	assert.equal(closes(), 0);
	owner.nativeClose(target);
	assert.equal(owner.complete(target, owner.begin(target)!.attemptId, "saved"), true);
	context.mock.timers.tick(0);
	assert.equal(closes(), 1);
});

test("committed fresh document and restart expiry cancel the old continuation", async (context) => {
	const { owner, target, cancelled } = fixture(context);
	let navigations = 0;
	const pending = owner.restart(target, async () => { navigations++; }, "loading");
	const attempt = owner.begin(target)!;
	owner.documentChanged(target, "http://127.0.0.1:51234/fresh");
	assert.equal(await pending, false);
	assert.equal(owner.complete(target, attempt.attemptId, "saved"), false);
	assert.equal(navigations, 1);
	const retry = owner.restart(target, async () => { navigations++; }, "loading");
	context.mock.timers.tick(10000);
	assert.equal(await retry, false);
	assert.equal(cancelled(), 2);
	assert.equal(navigations, 2, "expired attempt cannot restart a replacement document");
});

test("restart drains on the same document and cancels without running continuation on failure", async (context) => {
	const { owner, target } = fixture(context);
	let navigations = 0;
	const restart = owner.restart(target, async () => { navigations++; }, "loading");
	assert.equal(navigations, 1, "first navigation asks the actual beforeunload hook");
	assert.equal(owner.complete(target, owner.begin(target)!.attemptId, "failed"), true);
	assert.equal(await restart, false);
	assert.equal(navigations, 1);
	const retry = owner.restart(target, async () => { navigations++; owner.documentChanged(target, "loading"); }, "loading");
	assert.equal(await retry, true, "clean/error/loading pages need no renderer acknowledgement");
});
