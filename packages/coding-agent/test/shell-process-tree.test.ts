import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/utils/shell.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync) };
});

function processStat(pid: number, parent: number, started: string): string {
	const fields = Array<string>(22).fill("0");
	fields[0] = "S";
	fields[1] = String(parent);
	fields[2] = String(pid); // Every fixture process has a different group.
	fields[19] = started;
	return `${pid} (fixture (with parentheses)) ${fields.join(" ")}`;
}

describe.skipIf(process.platform !== "linux")("Linux command descendant cleanup", () => {
	beforeEach(() => {
		vi.spyOn(process, "kill").mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(fs.readFileSync).mockReset();
		vi.mocked(fs.readdirSync).mockReset();
	});

	function installProcessTable(reusedPid?: number): void {
		const table = new Map([
			[101, processStat(101, 1, "1001")],
			[102, processStat(102, 101, "1002")],
			[103, processStat(103, 102, "1003")],
			[199, processStat(199, 1, "1099")],
		]);
		const reads = new Map<number, number>();
		// The cast selects readdirSync's string[] overload in this filesystem mock.
		vi.mocked(fs.readdirSync).mockReturnValue(["self", ...table.keys()].map(String) as never);
		vi.mocked(fs.readFileSync).mockImplementation((path) => {
			const pid = Number(/^\/proc\/(\d+)\/stat$/u.exec(String(path))?.[1]);
			const count = (reads.get(pid) ?? 0) + 1;
			reads.set(pid, count);
			if (pid === reusedPid && count > 1) return processStat(pid, 1, "9000");
			const stat = table.get(pid);
			if (!stat) throw Object.assign(new Error("process exited"), { code: "ENOENT" });
			return stat;
		});
	}

	it("kills nested descendants in separate groups without targeting an unrelated process", () => {
		installProcessTable();
		killProcessTree(101);
		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-101, "SIGKILL"],
			[103, "SIGKILL"],
			[102, "SIGKILL"],
		]);
	});

	it("does not signal a descendant PID whose start time changed after the snapshot", () => {
		installProcessTable(102);
		killProcessTree(101);
		expect(vi.mocked(process.kill).mock.calls).toEqual([
			[-101, "SIGKILL"],
			[103, "SIGKILL"],
		]);
	});

	it("retains process-group cleanup when proc discovery is unavailable", () => {
		vi.mocked(fs.readdirSync).mockImplementation(() => {
			throw Object.assign(new Error("proc unavailable"), { code: "EACCES" });
		});
		killProcessTree(101);
		expect(vi.mocked(process.kill).mock.calls).toEqual([[-101, "SIGKILL"]]);
	});
});
