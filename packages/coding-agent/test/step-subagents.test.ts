import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createStepSubagentsCommandExtension } from "../src/features/step-subagents-command.ts";
import { SUBAGENT_LANE_CHANNEL, type SubagentLaneSnapshot } from "../src/features/subagent/lane-events.ts";

type Handler = (data: unknown) => void;

/** An extension API that records commands and the lane bus, so a test can publish snapshots. */
function harness() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const bus = new Map<string, Set<Handler>>();
	const api = {
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, definition);
		},
		events: {
			emit: (channel: string, data: unknown) => {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: Handler) => {
				const set = bus.get(channel) ?? new Set<Handler>();
				set.add(handler);
				bus.set(channel, set);
				return () => set.delete(handler);
			},
		},
	} as unknown as ExtensionAPI;
	createStepSubagentsCommandExtension()(api);

	const publish = (snapshot: SubagentLaneSnapshot) => {
		for (const handler of bus.get(SUBAGENT_LANE_CHANNEL) ?? []) handler(snapshot);
	};

	const run = async (args: string, mode = "tui"): Promise<string> => {
		const command = commands.get("subagents");
		if (!command) throw new Error("/subagents was not registered");
		const notify = vi.fn();
		await command.handler(args, { mode, ui: { notify } });
		return (notify.mock.calls.at(-1)?.[0] as string | undefined) ?? "";
	};
	return { publish, run };
}

function snapshot(overrides: Partial<SubagentLaneSnapshot> & { laneId: string }): SubagentLaneSnapshot {
	const now = Date.now();
	return {
		status: "running",
		details: {
			mode: "parallel",
			agentScope: "both",
			userAgentsDir: "/tmp/agents",
			projectAgentsDir: null,
			agentId: overrides.laneId,
			startedAt: now - 65_000,
			updatedAt: now,
			results: [
				{
					agent: "general",
					agentSource: "builtin",
					task: "refactor utils",
					status: "running",
					activeTool: "edit_file",
					activeToolArgs: '{"path":"src/utils.ts"}',
					startedAt: now - 65_000,
					updatedAt: now,
				},
			],
			...overrides.details,
		},
		...overrides,
	} as SubagentLaneSnapshot;
}

describe("/subagents", () => {
	test("reports nothing when no lane is running", async () => {
		const { run } = harness();
		expect(await run("")).toContain("No subagents running.");
	});

	test("shows the lane, its task, and the step the child is on", async () => {
		const { publish, run } = harness();
		publish(snapshot({ laneId: "lane_abc12345" }));

		const text = await run("list");

		expect(text).toContain("Subagents running");
		expect(text).toContain("lane_abc12345");
		expect(text).toContain("refactor utils");
		expect(text).toContain("general");
		// The activity line is the whole point: which tool the child is in.
		expect(text).toContain("edit_file");
		expect(text).toContain("1m 5s");
	});

	test("falls back to thinking or reply text so a reasoning child does not read as idle", async () => {
		const { publish, run } = harness();
		const now = Date.now();
		publish({
			laneId: "lane_think",
			status: "running",
			details: {
				mode: "single",
				agentScope: "builtin" as never,
				userAgentsDir: "/tmp",
				projectAgentsDir: null,
				startedAt: now,
				updatedAt: now,
				results: [
					{
						agent: "general",
						agentSource: "builtin",
						task: "reason about it",
						status: "running",
						activeThinking: "weighing two approaches",
						startedAt: now,
						updatedAt: now,
					},
				],
			},
		} as unknown as SubagentLaneSnapshot);

		expect(await run("")).toContain("thinking: weighing two approaches");
	});

	test("a settled lane leaves the live list", async () => {
		const { publish, run } = harness();
		publish(snapshot({ laneId: "lane_done", status: "completed" }));
		expect(await run("")).toContain("No subagents running.");
	});

	test("folds a long roster instead of printing every task", async () => {
		const { publish, run } = harness();
		const now = Date.now();
		publish({
			laneId: "lane_many",
			status: "running",
			details: {
				mode: "parallel",
				agentScope: "both",
				userAgentsDir: "/tmp",
				projectAgentsDir: null,
				startedAt: now,
				updatedAt: now,
				results: Array.from({ length: 20 }, (_unused, index) => ({
					agent: "general",
					agentSource: "builtin" as const,
					task: `task ${index}`,
					status: "running" as const,
					startedAt: now,
					updatedAt: now,
				})),
			},
		} as unknown as SubagentLaneSnapshot);

		const text = await run("");
		expect(text).toContain("task 15");
		expect(text).not.toContain("task 16");
		expect(text).toContain("... and 4 more");
	});

	test("refuses to run outside the terminal", async () => {
		// Web and Desktop draw lane state in their inspector; `notify` is a no-op there.
		const { run } = harness();
		for (const mode of ["rpc", "json", "print"] as const) {
			expect(await run("", mode)).toContain("terminal command");
		}
	});

	test("a malformed invocation explains the usage", async () => {
		const { run } = harness();
		expect(await run("bogus")).toContain("Usage: /subagents");
	});
});
