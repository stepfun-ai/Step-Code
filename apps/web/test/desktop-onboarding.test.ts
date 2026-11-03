import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DesktopOnboardingError, DesktopOnboardingStore, type DesktopOnboardingPatch } from "../src/desktop-onboarding.ts";

/** Windows reports no POSIX permission bits; updates themselves must still succeed there. */
const windows = process.platform === "win32";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "desktop-onboarding-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	return { root, agentDir, path: join(agentDir, "desktop-onboarding.json"), store: new DesktopOnboardingStore({ agentDir }) };
}
function error(code: string) {
	return (value: unknown) => value instanceof DesktopOnboardingError && value.code === code;
}

test("missing get is read-only and does not create directory, file or lock", (t) => {
	const { store, agentDir, root } = fixture(t);
	assert.deepEqual(store.get(), { schemaVersion: 1, flowVersion: 1, revision: 0, status: "unseen", updatedAt: new Date(0).toISOString() });
	assert.equal(existsSync(agentDir), false);
	assert.deepEqual(readdirSync(root), []);
	mkdirSync(agentDir);
	assert.equal(store.get().status, "unseen");
	assert.deepEqual(readdirSync(agentDir), []);
});

test("CAS persists across restart, keeps last job through in_progress and leaves unrelated credentials unchanged", (t) => {
	const { store, agentDir, path } = fixture(t);
	mkdirSync(agentDir);
	const unrelated = ["auth.json", "models.json", "step-login.json", "config.toml"];
	for (const file of unrelated) writeFileSync(join(agentDir, file), "fixture unchanged\n");
	const offered = store.update({ expectedRevision: 0, status: "offered" });
	assert.equal(offered.revision, 1);
	const restarted = new DesktopOnboardingStore({ agentDir });
	assert.deepEqual(restarted.get(), offered);
	assert.throws(() => restarted.update({ expectedRevision: 0, status: "in_progress" }), error("onboarding-revision-conflict"));
	const running = store.update({ expectedRevision: 1, status: "in_progress", lastJobId: "12345678-1234-4123-8123-123456789abc" });
	const again = restarted.update({ expectedRevision: 2, status: "in_progress" });
	assert.equal(again.lastJobId, running.lastJobId);
	assert.equal(again.revision, 3);
	if (!windows) assert.equal(lstatSync(path).mode & 0o777, 0o600);
	for (const file of unrelated) assert.equal(readFileSync(join(agentDir, file), "utf8"), "fixture unchanged\n");
	assert.deepEqual(readdirSync(agentDir).sort(), [...unrelated, "desktop-onboarding.json"].sort());
});

test("new store creates private directory; completion and skip stay sticky for this flow", (t) => {
	const { store, agentDir, root } = fixture(t);
	store.update({ expectedRevision: 0, status: "completed" });
	if (!windows) assert.equal(lstatSync(agentDir).mode & 0o777, 0o700);
	const restarted = new DesktopOnboardingStore({ agentDir });
	assert.throws(() => restarted.update({ expectedRevision: 1, status: "offered" }), error("onboarding-flow-finished"));
	assert.equal(restarted.get().status, "completed");
	const otherDir = join(root, "skipped");
	const skipped = new DesktopOnboardingStore({ agentDir: otherDir });
	skipped.update({ expectedRevision: 0, status: "skipped" });
	assert.throws(() => skipped.update({ expectedRevision: 1, status: "unseen" }), error("onboarding-flow-finished"));
});

test("validates unknown patch input before creating any state", (t) => {
	const { store, agentDir } = fixture(t);
	const invalid: unknown[] = [null, [], {}, { expectedRevision: -1, status: "offered" }, { expectedRevision: 0.5, status: "offered" },
		{ expectedRevision: 0, status: "running" }, { expectedRevision: 0, status: "offered", extra: true },
		{ expectedRevision: 0, status: "offered", lastJobId: "../job" }, { expectedRevision: 0, status: "offered", lastJobId: null },
		{ expectedRevision: 0, status: "offered", lastJobId: "x".repeat(129) }];
	for (const value of invalid) {
		// Deliberately emulate the untyped PATCH boundary; product callers use the public type.
		assert.throws(() => store.update(value as DesktopOnboardingPatch), (e: unknown) => e instanceof DesktopOnboardingError && e.status === 400);
	}
	assert.equal(existsSync(agentDir), false);
});

test("malformed or unsupported durable state fails safely instead of silently returning unseen", (t) => {
	const { store, agentDir, path } = fixture(t);
	mkdirSync(agentDir);
	const valid = { schemaVersion: 1, flowVersion: 1, revision: 1, status: "offered", updatedAt: new Date(0).toISOString() };
	for (const contents of ["{", "null", "[]", "x".repeat(4097), JSON.stringify({ ...valid, schemaVersion: 2 }),
		JSON.stringify({ ...valid, flowVersion: 2 }), JSON.stringify({ ...valid, revision: -1 }),
		JSON.stringify({ ...valid, updatedAt: "bad date" }), JSON.stringify({ ...valid, status: "unknown" }),
		JSON.stringify({ ...valid, lastJobId: "../escape" }), JSON.stringify({ ...valid, unexpected: "field" })]) {
		writeFileSync(path, contents);
		assert.throws(() => store.get(), error("invalid-onboarding-file"));
		assert.throws(() => store.update({ expectedRevision: 1, status: "completed" }), error("invalid-onboarding-file"));
		assert.equal(readFileSync(path, "utf8"), contents);
		assert.equal(existsSync(`${path}.lock`), false);
	}
});

test("rejects file and agent-directory links without touching their targets", (t) => {
	const { store, agentDir, root, path } = fixture(t);
	mkdirSync(agentDir);
	const outside = join(root, "outside");
	writeFileSync(outside, "outside fixture");
	symlinkSync(outside, path);
	assert.throws(() => store.get(), error("unsafe-onboarding-path"));
	assert.throws(() => store.update({ expectedRevision: 0, status: "offered" }), error("unsafe-onboarding-path"));
	assert.equal(readFileSync(outside, "utf8"), "outside fixture");
	const alias = join(root, "alias");
	symlinkSync(agentDir, alias);
	const linked = new DesktopOnboardingStore({ agentDir: alias });
	assert.throws(() => linked.get(), error("unsafe-onboarding-path"));
	assert.throws(() => linked.update({ expectedRevision: 0, status: "offered" }), error("unsafe-onboarding-path"));
	mkdirSync(join(agentDir, "nested"));
	assert.throws(() => new DesktopOnboardingStore({ agentDir: join(alias, "nested", "new-agent") }), error("unsafe-onboarding-path"));
});

test("exclusive lock reports contention and does not steal an existing lock", (t) => {
	const { store, agentDir, path } = fixture(t);
	mkdirSync(agentDir);
	writeFileSync(`${path}.lock`, "another writer");
	assert.throws(() => store.update({ expectedRevision: 0, status: "offered" }), error("onboarding-locked"));
	assert.equal(readFileSync(`${path}.lock`, "utf8"), "another writer");
	assert.equal(store.get().status, "unseen");
	assert.equal(existsSync(path), false);
});

test("nested missing agent directory stays read-only until update and rejects directory substitution", (t) => {
	const { root } = fixture(t);
	const agentDir = join(root, "new", "agent");
	const store = new DesktopOnboardingStore({ agentDir });
	assert.equal(store.get().status, "unseen");
	assert.equal(existsSync(join(root, "new")), false);
	store.update({ expectedRevision: 0, status: "offered" });
	if (!windows) assert.equal(lstatSync(join(root, "new")).mode & 0o777, 0o700);
	renameSync(agentDir, join(root, "original"));
	mkdirSync(agentDir);
	assert.throws(() => store.get(), error("unsafe-onboarding-path"));
	assert.throws(() => store.update({ expectedRevision: 0, status: "offered" }), error("unsafe-onboarding-path"));
	assert.deepEqual(readdirSync(agentDir), []);
});

test("rejects hard-linked state, linked locks and path traversal input", (t) => {
	const { root, agentDir, path, store } = fixture(t);
	assert.throws(() => new DesktopOnboardingStore({ agentDir: `${join(root, "agent")}/../outside` }), error("invalid-onboarding-path"));
	store.update({ expectedRevision: 0, status: "offered" });
	linkSync(path, join(root, "shared-state"));
	assert.throws(() => store.get(), error("unsafe-onboarding-path"));
	symlinkSync(join(root, "shared-state"), `${path}.lock`);
	assert.throws(() => store.update({ expectedRevision: 1, status: "completed" }), error("onboarding-locked"));
	assert.equal(lstatSync(`${path}.lock`).isSymbolicLink(), true);
	assert.equal(JSON.parse(readFileSync(join(root, "shared-state"), "utf8")).status, "offered");
	assert.equal(lstatSync(agentDir).isDirectory(), true);
});
