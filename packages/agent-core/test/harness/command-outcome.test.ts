import { describe, expect, it } from "vitest";
import {
	commandExecutionNotice,
	formatCommandExecutionOutcome,
	normalizeCommandExecution,
	readCommandExecutionOutcome,
} from "../../src/harness/command-outcome.ts";

describe("command execution outcomes", () => {
	it("projects the redundant facts from the status", () => {
		const canceled = normalizeCommandExecution({ exitCode: null, timedOut: true, aborted: true });
		expect(canceled).toMatchObject({ status: "canceled", timedOut: false, aborted: true });

		const timedOut = normalizeCommandExecution({ exitCode: 0, timedOut: true });
		expect(timedOut).toMatchObject({ status: "timed_out", exitCode: 0, timedOut: true, aborted: false });

		const signaled = normalizeCommandExecution({ exitCode: null, signal: "SIGKILL" });
		expect(signaled).toMatchObject({ status: "signaled", signal: "SIGKILL" });

		const unknown = normalizeCommandExecution({ exitCode: null });
		expect(unknown).toMatchObject({ status: "unknown", exitCode: null });
	});

	it("treats a missing or non-integer exit code as unknown instead of fabricating one", () => {
		for (const exitCode of [undefined, Number.NaN, 1.5]) {
			const observed = normalizeCommandExecution({ exitCode } as never);
			expect(observed.status).toBe("unknown");
			expect(observed.exitCode).toBeNull();
			expect(formatCommandExecutionOutcome(observed)).not.toContain("undefined");
			expect(formatCommandExecutionOutcome(observed)).not.toContain("NaN");
		}
	});

	it("keeps a deadline that coexists with exit code zero", () => {
		const observed = normalizeCommandExecution({ exitCode: 0, timedOut: true }, { timeoutSeconds: 1 });
		expect(commandExecutionNotice(observed)).toBe("Command timed out after 1 seconds");
	});

	it("says nothing for a clean exit and something for every other outcome", () => {
		const cases = [
			{ outcome: { exitCode: 0 }, notice: undefined },
			{ outcome: { exitCode: 1 }, notice: "Command exited with code 1" },
			{ outcome: { exitCode: null }, notice: expect.stringContaining("check its effects") },
			{ outcome: { exitCode: null, signal: "SIGTERM" }, notice: "Command terminated by signal SIGTERM" },
			{ outcome: { exitCode: null, aborted: true }, notice: "Command aborted" },
			{ outcome: { exitCode: 0, timedOut: true }, notice: expect.stringContaining("timed out") },
		];
		for (const { outcome, notice } of cases) {
			const observed = normalizeCommandExecution(outcome as never);
			const actual = commandExecutionNotice(observed);
			if (notice === undefined) expect(actual).toBeUndefined();
			else expect(actual).toEqual(notice);
		}
	});

	describe("restoring persisted facts", () => {
		it("round-trips a normalized observation", () => {
			for (const result of [
				{ exitCode: 0 },
				{ exitCode: 7 },
				{ exitCode: null },
				{ exitCode: null, timedOut: true },
				{ exitCode: null, signal: "SIGKILL" },
				{ exitCode: null, aborted: true },
			]) {
				const normalized = normalizeCommandExecution(result as never, { timeoutSeconds: 5 });
				expect(readCommandExecutionOutcome(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
			}
		});

		it("derives the redundant facts from the persisted status", () => {
			expect(
				readCommandExecutionOutcome({ status: "canceled", exitCode: null, timedOut: true, aborted: false }),
			).toMatchObject({ status: "canceled", aborted: true, timedOut: false });
			expect(
				readCommandExecutionOutcome({ status: "timed_out", exitCode: 0, timedOut: false, aborted: false }),
			).toMatchObject({ status: "timed_out", timedOut: true, aborted: false });
		});

		it("drops records that would produce a false conclusion", () => {
			expect(readCommandExecutionOutcome(null)).toBeUndefined();
			expect(readCommandExecutionOutcome("exited")).toBeUndefined();
			expect(readCommandExecutionOutcome({})).toBeUndefined();
			expect(readCommandExecutionOutcome({ status: "finished" })).toBeUndefined();
			// An `exited` record without a code cannot be described.
			expect(readCommandExecutionOutcome({ status: "exited", exitCode: null })).toBeUndefined();
			expect(readCommandExecutionOutcome({ status: "exited" })).toBeUndefined();
			// A signal record without a signal cannot be described.
			expect(readCommandExecutionOutcome({ status: "signaled", exitCode: null })).toBeUndefined();
			expect(readCommandExecutionOutcome({ status: "exited", exitCode: 1.5 })).toBeUndefined();
		});

		it("normalizes a missing exit code to null so the observation survives a JSONL round trip", () => {
			const observed = readCommandExecutionOutcome({ status: "unknown" });
			expect(observed?.exitCode).toBeNull();
			expect(observed?.status).toBe("unknown");
		});
	});
});
