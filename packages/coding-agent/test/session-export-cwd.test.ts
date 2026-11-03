import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportSessionToJsonl } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "step-export-"));
	tempDirs.push(dir);
	return dir;
}

describe("exportSessionToJsonl output base", () => {
	test("a relative output path lands in the session working directory", () => {
		const sessionCwd = makeTempDir();
		const sessionManager = SessionManager.create(sessionCwd);

		const written = exportSessionToJsonl(sessionManager, "out.jsonl");

		expect(written).toBe(resolve(sessionCwd, "out.jsonl"));
		expect(existsSync(written)).toBe(true);
		const header = JSON.parse(readFileSync(written, "utf-8").split("\n")[0]);
		expect(header.cwd).toBe(resolve(sessionCwd));
	});

	test("an absolute output path is honoured as-is", () => {
		const sessionCwd = makeTempDir();
		const elsewhere = makeTempDir();
		const target = join(elsewhere, "custom.jsonl");
		const sessionManager = SessionManager.create(sessionCwd);

		const written = exportSessionToJsonl(sessionManager, target);

		expect(written).toBe(resolve(target));
		expect(existsSync(target)).toBe(true);
	});
});
