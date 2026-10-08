import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("Step command output spool recovery", () => {
	let directory: string;
	const logs = new Set<string>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-output-spool-"));
		vi.mocked(fs.createWriteStream).mockClear();
	});

	afterEach(async () => {
		for (const path of logs) await rm(path, { force: true });
		logs.clear();
		await rm(directory, { recursive: true, force: true });
	});

	it.each([false, true])("returns all diagnostics if spooling fails (printed log notice: %s)", async (printNotice) => {
		const raw = `${"head".repeat(2_000)}\nSOLE_COPY_DIAGNOSTIC\n${"tail".repeat(2_000)}${printNotice ? "\n\n[Full output: /not-a-real-spool.log]" : ""}`;
		vi.mocked(fs.createWriteStream).mockImplementationOnce(() => {
			return new Writable({
				write(_chunk, _encoding, callback) {
					callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
				},
			}) as fs.WriteStream;
		});
		const tool = createStepToolProfile(directory, {
			agentDir: join(directory, "agent"),
			bash: {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from(raw));
						return { exitCode: 7 };
					},
				},
			},
		}).find((candidate) => candidate.name === "run_command")!;
		await expect(
			tool.execute(
				"spool-failed",
				{ command: "fixture", max_output_chars: 1_000 },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(`${raw}\n\nCommand exited with code 7`);
		expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ nativeCap: false, limit: 200, exitCode: 7 },
		{ nativeCap: true, limit: 200, exitCode: 7 },
		{ nativeCap: true, limit: 1_000, exitCode: 0 },
	])(
		"keeps the full log and status with nativeCap=$nativeCap, limit=$limit, exitCode=$exitCode",
		async ({ nativeCap, limit, exitCode }) => {
			const bytes = Buffer.from(
				`${"head".repeat(nativeCap ? 8_000 : 2_000)}\nMIDDLE_DIAGNOSTIC\n${"tail".repeat(nativeCap ? 8_000 : 2_000)}\nEOF_DIAGNOSTIC\n`,
			);
			const tool = createStepToolProfile(directory, {
				agentDir: join(directory, "agent"),
				bash: {
					operations: {
						exec: async (_command, _cwd, { onData }) => {
							onData(bytes.subarray(0, 8_001));
							onData(bytes.subarray(8_001));
							return { exitCode };
						},
					},
				},
			}).find((candidate) => candidate.name === "run_command")!;
			let text: string;
			try {
				const result = await tool.execute(
					"capped",
					{ command: "fixture", max_output_chars: limit },
					undefined,
					undefined,
					undefined as never,
				);
				expect(exitCode).toBe(0);
				text = textOf(result);
			} catch (error) {
				expect(exitCode).toBe(7);
				text = (error as Error).message;
				expect(text).toContain("Command exited with code 7");
			}
			const fullPath = /Full output: ([^\]\n]+)/u.exec(text)?.[1];
			expect(fullPath).toBeDefined();
			logs.add(fullPath!);
			expect(await readFile(fullPath!)).toEqual(bytes);
			expect(text).toContain("truncated");
			expect(text.length).toBeLessThanOrEqual(Math.max(limit, fullPath!.length + 100));
			if (limit >= 1_000) expect(text).toContain("EOF_DIAGNOSTIC");
			expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
		},
	);
});
