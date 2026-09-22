import { expect, test } from "vitest";
import { isIsolatedVmAvailable, runInIsolatedVm, type WorkflowVmHost } from "../src/features/workflow/vm.ts";

const nativeVmTest = test.skipIf(!isIsolatedVmAvailable());

function host(overrides: Partial<WorkflowVmHost> = {}): WorkflowVmHost {
	return {
		agent: async (prompt, options) => ({ prompt, options }),
		phase: () => {},
		log: () => {},
		iterate: async (options) => options,
		nestedWorkflow: async (name, args) => ({ name, args }),
		budgetSpent: () => 2,
		budgetRemaining: () => 8,
		budgetTotal: () => 10,
		...overrides,
	};
}

nativeVmTest("workflow VM exposes JSON args, metadata, and host primitives", async () => {
	const phases: string[] = [];
	const result = await runInIsolatedVm(
		`const meta = { name: "sample", description: "test", roleSchemas: { worker: { type: "string" } } };
			 phase("inspect");
			 const answer = await agent("hello", { label: "worker" });
			 return { args, answer, metaName: meta.name, budget: [budget.total, budget.spent(), budget.remaining()] };`,
		{ input: 42 },
		host({ phase: (title) => phases.push(title) }),
	);

	expect(result).toEqual({
		value: {
			args: { input: 42 },
			answer: { prompt: "hello", options: { label: "worker" } },
			metaName: "sample",
			budget: [10, 2, 8],
		},
		meta: { name: "sample", description: "test", roleSchemas: { worker: { type: "string" } } },
	});
	expect(phases).toEqual(["inspect"]);
});

nativeVmTest("parallel starts every task before its barrier and pipeline preserves stage order", async () => {
	let active = 0;
	let peak = 0;
	const result = await runInIsolatedVm(
		`const parallelValues = await parallel([
		  () => agent("a"),
		  () => agent("b"),
		  () => agent("c"),
		]);
		const pipelineValues = await pipeline([1, 2], async (value) => value + 1, async (value) => value * 3);
		return { parallelValues, pipelineValues };`,
		null,
		host({
			agent: async (prompt) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return prompt;
			},
		}),
	);

	expect(result.value).toEqual({ parallelValues: ["a", "b", "c"], pipelineValues: [6, 9] });
	expect(peak).toBe(3);
});

nativeVmTest("pipeline runs item chains concurrently and passes (prev, item, index) to stages", async () => {
	let active = 0;
	let peak = 0;
	const result = await runInIsolatedVm(
		`return pipeline(
		   ["a", "b", "c"],
		   async (value, item, index) => (await agent(value)) + ":" + item + ":" + index,
		   async (value, item, index) => value + "/" + index,
		 );`,
		null,
		host({
			agent: async (prompt) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return prompt;
			},
		}),
	);

	expect(result.value).toEqual(["a:a:0/0", "b:b:1/1", "c:c:2/2"]);
	expect(peak).toBe(3);
});

nativeVmTest("a throwing stage or task resolves to null instead of rejecting the wave", async () => {
	const result = await runInIsolatedVm(
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
		host({ agent: async (prompt) => prompt }),
	);

	expect(result.value).toEqual({ piped: [11, null, 31], waved: ["ok", null, "also-ok"] });
});

nativeVmTest("pipeline and parallel reject batches above the 4096-entry cap", async () => {
	await expect(runInIsolatedVm("return parallel(new Array(4097).fill(() => null));", null, host())).rejects.toThrow(
		/4096/u,
	);
	await expect(
		runInIsolatedVm("return pipeline(new Array(4097).fill(1), async (value) => value);", null, host()),
	).rejects.toThrow(/4096/u);
});

nativeVmTest.each([
	["Date.now", "return Date.now();"],
	["Date constructor", "return new Date();"],
	["Math.random", "return Math.random();"],
	["Intl.DateTimeFormat", "return new Intl.DateTimeFormat().format();"],
])("workflow VM rejects non-deterministic %s access", async (_label, script) => {
	await expect(runInIsolatedVm(script, null, host())).rejects.toThrow(/wall-clock|construct Date|random/u);
});

nativeVmTest("workflow VM enforces its synchronous execution timeout", async () => {
	await expect(runInIsolatedVm("while (true) {}", null, host(), { timeoutMs: 100 })).rejects.toThrow(/timed out/u);
});

nativeVmTest("workflow VM enforces an async execution timeout", async () => {
	await expect(
		runInIsolatedVm("return await new Promise(() => {});", null, host(), { timeoutMs: 100 }),
	).rejects.toThrow(/timed out/u);
});

nativeVmTest("workflow VM does not expose raw host references", async () => {
	const result = await runInIsolatedVm(
		"return [typeof __workflow_agent, typeof __workflow_iterate, typeof process, typeof require, typeof fetch];",
		null,
		host(),
	);
	expect(result.value).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
});

nativeVmTest("workflow VM has no dynamic module loader", async () => {
	await expect(runInIsolatedVm('return import("node:fs")', null, host())).rejects.toThrow("Not supported");
});
