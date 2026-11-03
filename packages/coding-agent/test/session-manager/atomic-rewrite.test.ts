import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// Preserve real file I/O while making the ESM read/write exports spyable, so the
// rewrite failure below is simulated at the file boundary instead of by making
// the test directory unwritable (which does not reproduce the truncation).
vi.mock("node:fs", { spy: true });

// The spied namespace replaces the named exports too, so the real implementation
// has to be captured before a spy delegates back to it.
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/** A v1 session (no header version, no entry ids) that migrates to v3 on open. */
const LEGACY_SESSION = [
	{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
	{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
	{
		type: "message",
		timestamp: "2025-01-01T00:00:02Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 2,
		},
	},
]
	.map((entry) => JSON.stringify(entry))
	.join("\n")
	.concat("\n");

describe("session file migration rewrite", () => {
	let tempDir: string;
	let sessionDir: string;
	let sessionFile: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "step-session-rewrite-"));
		sessionDir = join(tempDir, "sessions");
		sessionFile = join(sessionDir, "session.jsonl");
		fs.mkdirSync(sessionDir, { recursive: true });
		writeFileSync(sessionFile, LEGACY_SESSION, "utf8");
	});

	afterEach(() => {
		vi.mocked(fs.writeFileSync).mockRestore();
		vi.mocked(fs.renameSync).mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rewrites a migrated session in place and leaves no temporary file", () => {
		expect(() => SessionManager.open(sessionFile)).not.toThrow();

		const rewritten = readFileSync(sessionFile, "utf8");
		const header = JSON.parse(rewritten.split("\n")[0]!);
		expect(header.version).toBe(3);
		expect(rewritten.trim().split("\n")).toHaveLength(3);
		expect(readdirSync(sessionDir)).toEqual(["session.jsonl"]);
	});

	it("keeps the original file intact when writing the rewrite fails", () => {
		// Fail the first entry write, which is the point where truncating the
		// original in place would already have destroyed the saved history.
		vi.mocked(fs.writeFileSync).mockImplementation(((file: unknown, ...rest: unknown[]) => {
			if (typeof file === "number") throw new Error("ENOSPC: no space left on device");
			return (realFs.writeFileSync as (...args: unknown[]) => void)(file, ...rest);
		}) as unknown as typeof fs.writeFileSync);

		expect(() => SessionManager.open(sessionFile)).toThrow(/ENOSPC/);

		expect(readFileSync(sessionFile, "utf8")).toBe(LEGACY_SESSION);
		expect(readdirSync(sessionDir)).toEqual(["session.jsonl"]);
	});

	it("keeps the original file intact when the rewrite cannot be renamed into place", () => {
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("EIO: i/o error");
		});

		expect(() => SessionManager.open(sessionFile)).toThrow(/EIO/);

		expect(readFileSync(sessionFile, "utf8")).toBe(LEGACY_SESSION);
		expect(readdirSync(sessionDir)).toEqual(["session.jsonl"]);
	});
});
