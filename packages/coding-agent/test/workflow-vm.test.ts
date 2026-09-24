/**
 * Workflow VM contract.
 *
 * One executor now serves every runtime — QuickJS compiled to WebAssembly (see
 * `vm.ts`) — so this suite is the behavioural spec for the sandbox itself: what
 * the guest can reach, what it cannot, and how concurrency, limits, and failures
 * are supposed to look. It replaces the split between an isolated-vm suite and a
 * cross-executor conformance suite that existed while two engines coexisted.
 */

import { expect, test } from "vitest";
import { runInQuickJs, type WorkflowVmHost } from "../src/features/workflow/vm.ts";

interface HostCalls {
	agents: Array<{ prompt: string; options: Record<string, unknown> }>;
	phases: string[];
	logs: string[];
	iterates: Record<string, unknown>[];
	nested: Array<{ name: string; args: unknown }>;
}

/**
 * Host double shaped like the real one. `agent` echoes what it received so a test
 * can assert on marshalling, and resolves asynchronously so the executor's
 * promise bridging is exercised rather than short-circuited.
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

/** Counts how many host calls are in flight at once, for the concurrency assertions. */
function concurrencyProbe(delayMs = 10): { host: WorkflowVmHost; peak: () => number } {
	let active = 0;
	let peak = 0;
	const { host } = createHost({
		agent: async (prompt) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			active -= 1;
			return prompt;
		},
	});
	return { host, peak: () => peak };
}

test("exposes JSON args, metadata, and every host primitive", async () => {
	const { host, calls } = createHost();
	const result = await runInQuickJs(
		`const meta = { name: "sample", description: "test", roleSchemas: { worker: { type: "string" } } };
		 phase("inspect");
		 log("hello");
		 const answer = await agent("hi", { label: "worker" });
		 return { args, answer, metaName: meta.name, budget: [budget.total, budget.spent(), budget.remaining()] };`,
		{ input: 42 },
		host,
	);

	expect(result.value).toEqual({
		args: { input: 42 },
		answer: { echo: "hi", label: "worker" },
		metaName: "sample",
		budget: [10_000, 1_234, 8_766],
	});
	expect(result.meta).toEqual({
		name: "sample",
		description: "test",
		roleSchemas: { worker: { type: "string" } },
	});
	expect(calls.phases).toEqual(["inspect"]);
	expect(calls.logs).toEqual(["hello"]);
	expect(calls.agents[0]?.options).toEqual({ label: "worker" });
});

test("reports an unlimited budget as null", async () => {
	const { host } = createHost({ budgetTotal: () => null });
	const result = await runInQuickJs(`return { total: budget.total };`, undefined, host);
	expect(result.value).toEqual({ total: null });
});

test("parallel() starts every task before its barrier", async () => {
	const probe = concurrencyProbe();
	const result = await runInQuickJs(
		`return parallel([() => agent("a"), () => agent("b"), () => agent("c")]);`,
		null,
		probe.host,
	);
	expect(result.value).toEqual(["a", "b", "c"]);
	expect(probe.peak()).toBe(3);
});

test("pipeline() runs item chains concurrently and passes (prev, item, index) to stages", async () => {
	const probe = concurrencyProbe();
	const result = await runInQuickJs(
		`return pipeline(
		   ["a", "b", "c"],
		   async (value, item, index) => (await agent(value)) + ":" + item + ":" + index,
		   async (value, item, index) => value + "/" + index,
		 );`,
		null,
		probe.host,
	);
	expect(result.value).toEqual(["a:a:0/0", "b:b:1/1", "c:c:2/2"]);
	expect(probe.peak()).toBe(3);
});

test("a throwing stage or task resolves to null instead of rejecting the wave", async () => {
	const { host } = createHost({ agent: async (prompt) => prompt });
	const result = await runInQuickJs(
		`const piped = await pipeline(
		   [1, 2, 3],
		   async (value) => { if (value === 2) throw new Error("boom"); return value * 10; },
		   async (value) => value + 1,
		 );
		 const waved = await parallel([
		   () => agent("ok"),
		   async () => { throw new Error("boom"); },
		   () => agent("also-ok"),
		 ]);
		 return { piped, waved };`,
		null,
		host,
	);
	expect(result.value).toEqual({ piped: [11, null, 31], waved: ["ok", null, "also-ok"] });
});

test("parallel() and pipeline() reject batches above the 4096-entry cap", async () => {
	const { host } = createHost();
	await expect(runInQuickJs("return parallel(new Array(4097).fill(() => null));", null, host)).rejects.toThrow(
		/4096/u,
	);
	await expect(
		runInQuickJs("return pipeline(new Array(4097).fill(1), async (value) => value);", null, host),
	).rejects.toThrow(/4096/u);
});

test("routes iterate() and nested workflow() to the host", async () => {
	const { host, calls } = createHost();
	const result = await runInQuickJs(
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

test.each([
	["Date.now", "return Date.now();"],
	["Date constructor", "return new Date();"],
	["Math.random", "return Math.random();"],
])("rejects non-deterministic %s access", async (_label, script) => {
	const { host } = createHost();
	await expect(runInQuickJs(script, null, host)).rejects.toThrow(/wall-clock|construct Date|random/u);
});

test("cannot read the clock through Intl", async () => {
	const { host } = createHost();
	// QuickJS ships no Intl at all, so the prelude's DateTimeFormat guard never
	// even applies here — the reference fails first. Assert the outcome (no clock
	// through Intl) rather than the mechanism, so this stays true either way.
	await expect(runInQuickJs("return new Intl.DateTimeFormat().format();", null, host)).rejects.toThrow(
		/wall-clock|not defined/u,
	);
});

test("uses the replay wording for clock access when replaying", async () => {
	const { host } = createHost();
	await expect(runInQuickJs(`return Date.now();`, undefined, host, { replay: true })).rejects.toThrow(
		/disabled during workflow replay/,
	);
});

test("exposes neither the raw host bridges nor the host runtime", async () => {
	const { host } = createHost();
	const result = await runInQuickJs(
		`return [
		   typeof __workflow_agent,
		   typeof __workflow_iterate,
		   typeof __workflow_args_json,
		   typeof process,
		   typeof require,
		   typeof fetch,
		 ];`,
		null,
		host,
	);
	expect(result.value).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
});

test("has no dynamic module loader", async () => {
	const { host } = createHost();
	await expect(runInQuickJs('return import("node:fs")', null, host)).rejects.toThrow();
});

test("propagates a script throw to the caller", async () => {
	const { host } = createHost();
	await expect(runInQuickJs(`throw new Error("script exploded");`, undefined, host)).rejects.toThrow(
		"script exploded",
	);
});

test("propagates a rejected host call the script does not catch", async () => {
	const { host } = createHost({
		agent: async () => {
			throw new Error("budget exceeded");
		},
	});
	await expect(runInQuickJs(`return agent("x");`, undefined, host)).rejects.toThrow("budget exceeded");
});

test("enforces the script timeout on a runaway loop", async () => {
	const { host } = createHost();
	await expect(runInQuickJs(`while (true) {} return 1;`, undefined, host, { timeoutMs: 200 })).rejects.toThrow(
		/timed out/,
	);
});

test("enforces the script timeout on a promise that never settles", async () => {
	const { host } = createHost();
	await expect(runInQuickJs("return await new Promise(() => {});", null, host, { timeoutMs: 200 })).rejects.toThrow(
		/timed out/u,
	);
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
	const result = await runInQuickJs(
		`const a = await agent("1"); const b = await agent("2"); const c = await agent("3");
		 return [a, b, c].join("|");`,
		undefined,
		host,
		{ timeoutMs: 200 },
	);
	expect(result.value).toBe("1|2|3");
});

test("stops a guest that burns CPU while a host call is in flight", async () => {
	const { host } = createHost({
		agent: async (prompt) => {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			return prompt;
		},
	});
	// Nothing outside the VM can break this loop: it runs inside the WebAssembly
	// call and blocks the host event loop, so the host-side timer never gets to
	// fire. Only the in-VM interrupt handler can, which is why that handler must
	// not exempt pending host calls.
	await expect(
		runInQuickJs(`const p = agent("slow"); let i = 0; while (true) { i = (i + 1) % 1000000; }`, null, host, {
			timeoutMs: 300,
		}),
	).rejects.toThrow(/timed out/u);
}, 10_000);

test("keeps a fan-out branch whose host call outlasts the timeout budget", async () => {
	const { host } = createHost({
		agent: async (prompt) => {
			await new Promise((resolve) => setTimeout(resolve, prompt === "first" ? 800 : 1_400));
			return prompt;
		},
	});
	// The first branch waits 800ms against a 300ms budget, then computes for well
	// under it. The interrupt deadline has to be refreshed by that settlement —
	// refreshing only once every call has settled would resume this continuation
	// against a stale deadline and interrupt it, and parallel() would report the
	// branch as a bare `null` rather than an error.
	const result = await runInQuickJs(
		`return parallel([
		   async () => { const v = await agent("first"); let s = 0; for (let i = 0; i < 1000000; i++) s += i % 7; return v + ":" + s; },
		   () => agent("second"),
		 ]);`,
		null,
		host,
		{ timeoutMs: 300 },
	);
	expect(result.value).toEqual(["first:2999997", "second"]);
}, 10_000);

test.each([
	["a single call", `agent("a"); return "early";`],
	["a parallel wave", `parallel([() => agent("a"), () => agent("b")]); return "early";`],
])("discards %s the script never awaited", async (_label, script) => {
	const { host } = createHost({
		agent: async (prompt) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return prompt;
		},
	});
	// The run returns while those calls are still in flight. Their deferred
	// promises have to be released before the context goes away, or QuickJS aborts
	// the shared WebAssembly instance; the settlements that land afterwards must
	// leave the disposed context alone rather than raise an unhandled rejection.
	const result = await runInQuickJs(script, null, host, { timeoutMs: 5_000 });
	expect(result.value).toBe("early");
	// Give the abandoned calls time to settle: a use-after-free would surface here.
	await new Promise((resolve) => setTimeout(resolve, 150));
});

test("keeps working after a run that abandoned host calls", async () => {
	const { host } = createHost();
	await runInQuickJs(`agent("a"); return "early";`, null, host, { timeoutMs: 5_000 });
	await new Promise((resolve) => setTimeout(resolve, 50));
	// The WebAssembly module is cached process-wide, so a botched teardown would
	// poison every later run rather than just the one that caused it.
	const result = await runInQuickJs(`return (await agent("later")).echo;`, null, host);
	expect(result.value).toBe("later");
});

test("rejects a script over the size cap", async () => {
	const { host } = createHost();
	const oversized = `// ${"x".repeat(128 * 1024)}\nreturn 1;`;
	await expect(runInQuickJs(oversized, undefined, host, { timeoutMs: 1_000 })).rejects.toThrow(/exceeds/);
});

test("enforces the memory limit", async () => {
	const { host } = createHost();
	await expect(
		runInQuickJs(
			`const a = []; for (let i = 0; i < 1e7; i++) a.push({ i, pad: "padpadpad" + i }); return a.length;`,
			undefined,
			host,
			{ memoryLimitMb: 8, timeoutMs: 10_000 },
		),
	).rejects.toThrow();
});
