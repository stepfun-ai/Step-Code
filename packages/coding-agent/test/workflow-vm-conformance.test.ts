/**
 * Cross-executor conformance.
 *
 * The released executable runs workflows through QuickJS (`runInQuickJs`) while a
 * source/Node run uses isolated-vm (`runInIsolatedVm`). Two engines behind one
 * contract is the standing risk of this arrangement, so every case here runs
 * against BOTH executors and asserts the same observable outcome. A divergence
 * shows up as a failure in exactly one column, which is the only reliable way to
 * catch drift — the QuickJS path is the one users get, and the isolated-vm path
 * is the one developers see.
 *
 * isolated-vm is an optional native addon, so its column is skipped when the
 * module is absent rather than failing the suite.
 */

import { describe, expect, test } from "vitest";
import { isIsolatedVmAvailable, runInIsolatedVm, type WorkflowVmHost } from "../src/features/workflow/vm.ts";
import { runInQuickJs } from "../src/features/workflow/vm-quickjs.ts";

type Executor = typeof runInIsolatedVm;

interface HostCalls {
	agents: Array<{ prompt: string; options: Record<string, unknown> }>;
	phases: string[];
	logs: string[];
	iterates: Record<string, unknown>[];
	nested: Array<{ name: string; args: unknown }>;
}

/**
 * Host double shaped like the real one: `agent` echoes what it received so the
 * test can assert on marshalling, and resolves asynchronously so the executor's
 * promise bridging is actually exercised rather than short-circuited.
 */
function createHost(overrides: Partial<WorkflowVmHost> = {}): { host: WorkflowVmHost; calls: HostCalls } {
	const calls: HostCalls = { agents: [], phases: [], logs: [], iterates: [], nested: [] };
	const host: WorkflowVmHost = {
		agent: async (prompt, options) => {
			calls.agents.push({ prompt, options });
			await new Promise((resolve) => setTimeout(resolve, 1));
			return { echo: prompt, label: options.label ?? null };
		},
		iterate: async (options) => {
			calls.iterates.push(options);
			return { iterated: true };
		},
		nestedWorkflow: async (name, args) => {
			calls.nested.push({ name, args });
			return { nested: name };
		},
		phase: (title) => calls.phases.push(title),
		log: (message) => calls.logs.push(message),
		budgetSpent: () => 1_234,
		budgetRemaining: () => 8_766,
		budgetTotal: () => 10_000,
		...overrides,
	};
	return { host, calls };
}

const executors: Array<[string, Executor]> = [
	["quickjs", runInQuickJs],
	...(isIsolatedVmAvailable() ? ([["isolated-vm", runInIsolatedVm]] as Array<[string, Executor]>) : []),
];

// Guard against the suite silently degrading to a single column.
test("both executors are under test on a V8 host", () => {
	expect(executors.map(([name]) => name)).toContain("quickjs");
	if (isIsolatedVmAvailable()) expect(executors).toHaveLength(2);
});

describe.each(executors)("workflow vm conformance (%s)", (_name, run) => {
	test("returns the script value and captures meta", async () => {
		const { host } = createHost();
		const result = await run(
			`export const meta = { name: "demo", description: "d", phases: [{ title: "One" }] };
			return { ok: true, n: 41 + 1 };`,
			undefined,
			host,
		);
		expect(result.value).toEqual({ ok: true, n: 42 });
		expect(result.meta.name).toBe("demo");
		expect(result.meta.phases).toEqual([{ title: "One" }]);
	});

	test("awaits async host calls and passes options through", async () => {
		const { host, calls } = createHost();
		const result = await run(
			`const a = await agent("first", { label: "L1" });
			const b = await agent("second");
			return [a, b];`,
			undefined,
			host,
		);
		expect(result.value).toEqual([
			{ echo: "first", label: "L1" },
			{ echo: "second", label: null },
		]);
		expect(calls.agents.map((call) => call.prompt)).toEqual(["first", "second"]);
		expect(calls.agents[0]?.options).toEqual({ label: "L1" });
	});

	test("parallel() is a barrier and swallows task failures as null", async () => {
		const { host } = createHost();
		const result = await run(
			`const out = await parallel([
				() => agent("a"),
				() => { throw new Error("boom"); },
				async () => { await agent("c"); return "kept"; },
			]);
			return out;`,
			undefined,
			host,
		);
		expect(result.value).toEqual([{ echo: "a", label: null }, null, "kept"]);
	});

	test("pipeline() threads stages per item and drops a throwing item to null", async () => {
		const { host } = createHost();
		const result = await run(
			`const out = await pipeline(
				["x", "boom", "y"],
				(item) => { if (item === "boom") throw new Error("stage1"); return item + "1"; },
				(prev, original, index) => prev + ":" + original + ":" + index,
			);
			return out;`,
			undefined,
			host,
		);
		expect(result.value).toEqual(["x1:x:0", null, "y1:y:2"]);
	});

	test("rejects oversized parallel()/pipeline() inputs", async () => {
		const { host } = createHost();
		await expect(run(`return parallel(new Array(4097).fill(() => 1));`, undefined, host)).rejects.toThrow(
			/at most 4096/,
		);
		await expect(run(`return pipeline(new Array(4097).fill("x"), (v) => v);`, undefined, host)).rejects.toThrow(
			/at most 4096/,
		);
	});

	test("exposes sync host calls and the budget surface", async () => {
		const { host, calls } = createHost();
		const result = await run(
			`phase("Scan");
			log("hello");
			return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() };`,
			undefined,
			host,
		);
		expect(result.value).toEqual({ total: 10_000, spent: 1_234, remaining: 8_766 });
		expect(calls.phases).toEqual(["Scan"]);
		expect(calls.logs).toEqual(["hello"]);
	});

	test("reports an unlimited budget as null", async () => {
		const { host } = createHost({ budgetTotal: () => null });
		const result = await run(`return { total: budget.total };`, undefined, host);
		expect(result.value).toEqual({ total: null });
	});

	test("passes args through as a JSON-safe copy", async () => {
		const { host } = createHost();
		const result = await run(`return { got: args, type: typeof args };`, { files: ["a.ts"], n: 2 }, host);
		expect(result.value).toEqual({ got: { files: ["a.ts"], n: 2 }, type: "object" });
	});

	test("blocks the clock, randomness, and the host surface", async () => {
		const { host } = createHost();
		const result = await run(
			`const probe = (fn) => { try { fn(); return "allowed"; } catch (error) { return "blocked"; } };
			return {
				dateNow: probe(() => Date.now()),
				dateNew: probe(() => new Date()),
				random: probe(() => Math.random()),
				process: typeof process,
				require: typeof require,
				fetch: typeof fetch,
			};`,
			undefined,
			host,
		);
		expect(result.value).toEqual({
			dateNow: "blocked",
			dateNew: "blocked",
			random: "blocked",
			process: "undefined",
			require: "undefined",
			fetch: "undefined",
		});
	});

	test("propagates a script throw to the caller", async () => {
		const { host } = createHost();
		await expect(run(`throw new Error("script exploded");`, undefined, host)).rejects.toThrow("script exploded");
	});

	test("propagates a rejected host call the script does not catch", async () => {
		const { host } = createHost({
			agent: async () => {
				throw new Error("budget exceeded");
			},
		});
		await expect(run(`return agent("x");`, undefined, host)).rejects.toThrow("budget exceeded");
	});

	test("enforces the script timeout on a runaway loop", async () => {
		const { host } = createHost();
		await expect(run(`while (true) {} return 1;`, undefined, host, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
	});

	test("does not count time inside a pending host call against the timeout", async () => {
		const { host } = createHost({
			agent: async (prompt) => {
				await new Promise((resolve) => setTimeout(resolve, 260));
				return prompt;
			},
		});
		// Three 260ms round trips against a 200ms budget: only stretches with no
		// pending host call may trip the watchdog.
		const result = await run(
			`const a = await agent("1"); const b = await agent("2"); const c = await agent("3");
			return [a, b, c].join("|");`,
			undefined,
			host,
			{ timeoutMs: 200 },
		);
		expect(result.value).toBe("1|2|3");
	});

	test("rejects a script over the size cap", async () => {
		const { host } = createHost();
		const oversized = `// ${"x".repeat(128 * 1024)}\nreturn 1;`;
		await expect(run(oversized, undefined, host, { timeoutMs: 1_000 })).rejects.toThrow(/exceeds/);
	});

	test("enforces the memory limit", async () => {
		const { host } = createHost();
		await expect(
			run(
				`const a = []; for (let i = 0; i < 1e7; i++) a.push({ i, pad: "padpadpad" + i }); return a.length;`,
				undefined,
				host,
				{
					memoryLimitMb: 8,
					timeoutMs: 10_000,
				},
			),
		).rejects.toThrow();
	});

	test("routes iterate() and nested workflow() to the host", async () => {
		const { host, calls } = createHost();
		const result = await run(
			`const it = await iterate({ spec: "s" });
			const nested = await workflow("child", { k: 1 });
			return { it, nested };`,
			undefined,
			host,
		);
		expect(result.value).toEqual({ it: { iterated: true }, nested: { nested: "child" } });
		expect(calls.iterates).toEqual([{ spec: "s" }]);
		expect(calls.nested).toEqual([{ name: "child", args: { k: 1 } }]);
	});

	test("uses the replay wording for clock access when replaying", async () => {
		const { host } = createHost();
		await expect(run(`return Date.now();`, undefined, host, { replay: true })).rejects.toThrow(
			/disabled during workflow replay/,
		);
	});
});
