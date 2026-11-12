import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/stepfun-ai/Step-Code/issues/141

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	pendingInputs: [] as Promise<unknown>[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	detachInput: undefined as (() => void) | undefined,
	onReady: undefined as (() => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		const detach = () => {
			rpcIo.lineHandler = undefined;
			rpcIo.detachInput = undefined;
		};
		rpcIo.detachInput = detach;
		rpcIo.onReady?.();
		return detach;
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sendLine(line: string): void {
	const result = rpcIo.lineHandler?.(line) as unknown;
	if (result && typeof (result as PromiseLike<unknown>).then === "function") {
		rpcIo.pendingInputs.push(Promise.resolve(result));
	}
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC null payload rejection (#141)", () => {
	let listenerSnapshot: ListenerSnapshot;
	let harness: Harness | undefined;
	let rpcRun: Promise<void> | undefined;
	let rpcReady: Promise<void>;
	let rpcStartupGate: Promise<void>;
	let releaseRpcStartup: (() => void) | undefined;
	let rejectRpcReady: ((reason?: unknown) => void) | undefined;
	let restoreBindExtensions: (() => void) | undefined;

	beforeEach(() => {
		listenerSnapshot = takeListenerSnapshot();
		rpcReady = new Promise<void>((resolve, reject) => {
			rpcIo.onReady = resolve;
			rejectRpcReady = reject;
		});
		rpcStartupGate = new Promise<void>((resolve) => {
			releaseRpcStartup = resolve;
		});
	});

	afterEach(async () => {
		try {
			// The test owns the only asynchronous startup barrier, so teardown can
			// always release it and wait until listener registration has finished.
			releaseRpcStartup?.();
			if (rpcRun) await rpcReady.catch(() => {});
			await Promise.allSettled(rpcIo.pendingInputs);
		} finally {
			rpcIo.detachInput?.();
			restoreBindExtensions?.();
			try {
				harness?.cleanup();
			} finally {
				restoreListeners(listenerSnapshot);
				harness = undefined;
				rpcRun = undefined;
				releaseRpcStartup = undefined;
				rejectRpcReady = undefined;
				restoreBindExtensions = undefined;
				rpcIo.onReady = undefined;
				rpcIo.pendingInputs = [];
				rpcIo.outputLines = [];
			}
		}
	});

	async function startRpc(): Promise<void> {
		harness = await createHarness();
		const bindExtensions = vi.spyOn(harness.session, "bindExtensions").mockImplementation(async () => rpcStartupGate);
		restoreBindExtensions = () => bindExtensions.mockRestore();
		rpcRun = runRpcMode(createRuntimeHost(harness));
		void rpcRun.catch((error) => rejectRpcReady?.(error));
		releaseRpcStartup?.();
		await rpcReady;
	}

	test.each([null, "hello", 123, true, [], ["nested"]])(
		"answers %j input with a parse error and keeps serving commands",
		async (payload) => {
			await startRpc();

			// `null` is valid JSON. Before the fix it was cast to RpcCommand, the
			// resulting TypeError escaped handleInputLine as an unhandled rejection
			// and killed the whole RPC agent. Primitives and arrays pin the object guard.
			sendLine(JSON.stringify(payload) as string);
			expect(rpcIo.pendingInputs).toHaveLength(1);

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					type: "response",
					command: "parse",
					success: false,
					error: "Failed to parse command: expected a JSON object",
				});
			});

			sendLine(JSON.stringify({ id: "after-payload", type: "foobar" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "after-payload",
					type: "response",
					command: "foobar",
					success: false,
					error: "Unknown command: foobar",
				});
			});
		},
	);

	test("handles null and a following command in one input chunk", async () => {
		await startRpc();

		// Exercise the production chunk splitter: both lines arrive in one data
		// event, so the second line is forwarded before the first async handler settles.
		const { attachJsonlLineReader } = await vi.importActual<typeof import("../../../src/modes/rpc/jsonl.ts")>(
			"../../../src/modes/rpc/jsonl.js",
		);
		const input = new PassThrough();
		const detach = attachJsonlLineReader(input, sendLine);
		try {
			input.end(`null\n${JSON.stringify({ id: "same-chunk", type: "foobar" })}\n`);

			await vi.waitFor(() => {
				const output = parseOutputLines();
				expect(output).toContainEqual({
					type: "response",
					command: "parse",
					success: false,
					error: "Failed to parse command: expected a JSON object",
				});
				expect(output).toContainEqual({
					id: "same-chunk",
					type: "response",
					command: "foobar",
					success: false,
					error: "Unknown command: foobar",
				});
			});
			expect(rpcIo.pendingInputs).toHaveLength(2);
		} finally {
			detach();
			input.destroy();
		}
	});
});
