import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { runStepSubagentProcess } from "../src/features/step-subagent.ts";
import { builtinStepAgents } from "../src/features/step-subagent-agents.ts";

const state = vi.hoisted(() => ({
	fixture: "",
	descendants: [] as number[],
	child: undefined as ChildProcess | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (_command: string, _args: string[], options: SpawnOptions) => {
			const child = actual.spawn(process.execPath, [state.fixture], options);
			state.child = child;
			let buffer = "";
			child.stdout?.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const event = JSON.parse(line);
					if (event.type === "descendant_pid") state.descendants.push(event.pid);
				}
			});
			return child;
		},
	};
});

test("workflow child exit settles even when a quiet descendant holds its stdio open", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "subagent-exit-drain-"));
	state.fixture = path.join(cwd, "rpc-child.cjs");
	await writeFile(
		state.fixture,
		`
const {spawn} = require('node:child_process');
process.stdin.once('data', () => {
  const descendant = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {detached:true,stdio:['ignore',1,2]});
  descendant.unref();
  console.log(JSON.stringify({type:'descendant_pid',pid:descendant.pid}));
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
  console.log(JSON.stringify({type:'agent_settled'}));
  process.exit(0);
});
`,
	);
	try {
		const started = Date.now();
		const result = await runStepSubagentProcess({
			agent: { ...builtinStepAgents.find((agent) => agent.name === "general")!, systemPrompt: "" },
			task: "test",
			cwd,
			workflowAcl: { baseCwd: cwd },
			keepAlive: false,
		});
		expect(result.stopReason).toBe("stop");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(state.descendants).toHaveLength(1);
		expect(state.child?.exitCode).toBe(0);
	} finally {
		for (const pid of state.descendants.splice(0)) {
			try {
				process.kill(pid);
			} catch {}
		}
		state.child?.kill();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an admitted subagent resolves only after its child exits; others resolve at agent_settled", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "subagent-await-exit-"));
	state.fixture = path.join(cwd, "rpc-child.cjs");
	// The child settles its turn, then takes 300ms to exit after stdin closes.
	await writeFile(
		state.fixture,
		`
process.stdin.once('data', () => {
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:{total:0}}}}));
  console.log(JSON.stringify({type:'agent_settled'}));
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 300));
process.stdin.resume();
`,
	);
	const agent = { ...builtinStepAgents.find((item) => item.name === "general")!, systemPrompt: "" };
	try {
		const waited = await runStepSubagentProcess({ agent, task: "test", cwd, keepAlive: false, awaitExit: true });
		expect(waited.stopReason).toBe("stop");
		expect(state.child?.exitCode).toBe(0);

		await runStepSubagentProcess({ agent, task: "test", cwd, keepAlive: false });
		const unadmitted = state.child;
		expect(unadmitted?.exitCode).toBeNull();
		await new Promise((resolve) => unadmitted?.once("exit", resolve));
	} finally {
		state.child?.kill();
		await rm(cwd, { recursive: true, force: true });
	}
});
