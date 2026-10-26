import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEditToolDefinition, createWriteToolDefinition, type SessionEntry } from "@step-harness/coding-agent";
import {
	applyPatch,
	fileAtTurnEnd,
	revertedTurnIds,
	reversePatch,
	revertTurnChanges,
	TURN_REVERT_TYPE,
	TurnRevertError,
	TurnReverter,
	turnChanges,
	turnRevertNotice,
} from "../src/turn-changes.ts";

/** Patches exactly as the coding agent's `generateUnifiedPatch` (jsdiff) prints them. */
const PATCHES = {
	edit: "--- f.txt\n+++ f.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n",
	create: "--- f.txt\n+++ f.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
	appendNoEol: "--- f.txt\n+++ f.txt\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n",
	addEol: "--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
	dropEol: "--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n",
	two: "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
	fresh: "--- b.txt\n+++ b.txt\n@@ -0,0 +1,1 @@\n+fresh\n",
};

function entry(id: string, message: Record<string, unknown>): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message } as SessionEntry;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "stepcode-web-turn-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** One turn of `write` calls run through the real write tool, as session entries. */
async function writeTurn(root: string, writes: ReadonlyArray<{ path: string; content: string }>) {
	const tool = createWriteToolDefinition(root);
	const calls = writes.map((input, index) => ({ id: `w${index}`, input }));
	const entries: SessionEntry[] = [
		entry("u1", { role: "user", content: "go" }),
		entry("a1", {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.id, name: "write", arguments: call.input })),
		}),
	];
	for (const call of calls) {
		const result = await tool.execute(call.id, call.input, undefined, undefined, undefined as never);
		entries.push(entry(`r-${call.id}`, { role: "toolResult", toolCallId: call.id, details: result.details }));
	}
	return entries;
}

test("reversePatch undoes edits, including a trailing-newline change", () => {
	const cases: Array<[string, string, string]> = [
		["a\nb\nc\n", "a\nB\nc\nd\n", PATCHES.edit],
		["", "one\ntwo\n", PATCHES.create],
		["a\nb", "a\nb\nc", PATCHES.appendNoEol],
		["a\nb", "a\nb\n", PATCHES.addEol],
		["a\nb\n", "a\nb", PATCHES.dropEol],
	];
	for (const [before, after, patch] of cases) assert.equal(reversePatch(after, patch), before);
});

test("reversePatch finds a hunk that later edits moved, and keeps those edits", () => {
	// PATCHES.edit turned a/b/c into a/B/c/d; a later turn then prepended two lines and appended one.
	assert.equal(reversePatch("x\ny\na\nB\nc\nd\nz\n", PATCHES.edit), "x\ny\na\nb\nc\nz\n");
});

test("reversePatch tolerates edited context but not edited changes", () => {
	// PATCHES.edit's context line `a` was rewritten later; its own lines B and d are intact.
	assert.equal(reversePatch("A\nB\nc\nd\n", PATCHES.edit), "A\nb\nc\n");
	// The appended `mul` is undone although the `sub` body above it (its context) changed.
	const appendMul =
		"--- m.js\n+++ m.js\n@@ -3,3 +3,7 @@\n export function sub(a, b) {\n \treturn a - b;\n }\n+\n+export function mul(a, b) {\n+\treturn a * b;\n+}\n";
	assert.equal(
		reversePatch(
			"x\ny\nexport function sub(a, b) {\n\treturn a - b - 0;\n}\n\nexport function mul(a, b) {\n\treturn a * b;\n}\n",
			appendMul,
		),
		"x\ny\nexport function sub(a, b) {\n\treturn a - b - 0;\n}\n",
	);
});

test("reversePatch refuses content that changed since the patch", () => {
	assert.throws(() => reversePatch("a\nX\nc\nd\n", PATCHES.edit));
});

test("revertTurnChanges restores the turn's files and deletes created ones", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "one\r\nTWO\r\nthree\r\n");
		await writeFile(join(root, "b.txt"), "fresh\n");
		const entries = [
			entry("u1", { role: "user", content: "first" }),
			entry("u2", { role: "user", content: "second" }),
			entry("a1", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "c2", name: "write", arguments: { path: "b.txt", content: "fresh\n" } },
					{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "missing.txt" } },
				],
			}),
			entry("r1", { role: "toolResult", toolCallId: "c1", details: { patch: PATCHES.two } }),
			entry("r2", { role: "toolResult", toolCallId: "c2", details: { patch: PATCHES.fresh, created: true } }),
			entry("r3", { role: "toolResult", toolCallId: "c3", isError: true, details: { patch: "x" } }),
			entry("u3", { role: "user", content: "third" }),
		];
		assert.deepEqual(turnChanges(entries, "u1"), { changes: [], skipped: [] });
		const { changes } = turnChanges(entries, "u2");
		assert.deepEqual(
			changes.map((change) => [change.path, change.created]),
			[
				["a.txt", false],
				["b.txt", true],
			],
		);
		await revertTurnChanges(changes, root);
		// An edit keeps the file's line endings, so the revert keeps them too.
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\r\ntwo\r\nthree\r\n");
		await assert.rejects(stat(join(root, "b.txt")));
		// Applying again finds the content already restored, so nothing is written.
		await writeFile(join(root, "b.txt"), "fresh\n");
		await assert.rejects(
			revertTurnChanges(changes, root),
			(error) => error instanceof TurnRevertError && error.code === "modified" && error.path === "a.txt",
		);
		assert.equal(await readFile(join(root, "b.txt"), "utf8"), "fresh\n");
	});
});

test("turnChanges lists writes without a patch as skipped", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "big.txt"), "x".repeat(2_000_000));
		await writeFile(join(root, "b.txt"), "b\n");
		const entries = await writeTurn(root, [
			{ path: "big.txt", content: "small\n" },
			{ path: "b.txt", content: "B\n" },
		]);
		// A write from before the tool recorded patches.
		entries.push(
			entry("a2", { role: "assistant", content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "o.txt" } }] }),
			entry("r2", { role: "toolResult", toolCallId: "old" }),
		);
		const { changes, skipped } = turnChanges(entries, "u1");
		assert.deepEqual(
			changes.map((change) => change.path),
			["b.txt"],
		);
		assert.deepEqual(skipped, [
			{ path: "big.txt", reason: "too_large" },
			{ path: "o.txt", reason: "unknown" },
		]);
	});
});

test("reverting a write restores the overwritten file's line endings and BOM", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "lf.txt"), "a\nb\n");
		await writeFile(join(root, "crlf.txt"), "﻿a\r\nb\r\n");
		const entries = await writeTurn(root, [
			{ path: "lf.txt", content: "a\r\nb\r\nc\r\n" },
			{ path: "crlf.txt", content: "a\nb\nc\n" },
		]);
		await revertTurnChanges(turnChanges(entries, "u1").changes, root);
		assert.equal(await readFile(join(root, "lf.txt"), "utf8"), "a\nb\n");
		assert.equal(await readFile(join(root, "crlf.txt"), "utf8"), "﻿a\r\nb\r\n");
	});
});

test("reverting a write resolves the path like the write tool, including unicode spaces", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a b.txt"), "old\n");
		const entries = await writeTurn(root, [{ path: "a b.txt", content: "new\n" }]);
		await revertTurnChanges(turnChanges(entries, "u1").changes, root);
		assert.equal(await readFile(join(root, "a b.txt"), "utf8"), "old\n");
	});
});

/** One session's entries, built call by call; `write` runs through the real tool. */
interface Session {
	readonly root: string;
	readonly entries: SessionEntry[];
	/** Turns whose revert entry was appended, in order. */
	readonly recorded: string[];
}

function session(root: string): Session {
	return { root, entries: [], recorded: [] };
}

function ask(session: Session, id: string): void {
	session.entries.push(entry(id, { role: "user", content: id }));
}

async function write(session: Session, id: string, path: string, content: string): Promise<void> {
	const input = { path, content };
	session.entries.push(
		entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: input }] }),
	);
	const result = await createWriteToolDefinition(session.root).execute(id, input, undefined, undefined, undefined as never);
	session.entries.push(entry(`r-${id}`, { role: "toolResult", toolCallId: id, details: result.details }));
}

async function edit(session: Session, id: string, path: string, oldText: string, newText: string): Promise<void> {
	const input = { path, edits: [{ oldText, newText }] };
	session.entries.push(
		entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: input }] }),
	);
	const result = await createEditToolDefinition(session.root).execute(id, input, undefined, undefined, undefined as never);
	session.entries.push(entry(`r-${id}`, { role: "toolResult", toolCallId: id, details: result.details }));
}

/** A `bash` call: its effect on disk is real, but the session records no patch for it. */
async function command(session: Session, id: string, effect: () => Promise<void>): Promise<void> {
	session.entries.push(
		entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: id } }] }),
	);
	await effect();
	session.entries.push(entry(`r-${id}`, { role: "toolResult", toolCallId: id, content: [] }));
}

/** Undo `turnId` as the runtime does: the revert entry is appended only once the files are written. */
async function undo(session: Session, turnId: string): Promise<string> {
	try {
		await new TurnReverter().revert(turnId, session.entries, session.root, async (turn) => {
			session.recorded.push(turn);
			session.entries.push(revertEntry(turn));
		});
		return "ok";
	} catch (error) {
		if (error instanceof TurnRevertError) return error.code;
		throw error;
	}
}

async function content(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

test("a file changed after its turn is kept, and the undo says it cannot be restored", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "s.py", "draft\n");
		// No command and no later turn: an editor or another session changes the file afterwards.
		await writeFile(join(root, "s.py"), "outside work\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "s.py")), "outside work\n");
		assert.deepEqual(s.recorded, []);
	});
});

test("a file the turn's own commands rewrote is kept, not blamed on a later turn", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "patch_docx.py", "print(1)\n");
		for (let index = 1; index <= 7; index += 1) {
			await command(s, `b${index}`, () => appendFile(join(root, "patch_docx.py"), `# revision ${index}\n`));
		}
		const before = await content(join(root, "patch_docx.py"));
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "patch_docx.py")), before);
		assert.deepEqual(s.recorded, []);
	});
});

test("a file that existed before the turn is not deleted when the turn recreated it", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "before the turn\n");
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "first\n");
		await command(s, "rm", () => unlink(join(root, "a.txt")));
		await write(s, "w2", "a.txt", "recreated\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "recreated\n");
	});
});

test("a write without a patch to the same path keeps a recreated file", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "before the turn\n");
		const s = session(root);
		ask(s, "u1");
		// Over 1 MB: the write tool records no patch, so what it replaced is unknown.
		await write(s, "w1", "a.txt", "x".repeat(1_100_000));
		await command(s, "rm", () => unlink(join(root, "a.txt")));
		await write(s, "w2", "a.txt", "recreated\n");
		assert.deepEqual(turnChanges(s.entries, "u1").skipped, [{ path: "a.txt", reason: "too_large" }]);
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "recreated\n");
	});
});

test("later turns are suggested first only when undoing them lets this turn undo", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "one\n");
		ask(s, "u2");
		// The same file, named by its absolute path.
		await write(s, "w2", join(root, "a.txt"), "two\n");
		assert.equal(await undo(s, "u1"), "conflict");
		assert.equal(await content(join(root, "a.txt")), "two\n");
		assert.equal(await undo(s, "u2"), "ok");
		assert.equal(await content(join(root, "a.txt")), "one\n");
		assert.equal(await undo(s, "u1"), "ok");
		assert.equal(await content(join(root, "a.txt")), undefined);
		assert.deepEqual(s.recorded, ["u2", "u1"]);
	});
});

test("a later turn that was already undone is not suggested again", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "one\n");
		ask(s, "u2");
		await write(s, "w2", "a.txt", "two\n");
		assert.equal(await undo(s, "u2"), "ok");
		assert.equal(await content(join(root, "a.txt")), "one\n");
		// Something outside puts back exactly what u2 wrote. Undoing u2 again would explain it, but u2 is undone.
		await writeFile(join(root, "a.txt"), "two\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "two\n");
		assert.deepEqual(s.recorded, ["u2"]);
	});
});

test("a turn whose own command rewrote the file stays refused after the later turn is undone", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "initial\n");
		await command(s, "b1", () => writeFile(join(root, "a.txt"), "after the command\n"));
		ask(s, "u2");
		await write(s, "w2", "a.txt", "second turn\n");
		// Undoing u2 first would only bring back what the command wrote, so u2 is not suggested.
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await undo(s, "u2"), "ok");
		assert.equal(await content(join(root, "a.txt")), "after the command\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "after the command\n");
		assert.deepEqual(s.recorded, ["u2"]);
	});
});

test("later turns that recorded no change to the file are not suggested", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "one\n");
		await writeFile(join(root, "a.txt"), "two\n");
		ask(s, "u2");
		ask(s, "u3");
		await write(s, "w3", "b.txt", "another file\n");
		ask(s, "u4");
		// A failed write whose patch would explain the file, and a write without a patch, both to a.txt.
		s.entries.push(
			entry("a-w4", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "w4", name: "write", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "w5", name: "write", arguments: { path: "a.txt" } },
				],
			}),
			entry("r-w4", {
				role: "toolResult",
				toolCallId: "w4",
				isError: true,
				details: { patch: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n" },
			}),
			entry("r-w5", { role: "toolResult", toolCallId: "w5" }),
		);
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "two\n");
	});
});

test("a later turn whose undo would not restore the file is not suggested", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "one\n");
		ask(s, "u2");
		await write(s, "w2", "a.txt", "two\n");
		await writeFile(join(root, "a.txt"), "three\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "three\n");
	});
});

test("a later turn is suggested only if its whole undo would succeed", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "one\n");
		ask(s, "u2");
		await write(s, "w2", "a.txt", "two\n");
		await write(s, "w3", "b.txt", "b\n");
		// Undoing u2 would restore a.txt, but u2's undo as a whole is refused on b.txt.
		await writeFile(join(root, "b.txt"), "b changed outside\n");
		assert.equal(await undo(s, "u2"), "modified");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "two\n");
		assert.equal(await content(join(root, "b.txt")), "b changed outside\n");
	});
});

test("later turns are suggested when undoing them in order, newest first, lets this turn undo", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "a.txt", "a1\n");
		ask(s, "u2");
		await write(s, "w2", "a.txt", "a2\n");
		await write(s, "w3", "b.txt", "b2\n");
		// u3 never touches a.txt, but u2 cannot be undone until u3 is.
		ask(s, "u3");
		await write(s, "w4", "b.txt", "b3\n");
		assert.equal(await undo(s, "u1"), "conflict");
		assert.equal(await undo(s, "u3"), "ok");
		assert.equal(await undo(s, "u2"), "ok");
		assert.equal(await undo(s, "u1"), "ok");
		assert.equal(await content(join(root, "a.txt")), undefined);
		assert.equal(await content(join(root, "b.txt")), undefined);
	});
});

test("one file that no longer matches leaves every file of the turn as it is", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "a before\n");
		const s = session(root);
		ask(s, "u1");
		// The mismatching file comes first, so the matching one is planned before the refusal.
		await write(s, "w1", "b.txt", "b\n");
		await write(s, "w2", "a.txt", "a after\n");
		await writeFile(join(root, "b.txt"), "b changed\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "a after\n");
		assert.equal(await content(join(root, "b.txt")), "b changed\n");
		assert.deepEqual(s.recorded, []);
	});
});

test("two paths to the same file are reverted as one file", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
		await symlink(join(root, "a.txt"), join(root, "link.txt"));
		const s = session(root);
		ask(s, "u1");
		await edit(s, "e1", "a.txt", "l1\n", "L1\n");
		await edit(s, "e2", "link.txt", "l10\n", "L10\n");
		assert.equal(await undo(s, "u1"), "ok");
		assert.equal(await content(join(root, "a.txt")), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
	});
});

test("an unpatched change to another path of the same file keeps a recreated file", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "before the turn\n");
		const s = session(root);
		ask(s, "u1");
		await symlink(join(root, "a.txt"), join(root, "link.txt"));
		await write(s, "w1", "link.txt", "x".repeat(1_100_000));
		await command(s, "rm", () => unlink(join(root, "a.txt")));
		await write(s, "w2", "a.txt", "recreated\n");
		assert.equal(await undo(s, "u1"), "modified");
		assert.equal(await content(join(root, "a.txt")), "recreated\n");
	});
});

/** The custom message entry `TurnReverter`'s record callback appends in the runtime. */
function revertEntry(turnId: string): SessionEntry {
	return {
		type: "custom_message",
		id: `revert-${turnId}`,
		parentId: null,
		timestamp: "2026-10-15T00:00:00.000Z",
		customType: TURN_REVERT_TYPE,
		content: "",
		display: false,
		details: { turnId, paths: [] },
	} as SessionEntry;
}

test("TurnReverter refuses a second revert while the first is running, and a reverted turn", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "a.txt"), "old\n");
		const entries = await writeTurn(root, [{ path: "a.txt", content: "new\n" }]);
		const reverter = new TurnReverter();
		let release!: () => void;
		const recorded = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = reverter.revert("u1", entries, root, async () => {
			await recorded;
		});
		assert.equal(reverter.isBusy(), true);
		await assert.rejects(
			reverter.revert("u1", entries, root, async () => {}),
			/already reverting/,
		);
		release();
		assert.deepEqual((await first).paths, [join(root, "a.txt")]);
		assert.equal(reverter.isBusy(), false);
		assert.equal(await readFile(join(root, "a.txt"), "utf8"), "old\n");
		// The branch records the revert, so the same turn is refused afterwards.
		await assert.rejects(
			reverter.revert("u1", [...entries, revertEntry("u1")], root, async () => {}),
			/already reverted/,
		);
	});
});

test("reverted turns are read from the revert entries, and the notice names the request and files", () => {
	const entries = [entry("u1", { role: "user", content: [{ type: "text", text: "rename the   title" }] }), revertEntry("u1")];
	assert.deepEqual(revertedTurnIds(entries), ["u1"]);
	const notice = turnRevertNotice(entries, "u1", [
		{ toolCallId: "1", path: "a.txt", patch: "", created: false },
		{ toolCallId: "2", path: "a.txt", patch: "", created: false },
		{ toolCallId: "3", path: "b.txt", patch: "", created: true },
	]);
	assert.match(notice, /"rename the title"/);
	assert.match(notice, /a\.txt, b\.txt\./);
});

test("each turn's delivery is rebuilt as that turn left the file", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await write(s, "w1", "index.html", "<p>one</p>\n");
		ask(s, "u2");
		await edit(s, "e2", "index.html", "one", "two");
		ask(s, "u3");
		await edit(s, "e3", "index.html", "two", "three");
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u1", "index.html", root), { text: "<p>one</p>\n", exact: true });
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u2", "index.html", root), { text: "<p>two</p>\n", exact: true });
		// The latest turn's version is the file on disk.
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u3", "index.html", root), { exact: true });
		// A reverted later turn is already gone from disk and is not reversed again.
		assert.equal(await undo(s, "u3"), "ok");
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u2", "index.html", root), { exact: true });
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u1", "index.html", root), { text: "<p>one</p>\n", exact: true });
		// Nothing was written while rebuilding.
		assert.equal(await content(join(root, "index.html")), "<p>two</p>\n");
	});
});

test("a turn's version is inexact when neither replay nor reversal reaches it", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		// The file predates the session, so no write records its content.
		await writeFile(join(root, "index.html"), "<p>zero</p>\n");
		ask(s, "u1");
		await edit(s, "e1", "index.html", "zero", "one");
		ask(s, "u2");
		await edit(s, "e2", "index.html", "one", "two");
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u1", "index.html", root), { text: "<p>one</p>\n", exact: true });
		// Edited outside the session: the later patch no longer reverses.
		await writeFile(join(root, "index.html"), "<p>elsewhere</p>\n");
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u1", "index.html", root), { exact: false });
		assert.deepEqual(await fileAtTurnEnd(s.entries, "missing-turn", "index.html", root), { exact: false });
	});
});

/** A Step-profile call as Web sessions record it: `write_file` keeps no patch, `edit_file` the edit's. */
async function stepWrite(s: Session, id: string, path: string, content: string, changed = true): Promise<void> {
	const input = { path, content };
	s.entries.push(entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "write_file", arguments: input }] }));
	if (changed) await writeFile(join(s.root, path), content);
	s.entries.push(entry(`r-${id}`, { role: "toolResult", toolCallId: id, details: { path, changed } }));
}

async function stepEdit(s: Session, id: string, path: string, search: string, replace: string): Promise<void> {
	s.entries.push(
		entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "edit_file", arguments: { path, search, replace } }] }),
	);
	const result = await createEditToolDefinition(s.root).execute(
		id,
		{ path, edits: [{ oldText: search, newText: replace }] },
		undefined,
		undefined,
		undefined as never,
	);
	s.entries.push(entry(`r-${id}`, { role: "toolResult", toolCallId: id, details: result.details }));
}

test("Step's edit_file patches are turn changes; a write_file is untracked, or nothing when unchanged", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		ask(s, "u1");
		await stepWrite(s, "w1", "index.html", "<p>one</p>\n");
		ask(s, "u2");
		await stepEdit(s, "e2", "index.html", "one", "two");
		ask(s, "u3");
		await stepWrite(s, "w3", "index.html", "<p>two</p>\n", false);
		assert.deepEqual(turnChanges(s.entries, "u1").skipped, [{ path: "index.html", reason: "unknown" }]);
		assert.equal(turnChanges(s.entries, "u2").changes.length, 1);
		assert.deepEqual(turnChanges(s.entries, "u3"), { changes: [], skipped: [] });
		// The Step edit's patch reverts like a built-in one.
		assert.equal(await undo(s, "u2"), "ok");
		assert.equal(await content(join(root, "index.html")), "<p>one</p>\n");
	});
});

test("turn versions replay from a recorded write, whatever happened to the file since", async () => {
	await withRoot(async (root) => {
		const s = session(root);
		await writeFile(join(root, "index.html"), "<p>one</p>\n");
		ask(s, "u1");
		// The file already held this content: still a recorded starting point.
		await stepWrite(s, "w1", "index.html", "<p>one</p>\n", false);
		ask(s, "u2");
		await stepEdit(s, "e2", "index.html", "one", "two");
		ask(s, "u3");
		await stepEdit(s, "e3", "index.html", "two", "three");
		// Edited outside the session afterwards: reversing from disk would fail, replaying does not.
		await writeFile(join(root, "index.html"), "<p>elsewhere</p>\n");
		for (const [turn, text] of [["u1", "one"], ["u2", "two"], ["u3", "three"]]) {
			assert.deepEqual(await fileAtTurnEnd(s.entries, turn, "index.html", root), {
				text: `<p>${text}</p>\n`,
				exact: true,
			});
		}
		// A version that is still the file on disk keeps the live URL.
		await writeFile(join(root, "index.html"), "<p>three</p>\n");
		assert.deepEqual(await fileAtTurnEnd(s.entries, "u3", "index.html", root), { exact: true });
		assert.equal(await content(join(root, "index.html")), "<p>three</p>\n");
	});
});

test("a forward patch applies the recorded change and refuses content that moved on", () => {
	assert.equal(applyPatch("a\nb\nc\n", PATCHES.edit), "a\nB\nc\nd\n");
	assert.equal(applyPatch("a\nb", PATCHES.appendNoEol), "a\nb\nc");
	assert.throws(() => applyPatch("x\ny\n", PATCHES.edit));
});
