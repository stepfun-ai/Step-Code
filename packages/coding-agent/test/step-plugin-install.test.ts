import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { readPluginZip, safePluginPath } from "../src/step/plugin-archive.ts";
import { installPreparedPlugin, preparePluginPackage } from "../src/step/plugin-install.ts";

function zip(path: string, body: string, mode = 0o100644): Buffer {
	const name = Buffer.from(path);
	const data = Buffer.from(body);
	const payload = deflateRawSync(data);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50);
	local.writeUInt16LE(0x800, 6);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc32(data), 14);
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50);
	central.writeUInt16LE(0x314, 4);
	central.writeUInt16LE(0x800, 8);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc32(data), 16);
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	central.writeUInt32LE((mode << 16) >>> 0, 38);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + payload.length, 16);
	return Buffer.concat([local, name, payload, central, name, end]);
}

test("ZIP validates content rather than extension and supports a wrapped plugin", () => {
	const files = readPluginZip(zip("包/step.plugin.json", '{"id":"demo"}'));
	expect(preparePluginPackage(files).preview.id).toBe("demo");
	expect(() => readPluginZip(Buffer.from("not a zip"))).toThrow();
	const corrupt = zip("step.plugin.json", '{"id":"demo"}');
	corrupt[50] ^= 1;
	expect(() => readPluginZip(corrupt)).toThrow();
});
test("traversal, Windows aliases, symlinks, multiple packages and missing contributions fail", () => {
	for (const path of [
		"../step.plugin.json",
		"/step.plugin.json",
		"C:/step.plugin.json",
		"a\\step.plugin.json",
		"CON/a",
		"a./b",
	])
		expect(safePluginPath(path)).toBe(false);
	expect(() => readPluginZip(zip("step.plugin.json", "{}", 0o120777))).toThrow();
	expect(() =>
		preparePluginPackage([
			{ path: "a/step.plugin.json", data: Buffer.from('{"id":"a"}') },
			{ path: "b/step.plugin.json", data: Buffer.from('{"id":"b"}') },
		]),
	).toThrow();
	expect(() =>
		preparePluginPackage([{ path: "step.plugin.json", data: Buffer.from('{"id":"demo","skills":["skills/demo"]}') }]),
	).toThrow(/Skill entry/);
});
test("encrypted, oversized and inconsistent local/central ZIP records fail", () => {
	for (const mutation of ["encrypted", "size", "offset", "crc"]) {
		const data = zip("step.plugin.json", '{"id":"demo"}');
		const central = data.readUInt32LE(data.length - 6);
		if (mutation === "encrypted") {
			data.writeUInt16LE(0x801, 6);
			data.writeUInt16LE(0x801, central + 8);
		}
		if (mutation === "size") data.writeUInt32LE(65 * 1024 * 1024, central + 24);
		if (mutation === "offset") data.writeUInt32LE(central, central + 42);
		if (mutation === "crc") data.writeUInt32LE(0, central + 16);
		expect(() => readPluginZip(data)).toThrow();
	}
});

test("concurrent installs have one winner and stale locks recover", async () => {
	const root = await mkdtemp(join(tmpdir(), "plugin-install-lock-"));
	try {
		const pkg = preparePluginPackage(readPluginZip(zip("step.plugin.json", '{"id":"demo"}')));
		await mkdir(join(root, ".install-demo.lock"));
		const old = new Date(Date.now() - 120000);
		await utimes(join(root, ".install-demo.lock"), old, old);
		const result = await Promise.allSettled([installPreparedPlugin(pkg, root), installPreparedPlugin(pkg, root)]);
		expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		expect(result.filter((entry) => entry.status === "rejected")).toHaveLength(1);
		expect(await readFile(join(root, "demo", "step.plugin.json"), "utf8")).toBe('{"id":"demo"}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("confirmed payload is installed atomically and conflicts do not overwrite", async () => {
	const root = await mkdtemp(join(tmpdir(), "plugin-install-test-"));
	try {
		const pkg = preparePluginPackage(readPluginZip(zip("step.plugin.json", '{"id":"demo"}')));
		await installPreparedPlugin(pkg, root);
		expect(await readFile(join(root, "demo", "step.plugin.json"), "utf8")).toBe('{"id":"demo"}');
		await expect(installPreparedPlugin(pkg, root)).rejects.toMatchObject({ status: 409 });
		expect(await readFile(join(root, "demo", "step.plugin.json"), "utf8")).toBe('{"id":"demo"}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
