import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ToolExecutionMode } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../src/core/tools/truncate.ts";
import { createStepExtension } from "../../src/features/step.ts";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	vi.restoreAllMocks();
});

function text(content: readonly { type: string; text?: string }[]) {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function runOutput(output: string, hookOutput?: string) {
	const remote: AgentTool = {
		name: "remote_output",
		label: "Remote output",
		description: "Return remote text",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: output }],
			details: { truncated: true, preserved: "metadata" },
		}),
	};
	const harness = await createHarness({
		tools: [remote],
		settings: { compaction: { enabled: false } },
		extensionFactories:
			hookOutput === undefined
				? undefined
				: [
						(pi) => {
							pi.on("tool_result", () => ({ content: [{ type: "text", text: hookOutput }] }));
						},
					],
	});
	harnesses.push(harness);
	vi.spyOn(harness.sessionManager, "getSessionDir").mockReturnValue(join(harness.tempDir, "sessions"));
	let requestText = "";
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("remote_output", {}), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.find((message) => message.role === "toolResult");
			if (result?.role === "toolResult") requestText = text(result.content);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("get remote output");
	return { harness, requestText };
}

describe("AgentSession final tool output", () => {
	it.each([
		["many lines", Array.from({ length: 2100 }, (_, n) => `line ${n}`).join("\n")],
		["one long line", "x".repeat(DEFAULT_MAX_BYTES + 2000)],
		["multibyte output", "中文🙂\n".repeat(9000)],
	])("bounds %s and retains the exact complete text", async (_name, original) => {
		const { harness, requestText } = await runOutput(original);
		expect(Buffer.byteLength(requestText)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(requestText.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		const match = requestText.match(/Full output: (.+)\]/);
		expect(match).not.toBeNull();
		const path = JSON.parse(match![1]) as string;
		expect(path.startsWith(harness.tempDir)).toBe(true);
		expect(await readFile(path, "utf8")).toBe(original);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ details: { truncated: true, preserved: "metadata" }, isError: false });
		expect(harness.eventsOfType("tool_execution_end")[0].result.content).toEqual(result?.content);
	});

	it("bounds text supplied by a tool_result extension", async () => {
		const original = "hooked\n".repeat(9000);
		const { requestText } = await runOutput("small", original);
		expect(Buffer.byteLength(requestText)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		const match = requestText.match(/Full output: (.+)\]/);
		expect(match).not.toBeNull();
		expect(await readFile(JSON.parse(match![1]), "utf8")).toBe(original);
	});

	it.each<ToolExecutionMode>(["sequential", "parallel"])(
		"bounds validation and blocked results in %s mode",
		async (mode) => {
			const remote: AgentTool = {
				name: "validate",
				label: "Validate",
				description: "Validate",
				parameters: Type.Object({ count: Type.Number() }),
				execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "unreachable" }], details: {} })),
			};
			const harness = await createHarness({
				tools: [remote],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", () => ({ block: true, reason: "denied ".repeat(9000), terminate: true }));
					},
				],
			});
			harnesses.push(harness);
			vi.spyOn(harness.sessionManager, "getSessionDir").mockReturnValue(join(harness.tempDir, "sessions"));
			harness.session.agent.toolExecution = mode;
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("validate", { count: "bad ".repeat(20000) }), fauxToolCall("validate", { count: 1 })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("validate");
			expect(remote.execute).not.toHaveBeenCalled();
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			for (const result of results) {
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(text(result.content))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
				expect(text(result.content)).toContain("Full output:");
			}
		},
	);

	it("reports retention failure without losing a terminating tool's metadata", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "x".repeat(60000) }],
			details: { effect: "already completed" },
			terminate: true,
		}));
		const harness = await createHarness({
			tools: [{ name: "finish", label: "Finish", description: "Finish", parameters: Type.Object({}), execute }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const unavailable = join(harness.tempDir, "not-a-directory");
		await writeFile(unavailable, "keep");
		vi.spyOn(harness.sessionManager, "getSessionDir").mockReturnValue(unavailable);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" })]);
		await harness.session.prompt("finish");
		expect(execute).toHaveBeenCalledTimes(1);
		const result = harness.session.messages.at(-1);
		expect(result).toMatchObject({ role: "toolResult", isError: true, details: { effect: "already completed" } });
		if (result?.role !== "toolResult") throw new Error("Expected tool result");
		expect(text(result.content)).toContain("may already have run");
		expect(Buffer.byteLength(text(result.content))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(await readFile(unavailable, "utf8")).toBe("keep");
	});

	it.each([false, true])(
		"bounds message_end replacements before persistence (storage failure: %s)",
		async (storageFailure) => {
			const original = "replacement".repeat(6000);
			const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "small" }],
				details: {},
				terminate: storageFailure,
			}));
			const harness = await createHarness({
				tools: [
					{
						name: "replace_late",
						label: "Replace late",
						description: "Replace late",
						parameters: Type.Object({}),
						execute,
					},
				],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("message_end", (event) => {
							if (event.message.role !== "toolResult") return;
							return {
								message: {
									...event.message,
									content: [{ type: "text", text: original }, image],
									details: { replacement: "kept" },
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			const directory = join(harness.tempDir, "sessions");
			if (storageFailure) await writeFile(directory, "unavailable");
			vi.spyOn(harness.sessionManager, "getSessionDir").mockReturnValue(directory);
			harness.setResponses([fauxAssistantMessage(fauxToolCall("replace_late", {}), { stopReason: "toolUse" })]);
			if (!storageFailure) {
				harness.appendResponses([
					(context) => {
						const result = context.messages.find((message) => message.role === "toolResult");
						if (result?.role !== "toolResult") throw new Error("Expected model tool result");
						expect(Buffer.byteLength(text(result.content))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
						return fauxAssistantMessage("done");
					},
				]);
			}
			await harness.session.prompt("replace late");
			expect(execute).toHaveBeenCalledTimes(1);
			const result = harness.session.messages.find((message) => message.role === "toolResult");
			if (result?.role !== "toolResult") throw new Error("Expected tool result");
			expect(Buffer.byteLength(text(result.content))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(result.content.filter((part) => part.type === "image")).toEqual([image]);
			expect(result.details).toEqual({ replacement: "kept" });
			expect(result.isError).toBe(storageFailure);
			const stored = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.at(-1);
			if (stored?.type !== "message" || stored.message.role !== "toolResult")
				throw new Error("Expected persisted tool result");
			expect(stored.message.content).toEqual(result.content);
			if (storageFailure) {
				expect(text(result.content)).toContain("may already have run");
			} else {
				const path = JSON.parse(text(result.content).match(/Full output: (.+)\]/)![1]);
				expect(await readFile(path, "utf8")).toBe(original);
			}
		},
	);

	it("keeps small output unchanged", async () => {
		const { requestText } = await runOutput("unchanged");
		expect(requestText).toBe("unchanged");
	});

	it("keeps the tail and exit status of a failed command that bash already truncated", async () => {
		if (process.platform === "win32") return;
		const sandbox = mkdtempSync(join(tmpdir(), "step-tool-output-bash-"));
		vi.stubEnv("STEP_CODING_AGENT_DIR", join(sandbox, "agent"));
		try {
			const harness = await createHarness({
				tools: [],
				initialActiveToolNames: ["run_command"],
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					createStepExtension({
						permission: { env: {}, initialPreset: "bypass", toolOverrides: { run_command: "allow" } },
					}),
					(pi) => {
						const tool = createStepToolProfile(sandbox, { agentDir: join(sandbox, "agent") }).find(
							(candidate) => candidate.name === "run_command",
						);
						if (!tool) throw new Error("Step run_command tool is missing");
						pi.registerTool(tool);
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "print" });
			let requestText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("run_command", { command: "seq 1 3000; exit 1", cwd: sandbox }), {
					stopReason: "toolUse",
				}),
				(context) => {
					const result = context.messages.find((message) => message.role === "toolResult");
					if (result?.role === "toolResult") requestText = text(result.content);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("run the build");
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			expect(requestText).toContain("\n3000\n");
			expect(requestText).toMatch(/Full output: \S*step-bash-\S+\.log\]/);
			expect(requestText.endsWith("Command exited with code 1")).toBe(true);
			expect(requestText).not.toContain("Showing first");
		} finally {
			vi.unstubAllEnvs();
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
