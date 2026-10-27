import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getToolPath } from "../src/utils/tools-manager.ts";

const exe = process.platform === "win32" ? ".exe" : "";

describe("getToolPath bundled tools fallback", () => {
	let root: string;
	let originalPath: string | undefined;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "step-bundled-tools-"));
		// Hide any system rg so only the managed and bundled locations can match.
		originalPath = process.env.PATH;
		process.env.PATH = "";
	});

	afterEach(async () => {
		process.env.PATH = originalPath;
		await rm(root, { recursive: true, force: true });
	});

	it("uses the binary bundled next to the executable when nothing else is installed", async () => {
		const bundled = join(root, "tools");
		await mkdir(bundled);
		await writeFile(join(bundled, `rg${exe}`), "");
		expect(getToolPath("rg", join(root, "agent"), bundled)).toBe(join(bundled, `rg${exe}`));
	});

	it("prefers the managed agent bin over the bundled copy", async () => {
		const bundled = join(root, "tools");
		const agentBin = join(root, "agent", "bin");
		await mkdir(bundled);
		await mkdir(agentBin, { recursive: true });
		await writeFile(join(bundled, `rg${exe}`), "");
		await writeFile(join(agentBin, `rg${exe}`), "");
		expect(getToolPath("rg", join(root, "agent"), bundled)).toBe(join(agentBin, `rg${exe}`));
	});

	it("returns null without a bundled dir", () => {
		expect(getToolPath("rg", join(root, "agent"), undefined)).toBeNull();
	});
});
