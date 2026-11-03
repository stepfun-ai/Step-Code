import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { folderOpenCommand, openFileWithDefaultApp, openFolder, type Spawn } from "../src/open-folder.ts";

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

/** A launcher that exits with the next queued code (macOS `open` is awaited). */
function exitingSpawn(codes: number[]) {
	const calls: { command: string; args: readonly string[] }[] = [];
	const run = ((command: string, args: readonly string[]) => {
		calls.push({ command, args });
		const child = Object.assign(new EventEmitter(), { unref: () => {} });
		const code = codes.shift() ?? 0;
		queueMicrotask(() => {
			child.emit("spawn");
			child.emit("close", code);
		});
		return child;
	}) as unknown as Spawn;
	return { run, calls };
}

test("a file opens in its associated app, falling back to the text editor on macOS", async () => {
	const dir = await mkdtemp(join(tmpdir(), "stepcode-open-file-"));
	const file = join(dir, "models.json");
	try {
		await writeFile(file, "{}");
		const associated = exitingSpawn([0]);
		await openFileWithDefaultApp(file, "darwin", associated.run);
		assert.deepEqual(associated.calls, [{ command: "open", args: [file] }]);

		const unassociated = exitingSpawn([1, 0]);
		await openFileWithDefaultApp(file, "darwin", unassociated.run);
		assert.deepEqual(unassociated.calls[1], { command: "open", args: ["-t", file] });
		await assert.rejects(openFileWithDefaultApp(file, "darwin", exitingSpawn([1, 1]).run), /Could not open the file/);

		const windows = fakeSpawn("spawn");
		await openFileWithDefaultApp(file, "win32", windows.run);
		assert.equal(windows.calls[0]?.command, "explorer.exe");
		const linux = fakeSpawn("spawn");
		await openFileWithDefaultApp(file, "linux", linux.run);
		assert.equal(linux.calls[0]?.command, "xdg-open");

		const unused = fakeSpawn("spawn");
		await assert.rejects(openFileWithDefaultApp(dir, "darwin", unused.run), /not a file/);
		assert.equal(unused.calls.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
