import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { folderOpenCommand, openFolder, type Spawn } from "../src/open-folder.ts";

test("each platform opens a folder in its file manager without a shell", () => {
	assert.deepEqual(folderOpenCommand("darwin", "/Users/me/a,b"), {
		command: "open",
		args: ["/Users/me/a,b"],
		verbatim: false,
	});
	// Explorer splits at commas: the path stays one quoted argument.
	assert.deepEqual(folderOpenCommand("win32", "C:\\Users\\me\\a,b c"), {
		command: "explorer.exe",
		args: ['"C:\\Users\\me\\a,b c"'],
		verbatim: true,
	});
	// A drive root must not escape the closing quote.
	assert.deepEqual(folderOpenCommand("win32", "D:\\").args, ['"D:\\."']);
	assert.equal(folderOpenCommand("linux", "/home/me").command, "xdg-open");
});

function fakeSpawn(outcome: "spawn" | "error") {
	const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
	const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), { unref: () => {} });
		queueMicrotask(() => {
			if (outcome === "spawn") child.emit("spawn");
			else child.emit("error", new Error("ENOENT"));
		});
		return child;
	}) as unknown as Spawn;
	return { run, calls };
}

test("a folder opens once its launcher starts; files and launch failures are refused", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stepcode-open-folder-"));
	try {
		const ok = fakeSpawn("spawn");
		await openFolder(dir, "win32", ok.run);
		assert.equal(ok.calls[0]?.command, "explorer.exe");
		assert.equal(ok.calls[0]?.options.windowsVerbatimArguments, true);
		await assert.rejects(openFolder(dir, "darwin", fakeSpawn("error").run), /Could not open the folder/);
		await writeFile(join(dir, "file.txt"), "x");
		const unused = fakeSpawn("spawn");
		await assert.rejects(openFolder(join(dir, "file.txt"), "darwin", unused.run), /not a folder/);
		assert.equal(unused.calls.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
