import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellToolError } from "../src/core/tools/bash.ts";
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
		const result = await tool.execute(
			"spool-failed",
			{ command: "fixture", max_output_chars: 1_000 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(false);
		expect(textOf(result)).toBe(`${raw}\n\nCommand exited with code 7`);
		expect(result.details).toMatchObject({ execution: { exitCode: 7, status: "exited" } });
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
			const result = await tool.execute(
				"capped",
				{ command: "fixture", max_output_chars: limit },
				undefined,
				undefined,
				undefined as never,
			);
			expect(result.isError).toBe(false);
			expect(result.details).toMatchObject({ execution: { exitCode } });
			const text = textOf(result);
			expect(text).toContain(`Command exited with code ${exitCode}`);
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

	it.each(["unknown", "executor_fault", "long_executor_fault"] as const)(
		"bounds %s output using producer metadata instead of parsing status text",
		async (kind) => {
			const raw = "x".repeat(16_000);
			const reason = kind === "long_executor_fault" ? "long diagnostic ".repeat(1_000) : "executor connection lost";
			const tool = createStepToolProfile(directory, {
				agentDir: join(directory, "agent"),
				bash: {
					operations: {
						exec: async (_command, _cwd, { onData }) => {
							onData(Buffer.from(raw));
							if (kind !== "unknown") throw new Error(reason);
							return { exitCode: null };
						},
					},
				},
			}).find((candidate) => candidate.name === "run_command")!;
			let rendered: string;
			let details: Record<string, unknown>;
			try {
				const result = await tool.execute(
					"bounded-outcome",
					{ command: "fixture", max_output_chars: 200 },
					undefined,
					undefined,
					undefined as never,
				);
				expect(kind).toBe("unknown");
				expect(result.isError).toBe(false);
				rendered = textOf(result);
				details = result.details;
			} catch (error) {
				expect(kind).not.toBe("unknown");
				expect(error).toBeInstanceOf(ShellToolError);
				const failure = error as ShellToolError;
				expect(failure.result.isError).toBe(true);
				rendered = failure.message;
				details = failure.result.details as Record<string, unknown>;
			}
			const fullPath = details.fullOutputPath as string;
			logs.add(fullPath);
			expect(details.stepTruncated).toBe(true);
			expect(rendered).toContain(fullPath);
			expect(rendered.length).toBeLessThan(350);
			const retained = await readFile(fullPath, "utf8");
			expect(retained).toContain(raw);
			if (kind !== "unknown") expect(retained).toContain(reason);
		},
	);

	it.each([
		{ label: "single-line executor fault", multiline: false, executorFault: true },
		{ label: "multiline executor fault", multiline: true, executorFault: true },
		{ label: "multiline successful execution", multiline: true, executorFault: false },
	])("reports mandatory retention failure after $label", async ({ multiline, executorFault }) => {
		vi.mocked(fs.createWriteStream).mockImplementationOnce(
			() =>
				new Writable({
					write(_chunk, _encoding, callback) {
						callback(new Error("output storage unavailable"));
					},
				}) as fs.WriteStream,
		);
		const tool = createStepToolProfile(directory, {
			agentDir: join(directory, "agent"),
			bash: {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						const raw = multiline ? "0123456789abcdef row\n".repeat(4_000) : "x".repeat(70_000);
						onData(Buffer.from(`${raw}\nOBSERVED_OUTPUT\n`));
						await new Promise<void>((resolve) => setImmediate(resolve));
						if (executorFault) throw new Error("executor unavailable");
						return { exitCode: 0 };
					},
				},
			},
		}).find((candidate) => candidate.name === "run_command")!;
		const failure = await tool
			.execute(
				"combined-fault",
				{ command: "fixture", max_output_chars: 200 },
				undefined,
				undefined,
				undefined as never,
			)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toBeInstanceOf(ShellToolError);
		const observed = failure as ShellToolError;
		expect(observed.result).toMatchObject({
			isError: true,
			details: { execution: { status: executorFault ? "unknown" : "exited", exitCode: executorFault ? null : 0 } },
		});
		expect(observed.message).toContain("OBSERVED_OUTPUT");
		expect(observed.message).toContain("output storage unavailable");
		expect(observed.message).not.toContain("Full output: undefined");
		expect(observed.result.details.fullOutputPath).toBeUndefined();
	});
});
