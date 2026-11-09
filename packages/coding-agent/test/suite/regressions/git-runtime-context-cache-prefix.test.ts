import { spawnSync } from "node:child_process";
import { fauxAssistantMessage } from "@step-harness/providers";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { SystemPromptProduct } from "../../../src/core/system-prompt.ts";
import { createStepRuntimeContextExtension } from "../../../src/features/step-runtime-context.ts";
import { buildStepSystemPromptAppendix } from "../../../src/step/system-prompt.ts";
import { createHarness, getMessageText } from "../harness.ts";

/** The Step operating contract, layered on the prompt the way the CLI composes it. */
const STEP_PRODUCT: SystemPromptProduct = {
	name: "StepCode",
	includeDocumentation: false,
	promptAppendix: buildStepSystemPromptAppendix,
};

/**
 * The git branch used to sit in the Step system prompt's <env> block. A
 * checkout did nothing until an unrelated rebuild (an MCP catalog refresh, a
 * tool registration) re-read git and rewrote the system prompt, which the
 * provider caches right after the tool block, so the whole conversation was
 * re-billed as cache writes. The branch now rides an appended runtime-context
 * snapshot; the system prompt and tools stay byte-identical.
 */

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
}

it.skipIf(!hasGit)("announces a branch switch in history while the cached prefix stays byte-identical", async () => {
	const harness = await createHarness({
		systemPromptProduct: STEP_PRODUCT,
		// The session starts inside a repository, as a real one does.
		setupWorkspace: (directory) => {
			git(directory, "init", "-q", "-b", "feat/log-ctx-gate");
			git(
				directory,
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"x",
			);
		},
		tools: [
			{
				name: "read_file",
				label: "read_file",
				description: "read_file tool",
				parameters: Type.Object({ path: Type.Optional(Type.String()) }),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			},
		],
		extensionFactories: [
			{ name: "step-runtime-context", factory: createStepRuntimeContextExtension(), hidden: true },
		],
	});

	try {
		const captured: Array<{ systemPrompt: string; tools: string; messages: string[] }> = [];
		const respond =
			(label: string) => (context: { systemPrompt?: string; tools?: unknown[]; messages: unknown[] }) => {
				captured.push({
					systemPrompt: context.systemPrompt ?? "",
					tools: JSON.stringify(context.tools ?? []),
					messages: context.messages.map((message) => getMessageText(message)),
				});
				return fauxAssistantMessage(label);
			};
		harness.setResponses([respond("one"), respond("two"), respond("three"), respond("four")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		git(harness.tempDir, "checkout", "-q", "-b", "dev");
		// An unrelated rebuild, as an MCP catalog refresh does, must not change
		// the system prompt now that git state is not part of it.
		harness.session.setActiveToolsByName(harness.session.getActiveToolNames());

		await harness.session.prompt("third");
		await harness.session.prompt("fourth");

		expect(captured).toHaveLength(4);
		expect(captured[0]!.systemPrompt).toContain("# StepCode operating contract");
		expect(captured[0]!.systemPrompt).not.toContain("Git branch:");
		for (const request of captured.slice(1)) {
			expect(request.systemPrompt).toBe(captured[0]!.systemPrompt);
			expect(request.tools).toBe(captured[0]!.tools);
		}

		const snapshots = (request: (typeof captured)[number]) =>
			request.messages.filter((text) => text.includes("Current runtime context."));
		// The first prompt announces the starting branch; an unchanged prompt adds nothing.
		expect(snapshots(captured[0]!)).toEqual([expect.stringContaining("Git branch: feat/log-ctx-gate")]);
		expect(snapshots(captured[1]!)).toHaveLength(1);
		// After the checkout the next prompt appends one snapshot after the unchanged history.
		expect(captured[2]!.messages.slice(0, captured[1]!.messages.length + 1)).toEqual([
			...captured[1]!.messages,
			"two",
		]);
		expect(snapshots(captured[2]!)).toHaveLength(2);
		expect(snapshots(captured[2]!)[1]).toContain("Git branch: dev");
		expect(snapshots(captured[3]!)).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});
