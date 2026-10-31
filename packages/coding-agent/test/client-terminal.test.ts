import { afterEach, expect, test, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import {
	type ClientTerminalHost,
	getClientTerminalHost,
	setClientTerminalHost,
	withClientTerminalOperations,
} from "../src/core/tools/client-terminal.ts";
import type { ShellConfig } from "../src/utils/shell.ts";

afterEach(() => {
	setClientTerminalHost(undefined);
	vi.restoreAllMocks();
});

const argvShell: ShellConfig = { shell: "/bin/sh", args: ["-c"] };

function recordingFallback(): BashOperations & { calls: Array<{ command: string; cwd: string }> } {
	const calls: Array<{ command: string; cwd: string }> = [];
	return {
		calls,
		exec: async (command, cwd) => {
			calls.push({ command, cwd });
			return { exitCode: 0 };
		},
	};
}

function hostThat(overrides: Partial<ClientTerminalHost> = {}): ClientTerminalHost & {
	created: Array<Record<string, unknown>>;
	released: string[];
} {
	const created: Array<Record<string, unknown>> = [];
	const released: string[] = [];
	return {
		created,
		released,
		create: async (params) => {
			created.push(params as unknown as Record<string, unknown>);
			return { terminalId: "term-1" };
		},
		output: async () => ({ output: "", truncated: false }),
		waitForExit: async () => ({ exitCode: 0 }),
		kill: async () => {},
		release: async (terminalId) => {
			released.push(terminalId);
		},
		...overrides,
	};
}

test("a command runs through the client terminal with the resolved shell", async () => {
	const host = hostThat({
		output: async function output() {
			// Exits on the first poll so the test does not spin.
			return { output: "done\n", truncated: false, exitStatus: { exitCode: 0 } };
		},
	});
	setClientTerminalHost(host);
	const fallback = recordingFallback();
	const operations = withClientTerminalOperations(fallback, () => argvShell);

	const result = await operations.exec("echo hi", "/repo", { onData: () => {} });

	expect(result.exitCode).toBe(0);
	expect(host.created).toHaveLength(1);
	// The shell string rides as the final argument, so the client runs the same
	// command line the local path would have.
	expect(host.created[0]).toMatchObject({ command: "/bin/sh", args: ["-c", "echo hi"], cwd: "/repo" });
	expect(host.released).toEqual(["term-1"]);
	expect(fallback.calls).toHaveLength(0);
});

test("output is streamed as it appears and only the suffix is emitted", async () => {
	const chunks: string[] = [];
	let polls = 0;
	const host = hostThat({
		output: async () => {
			polls += 1;
			if (polls === 1) return { output: "first\n", truncated: false };
			if (polls === 2) return { output: "first\nsecond\n", truncated: false };
			return { output: "first\nsecond\n", truncated: false, exitStatus: { exitCode: 0 } };
		},
	});
	setClientTerminalHost(host);
	const operations = withClientTerminalOperations(recordingFallback(), () => argvShell);

	await operations.exec("run", "/repo", { onData: (data) => chunks.push(data.toString("utf-8")) });

	expect(chunks).toEqual(["first\n", "second\n"]);
});

test("a truncated client buffer is not re-emitted", async () => {
	const chunks: string[] = [];
	let polls = 0;
	const host = hostThat({
		output: async () => {
			polls += 1;
			if (polls === 1) return { output: "aaaa", truncated: false };
			// The client dropped the head to stay inside its byte limit.
			if (polls === 2) return { output: "bbbb", truncated: true };
			return { output: "bbbb", truncated: true, exitStatus: { exitCode: 0 } };
		},
	});
	setClientTerminalHost(host);
	const operations = withClientTerminalOperations(recordingFallback(), () => argvShell);

	await operations.exec("run", "/repo", { onData: (data) => chunks.push(data.toString("utf-8")) });

	// Re-emitting the whole buffer would duplicate output the accumulator holds.
	expect(chunks).toEqual(["aaaa"]);
});

test("a stdin-transport shell falls back before the command starts", async () => {
	const host = hostThat({
		output: async () => ({ output: "", truncated: false, exitStatus: { exitCode: 0 } }),
	});
	setClientTerminalHost(host);
	const fallback = recordingFallback();
	// ACP has no channel for a command delivered over stdin, so this shell cannot
	// be expressed and the local path keeps it.
	const operations = withClientTerminalOperations(fallback, () => ({
		shell: "/bin/sh",
		args: ["-s"],
		commandTransport: "stdin",
	}));

	const result = await operations.exec("echo hi", "/repo", { onData: () => {} });

	expect(result.exitCode).toBe(0);
	expect(host.created).toHaveLength(0);
	expect(fallback.calls).toEqual([{ command: "echo hi", cwd: "/repo" }]);
});

test("an explicitly missing terminal method falls back to the local shell", async () => {
	const host = hostThat({
		create: async () => {
			throw Object.assign(new Error("method not found"), { code: -32601 });
		},
	});
	setClientTerminalHost(host);
	const fallback = recordingFallback();
	const operations = withClientTerminalOperations(fallback, () => argvShell);

	const result = await operations.exec("echo hi", "/repo", { onData: () => {} });

	expect(result.exitCode).toBe(0);
	// Safe because the command never started: there is no second side effect.
	expect(fallback.calls).toEqual([{ command: "echo hi", cwd: "/repo" }]);
	expect(host.released).toEqual([]);
});

test("a client refusal does not rerun the command locally", async () => {
	const host = hostThat({
		create: async () => {
			throw Object.assign(new Error("terminal creation refused"), { code: -32003 });
		},
	});
	setClientTerminalHost(host);
	const fallback = recordingFallback();
	const operations = withClientTerminalOperations(fallback, () => argvShell);

	await expect(operations.exec("git push", "/repo", { onData: () => {} })).rejects.toThrow(
		"terminal creation refused",
	);
	expect(fallback.calls).toHaveLength(0);
	expect(host.released).toEqual([]);
});

test("a failure after create is never retried locally", async () => {
	const host = hostThat({
		output: async () => {
			throw new Error("transport died mid-run");
		},
	});
	setClientTerminalHost(host);
	const fallback = recordingFallback();
	const operations = withClientTerminalOperations(fallback, () => argvShell);

	await expect(operations.exec("rm -rf build", "/repo", { onData: () => {} })).rejects.toThrow("transport died");
	// The command already ran in the client's terminal. Re-running it locally
	// would be a second side effect, not a fallback.
	expect(fallback.calls).toHaveLength(0);
	expect(host.released).toEqual(["term-1"]);
});

test("an abort kills the terminal and surfaces as aborted", async () => {
	const killed: string[] = [];
	const controller = new AbortController();
	const host = hostThat({
		output: async () => ({ output: "", truncated: false }),
		kill: async (terminalId) => {
			killed.push(terminalId);
			controller.abort();
		},
	});
	setClientTerminalHost(host);
	const operations = withClientTerminalOperations(recordingFallback(), () => argvShell);

	// Abort from inside the poll loop, so the kill path is the one under test.
	setTimeout(() => controller.abort(), 0);
	await expect(operations.exec("sleep 100", "/repo", { onData: () => {}, signal: controller.signal })).rejects.toThrow(
		"aborted",
	);
	expect(killed).toEqual(["term-1"]);
	expect(host.released).toEqual(["term-1"]);
});

test("a timeout kills the terminal and reports the timeout", async () => {
	const killed: string[] = [];
	const host = hostThat({
		output: async () => ({ output: "", truncated: false }),
		kill: async (terminalId) => {
			killed.push(terminalId);
		},
	});
	setClientTerminalHost(host);
	const operations = withClientTerminalOperations(recordingFallback(), () => argvShell);

	await expect(operations.exec("sleep 100", "/repo", { onData: () => {}, timeout: 0 })).rejects.toThrow("timeout:0");
	expect(killed).toEqual(["term-1"]);
});

test("no host means purely local execution", async () => {
	expect(getClientTerminalHost()).toBeUndefined();
	const fallback = recordingFallback();
	const operations = withClientTerminalOperations(fallback, () => argvShell);

	const result = await operations.exec("echo hi", "/repo", { onData: () => {} });

	expect(result.exitCode).toBe(0);
	expect(fallback.calls).toEqual([{ command: "echo hi", cwd: "/repo" }]);
});
