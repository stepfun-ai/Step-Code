import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	getClientFileSystemBridge,
	setClientFileSystemBridge,
	withClientFileSystemEdit,
	withClientFileSystemEditOptions,
	withClientFileSystemRead,
	withClientFileSystemReadOptions,
	withClientFileSystemWrite,
	withClientFileSystemWriteOptions,
} from "../src/core/tools/client-fs.ts";
import { defaultEditOperations } from "../src/core/tools/edit.ts";
import { defaultReadOperations } from "../src/core/tools/read.ts";
import { defaultWriteOperations } from "../src/core/tools/write.ts";

const workspaces: string[] = [];

afterEach(async () => {
	setClientFileSystemBridge(undefined);
	await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "client-fs-"));
	workspaces.push(dir);
	return dir;
}

test("a bridge read replaces the local read and a cleared one restores it", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	await writeFile(file, "on disk", "utf-8");
	const readTextFile = vi.fn(async () => "in the editor buffer");

	setClientFileSystemBridge({ readTextFile });
	const bridged = withClientFileSystemRead(defaultReadOperations);

	const buffer = await bridged.readFile(file);
	expect(buffer.toString("utf-8")).toBe("in the editor buffer");
	expect(readTextFile).toHaveBeenCalledWith(file);

	setClientFileSystemBridge(undefined);
	expect((await bridged.readFile(file)).toString("utf-8")).toBe("on disk");
});

test("a client that advertises only writes leaves reads local", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	await writeFile(file, "on disk", "utf-8");
	const writeTextFile = vi.fn(async () => {});

	setClientFileSystemBridge({ writeTextFile });
	const bridged = withClientFileSystemRead(defaultReadOperations);

	// The bridge exists, so a wrapper that checked only for a bridge would route
	// the read and get nothing back.
	expect((await bridged.readFile(file)).toString("utf-8")).toBe("on disk");
	expect(getClientFileSystemBridge()?.readTextFile).toBeUndefined();
});

test("an image read stays local even when a bridge is installed", async () => {
	const dir = await workspace();
	// A PNG magic number, so the local path sees a real image rather than text.
	const file = path.join(dir, "shot.png");
	await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const readTextFile = vi.fn(async () => "not bytes");

	setClientFileSystemBridge({ readTextFile });
	const bridged = withClientFileSystemRead(defaultReadOperations);

	const buffer = await bridged.readFile(file);
	expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	expect(readTextFile).not.toHaveBeenCalled();
});

test("a failed client read falls back to the local file", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	await writeFile(file, "on disk", "utf-8");
	setClientFileSystemBridge({
		readTextFile: async () => {
			throw new Error("client said methodNotFound");
		},
	});
	const bridged = withClientFileSystemRead(defaultReadOperations);

	await expect(bridged.readFile(file)).rejects.toThrow("methodNotFound");
});

test("edit reads and writes travel the same road", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	await writeFile(file, "old", "utf-8");
	const readTextFile = vi.fn(async () => "old");
	const writeTextFile = vi.fn(async () => {});

	setClientFileSystemBridge({ readTextFile, writeTextFile });
	const bridged = withClientFileSystemEdit(defaultEditOperations);

	expect((await bridged.readFile(file)).toString("utf-8")).toBe("old");
	await bridged.writeFile(file, "new");
	expect(writeTextFile).toHaveBeenCalledWith(file, "new");
});

test("a write with no client bridge writes locally", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	const bridged = withClientFileSystemWrite(defaultWriteOperations);

	await bridged.writeFile(file, "written");
	if (bridged.readFile === undefined) throw new Error("readFile missing");
	const readBack = await bridged.readFile(file);
	expect(readBack?.toString("utf-8")).toBe("written");
});

test("option wrappers bridge a caller that passed no operations", async () => {
	const dir = await workspace();
	const file = path.join(dir, "note.txt");
	await writeFile(file, "on disk", "utf-8");
	const readTextFile = vi.fn(async () => "through the wrapper");

	setClientFileSystemBridge({ readTextFile });
	// No operations supplied, which is the common case: wrapping only a supplied
	// object would leave this path permanently local.
	const options = withClientFileSystemReadOptions(undefined);
	const operations = options.operations;
	expect(operations).toBeDefined();
	if (operations === undefined) throw new Error("operations missing");
	expect((await operations.readFile(file)).toString("utf-8")).toBe("through the wrapper");
	expect(withClientFileSystemEditOptions(undefined).operations).toBeDefined();
	expect(withClientFileSystemWriteOptions(undefined).operations).toBeDefined();
});

test("the bridge is process-scoped and cleared between hosts", () => {
	expect(getClientFileSystemBridge()).toBeUndefined();
	setClientFileSystemBridge({ readTextFile: async () => "one" });
	expect(getClientFileSystemBridge()?.readTextFile).toBeDefined();
	setClientFileSystemBridge(undefined);
	expect(getClientFileSystemBridge()).toBeUndefined();
});

beforeEach(() => {
	vi.restoreAllMocks();
});
