import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findArchiveRoot } from "./local-update.ts";

let extractDir: string;

beforeEach(async () => {
	extractDir = await mkdtemp(path.join(os.tmpdir(), "step-update-archive-root-"));
});

afterEach(async () => {
	await rm(extractDir, { recursive: true, force: true });
});

test("a flat Windows zip keeps the extract dir as archive root", async () => {
	await writeFile(path.join(extractDir, "step.exe"), "binary");
	await mkdir(path.join(extractDir, "docs"));
	await mkdir(path.join(extractDir, "node_modules"));

	expect(await findArchiveRoot(extractDir, "step.exe")).toBe(extractDir);
});

test("a wrapped Unix archive descends into the single top-level directory", async () => {
	const wrapper = path.join(extractDir, "step");
	await mkdir(wrapper);
	await writeFile(path.join(wrapper, "step"), "binary");
	await mkdir(path.join(wrapper, "docs"));

	expect(await findArchiveRoot(extractDir, "step")).toBe(wrapper);
});

test("a wrapper directory wins over loose files at the extract root", async () => {
	const wrapper = path.join(extractDir, "step");
	await mkdir(wrapper);
	await writeFile(path.join(wrapper, "step"), "binary");
	await writeFile(path.join(extractDir, "README.md"), "notes");

	expect(await findArchiveRoot(extractDir, "step")).toBe(wrapper);
});

test("ambiguous layouts fall back to the extract dir for recursive search", async () => {
	await mkdir(path.join(extractDir, "bin"));
	await mkdir(path.join(extractDir, "lib"));

	expect(await findArchiveRoot(extractDir, "step")).toBe(extractDir);
});
