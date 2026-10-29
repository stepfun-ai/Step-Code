import assert from "node:assert/strict";
import test from "node:test";
import { parseDirectoryPickOptions, recordDirectoryPick } from "../src/directory-pick-policy.ts";

test("ordinary folder selection retains the next-launch workspace behavior", () => {
	const recorded: string[] = [];
	const options = parseDirectoryPickOptions({ title: "Open folder" });
	assert.equal(options.purpose, "workspace");
	assert.equal(recordDirectoryPick(options, "/fixture/project", (path) => recorded.push(path)), "/fixture/project");
	assert.deepEqual(recorded, ["/fixture/project"]);
});

test("migration resource target does not change the next-launch workspace", () => {
	const recorded: string[] = [];
	const options = parseDirectoryPickOptions({ title: "Choose migration target", purpose: "resource" });
	assert.equal(recordDirectoryPick(options, "/fixture/other", (path) => recorded.push(path)), "/fixture/other");
	assert.deepEqual(recorded, []);
});

test("cancel never records a workspace", () => {
	for (const purpose of ["workspace", "resource"] as const)
		assert.equal(recordDirectoryPick({ purpose }, null, () => { throw new Error("Cancellation must not record"); }), null);
});

test("picker validates purpose and untrusted fields without echoing input", () => {
	for (const input of [42, [], { purpose: "invalid" }, { purpose: false }, { arbitrary: true },
		{ title: "bad\0title" }, { defaultPath: false }]) {
		assert.throws(() => parseDirectoryPickOptions(input), /Invalid directory picker/);
	}
	assert.deepEqual(parseDirectoryPickOptions(undefined), { purpose: "workspace" });
});
