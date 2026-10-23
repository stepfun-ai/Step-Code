import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { COMPACT_COMMAND_NAME, createStepCompactExtension } from "../src/features/compact.ts";

interface Registered {
	readonly name: string;
	readonly description?: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makeHarness() {
	const commands = new Map<string, Registered>();
	const api = {
		registerCommand(name: string, options: Omit<Registered, "name">) {
			commands.set(name, { ...options, name });
		},
	} as unknown as ExtensionAPI;
	createStepCompactExtension()(api);
	const notifications: Array<{ message: string; type?: string }> = [];
	const compactions: Array<{ customInstructions?: string }> = [];
	const run = async (args: string, options: { idle?: boolean } = {}): Promise<void> => {
		const command = commands.get(COMPACT_COMMAND_NAME);
		if (!command) throw new Error("compact command was not registered");
		const ctx = {
			isIdle: () => options.idle ?? true,
			ui: {
				notify: (message: string, type?: string) => {
					notifications.push({ message, ...(type ? { type } : {}) });
				},
			},
			compact: (input?: { customInstructions?: string }) => {
				compactions.push({
					...(input?.customInstructions ? { customInstructions: input.customInstructions } : {}),
				});
			},
		} as unknown as ExtensionCommandContext;
		await command.handler(args, ctx);
	};
	return { command: () => commands.get(COMPACT_COMMAND_NAME), notifications, compactions, run };
}

test("registers the compact command", () => {
	const harness = makeHarness();
	expect(harness.command()).toMatchObject({
		name: COMPACT_COMMAND_NAME,
		description: "Compact the session context",
	});
});

test("compacts the session with the typed instructions", async () => {
	const harness = makeHarness();
	await harness.run("  keep the API decisions  ");
	expect(harness.compactions).toEqual([{ customInstructions: "keep the API decisions" }]);
	expect(harness.notifications).toEqual([]);
});

test("refuses while a run is active so compaction cannot abort it", async () => {
	const harness = makeHarness();
	await harness.run("", { idle: false });
	expect(harness.compactions).toEqual([]);
	expect(harness.notifications).toEqual([
		{ message: "Wait for the current run to finish before compacting the context.", type: "warning" },
	]);
});

test("a refusal is reported by the session's compaction_end, not twice by the command", async () => {
	// The terminal renders `compaction_end.errorMessage` itself; notifying here
	// as well printed the same failure twice.
	const harness = makeHarness();
	await harness.run("");
	expect(harness.compactions).toEqual([{}]);
	expect(harness.notifications).toEqual([]);
});
