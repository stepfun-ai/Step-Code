import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the host's shutdown wiring without starting its listener or loading
// user configuration. The session store's persistence is covered separately.
const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const start = source.indexOf("const shutdown = async (): Promise<void> => {");
const end = source.indexOf('process.once("SIGINT"', start);
assert.ok(start >= 0 && end > start, "host shutdown entry point exists");
const shutdownSource = source.slice(start, end).replace("(): Promise<void>", "()");

for (const importFails of [false, true]) {
	test(`shutdown stops turns while imports drain (import failure: ${importFails})`, async () => {
		let finishImport!: () => void;
		const importDrain = new Promise<void>((resolve) => {
			finishImport = resolve;
		});
		let turnStopped = false;
		let indexClosed = false;
		let exitCode: number | undefined;
		const failures: unknown[] = [];
		const noop = async () => {};
		const shutdown: () => Promise<void> = runInNewContext(`${shutdownSource}\nshutdown;`, {
			SHUTDOWN_TURN_GRACE_MS: 3_000,
			server: { close: noop, closeAllConnections: noop },
			embeddedBrowser: { close: noop },
			sitePreview: { close: noop },
			terminals: { stopAll: noop },
			voice: { stopAll: noop },
			migrations: { close: noop },
			sessionImports: {
				close: async () => {
					await importDrain;
					assert.equal(indexClosed, false, "imports finish before their index closes");
					if (importFails) throw new Error("import drain failed");
				},
			},
			store: {
				interruptAndClose: async (options: { graceMs: number; reason: string }) => {
					assert.equal(options.graceMs, 3_000);
					assert.equal(options.reason, "host shutdown");
					turnStopped = true;
				},
			},
			mcpWarmup: { release: noop },
			sessionSearch: {
				close: async () => {
					assert.equal(turnStopped, true);
					indexClosed = true;
				},
			},
			closeStepMcpPool: noop,
			console: { error: (...args: unknown[]) => failures.push(args) },
			process: { exit: (code: number) => { exitCode = code; } },
		});
		const pending = shutdown();
		try {
			assert.equal(turnStopped, true, "a slow import must not postpone interrupting a live turn");
			await Promise.resolve();
			assert.equal(indexClosed, false, "the index stays open while the import is pending");
			assert.equal(exitCode, undefined);
		} finally {
			finishImport();
			await pending;
		}
		assert.equal(indexClosed, true);
		assert.equal(exitCode, importFails ? 1 : 0);
		assert.equal(failures.length, importFails ? 1 : 0);
	});
}
