import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createStepToolProfile, type StepThenRunDetails } from "../src/step/tool-profile.ts";

type Tool = ReturnType<typeof createStepToolProfile>[number];
type Result = Awaited<ReturnType<Tool["execute"]>>;

function text(result: Result): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function commandDetails(result: Result): StepThenRunDetails {
	return (result.details as { thenRun: StepThenRunDetails }).thenRun;
}

describe("then_run uses run_command execution", () => {
	let directory: string;
	const logs = new Set<string>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "step-then-run-parity-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
		await Promise.all([...logs].map((path) => rm(path, { force: true })));
		logs.clear();
	});

	function profile(operations?: BashOperations) {
		const tools = createStepToolProfile(directory, {
			agentDir: join(directory, "agent"),
			...(operations ? { bash: { operations } } : {}),
		});
		return {
			run: tools.find((tool) => tool.name === "run_command")!,
			write: tools.find((tool) => tool.name === "write_file")!,
			edit: tools.find((tool) => tool.name === "edit_file")!,
		};
	}

	it.each([
		{ label: "default", milliseconds: undefined, seconds: 120 },
		{ label: "host timeout", milliseconds: 180_500, seconds: 180.5 },
	])("shares the $label with both write and edit", async ({ milliseconds, seconds }) => {
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("checked\n"));
			return { exitCode: 0 };
		});
		const { run, write, edit } = profile({ exec });
		const runSpy = vi.spyOn(run, "execute");
		const context =
			milliseconds === undefined
				? (undefined as never)
				: ({ cwd: directory, commandTimeoutMs: milliseconds } as unknown as ExtensionContext);
		await run.execute("standalone", { command: "check" }, undefined, undefined, context);
		await write.execute(
			"write",
			{ path: "sample.txt", content: "before\n", then_run: "check" },
			undefined,
			undefined,
			context,
		);
		await edit.execute(
			"edit",
			{ path: "sample.txt", search: "before", replace: "after", then_run: "check" },
			undefined,
			undefined,
			context,
		);

		expect(exec.mock.calls.map((call) => call[2].timeout)).toEqual([seconds, seconds, seconds]);
		expect(runSpy).toHaveBeenCalledTimes(3);
		expect(runSpy.mock.calls.slice(1).map((call) => call[1])).toEqual([{ command: "check" }, { command: "check" }]);
		expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("after\n");
	});

	it("keeps commands in the initial directory when editing a nested file", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const { run, write } = profile({ exec });
		await mkdir(join(directory, "nested"));
		await mkdir(join(directory, "host"));
		const context = { cwd: join(directory, "host"), commandTimeoutMs: 45_000 } as unknown as ExtensionContext;
		await run.execute("standalone", { command: "check" }, undefined, undefined, context);
		await write.execute(
			"write",
			{ path: join(directory, "nested", "sample.txt"), content: "ok\n", then_run: "check" },
			undefined,
			undefined,
			context,
		);
		expect(exec.mock.calls.map((call) => call[1])).toEqual([directory, directory]);
		expect(exec.mock.calls.map((call) => call[2].timeout)).toEqual([45, 45]);
	});

	it.each([
		{ chars: 35_000, exitCode: 0 },
		{ chars: 35_000, exitCode: 7 },
		{ chars: 70_000, exitCode: 0 },
		{ chars: 70_000, exitCode: 7 },
	])("retains the complete $chars-character output after exit $exitCode", async ({ chars, exitCode }) => {
		const { write } = profile();
		const command = `printf '%0${chars}d' 0; exit ${exitCode}`;
		const result = await write.execute(
			"write",
			{ path: "sample.txt", content: "applied\n", then_run: command },
			undefined,
			undefined,
			undefined as never,
		);
		const output = text(result);
		const referencedPath = /\[Full output: ([^\]\n]+)\]/u.exec(output)?.[1];
		if (referencedPath) logs.add(referencedPath);
		const details = commandDetails(result);
		if (details.fullOutputPath) logs.add(details.fullOutputPath);

		expect(details).toMatchObject({ exitCode, timedOut: false, stepTruncated: true });
		expect(details.fullOutputPath).toBeTruthy();
		expect(referencedPath).toBe(details.fullOutputPath);
		expect(await readFile(details.fullOutputPath!, "utf8")).toBe("0".repeat(chars));
		expect(output).toContain(`Command exited with code ${exitCode}`);
		expect(output).not.toContain("call run_command again");
		expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("applied\n");
		expect(result).not.toHaveProperty("isError", true);
	});

	it("applies the host output cap without dropping the log or rerunning the command", async () => {
		const { write } = profile();
		const context = { cwd: directory, commandOutputLimit: 100 } as unknown as ExtensionContext;
		const command = "printf x >> executed.txt; printf '%035000d' 0";
		const result = await write.execute(
			"write",
			{ path: "sample.txt", content: "applied\n", then_run: command },
			undefined,
			undefined,
			context,
		);
		const details = commandDetails(result);
		if (details.fullOutputPath) logs.add(details.fullOutputPath);
		const referencedPath = /\[Full output: ([^\]\n]+)\]/u.exec(text(result))?.[1];
		if (referencedPath) logs.add(referencedPath);

		expect(details.fullOutputPath).toBeTruthy();
		expect(await readFile(details.fullOutputPath!, "utf8")).toBe("0".repeat(35_000));
		expect(text(result)).toContain(details.fullOutputPath);
		expect(text(result).length).toBeLessThan(600);
		expect(await readFile(join(directory, "executed.txt"), "utf8")).toBe("x");
	});

	it("preserves the edit and command status when a check fails", async () => {
		const { edit } = profile();
		await writeFile(join(directory, "sample.txt"), "before\n");
		const result = await edit.execute(
			"edit",
			{ path: "sample.txt", search: "before", replace: "after", then_run: "printf failed; exit 3" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("after\n");
		expect(commandDetails(result)).toEqual({
			command: "printf failed; exit 3",
			exitCode: 3,
			timedOut: false,
			stepTruncated: false,
		});
		expect(text(result)).toMatch(/Command exited with code 3$/u);
		expect(result).not.toHaveProperty("isError", true);
	});

	it("keeps timeout failure distinct from caller cancellation", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => {
			throw new Error("timeout:1");
		});
		const { write } = profile({ exec });
		const context = { cwd: directory, commandTimeoutMs: 1_000 } as unknown as ExtensionContext;
		const result = await write.execute(
			"write",
			{ path: "sample.txt", content: "applied\n", then_run: "check" },
			undefined,
			undefined,
			context,
		);
		expect(commandDetails(result)).toMatchObject({ exitCode: null, timedOut: true });
		expect(text(result)).toContain("Command timed out after 1 seconds");
		expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("applied\n");
	});

	it("propagates caller cancellation with the mutation receipt and performs no retry", async () => {
		const controller = new AbortController();
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("partial output\n"));
			controller.abort();
			throw new Error("aborted");
		});
		const { write } = profile({ exec });
		await expect(
			write.execute(
				"write",
				{ path: "sample.txt", content: "applied\n", then_run: "check" },
				controller.signal,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/Wrote 8 chars[\s\S]*then_run: \$ check[\s\S]*Command aborted/u);
		expect(exec).toHaveBeenCalledTimes(1);
		expect(await readFile(join(directory, "sample.txt"), "utf8")).toBe("applied\n");
	});

	it("skips empty checks, but executes a check after a no-op edit", async () => {
		const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
		const { run, write } = profile({ exec });
		const runSpy = vi.spyOn(run, "execute");
		await write.execute(
			"first",
			{ path: "sample.txt", content: "same\n", then_run: "  " },
			undefined,
			undefined,
			undefined as never,
		);
		await write.execute(
			"noop",
			{ path: "sample.txt", content: "same\n", then_run: "check" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(exec).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledTimes(1);
	});
});
