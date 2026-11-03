import type * as Fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool, type ToolStatus } from "../src/utils/tools-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => true),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ensureTool", () => {
	it("returns an already-installed tool without downloading or reporting status", async () => {
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		// existsSync is mocked to true, so the tool resolves to its installed path.
		expect(result).toBeDefined();
		expect(statuses).toEqual([]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});
});
