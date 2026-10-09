import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const hasPython = spawnSync("python3", ["-c", "pass"], { timeout: 3000 }).status === 0;
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("AgentSession CLM context integration", () => {
	it("edits the mirror using a tool and uses the result on the next request without rewriting history", async () => {
		let harness: Harness;
		const tool: AgentTool = {
			name: "organize_context",
			label: "Organize",
			description: "Organize previous findings",
			parameters: Type.Object({}),
			execute: async () => {
				const path = harness.session.getLiveContextStatus()!.path!;
				writeFileSync(
					path,
					readFileSync(path, "utf8").replace("Verbose old exploration", "Useful concise finding"),
				);
				return { content: [{ type: "text", text: "edit saved" }], details: {} };
			},
		};
		harness = await createHarness({ settings: { compaction: { contextProjection: "clm-v1" } }, tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Verbose old exploration"), fauxAssistantMessage("latest finding")]);
		await harness.session.prompt("Fix the parser and retain the public API.");
		await harness.session.prompt("Check progress.");
		let next: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("organize_context", {}), { stopReason: "toolUse" }),
			(context) => {
				next = context;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Organize what you learned.");
		expect(JSON.stringify(next!.messages)).toContain("Useful concise finding");
		expect(JSON.stringify(next!.messages)).not.toContain("Verbose old exploration");
		expect(next!.messages.some((m) => m.role === "toolResult" && m.toolName === "organize_context")).toBe(true);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("Verbose old exploration");
		expect(harness.session.getLiveContextStatus()!.revision).toBe(1);
	});
	it("can inspect a large context index and edit it before native threshold compaction", async () => {
		let h: Harness;
		const oldText = "obsolete diagnostic observation\n".repeat(5400);
		const inspect: AgentTool = {
			name: "inspect_context",
			label: "Inspect",
			description: "Inspect the working context index",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: readFileSync(h.session.getLiveContextStatus()!.indexPath, "utf8") }],
				details: {},
			}),
		};
		const edit: AgentTool = {
			name: "organize_context",
			label: "Organize",
			description: "Apply one batched edit",
			parameters: Type.Object({}),
			execute: async () => {
				const path = h.session.getLiveContextStatus()!.path;
				writeFileSync(
					path,
					readFileSync(path, "utf8").replace(
						oldText,
						"Retain the exact parser failure; discard repeated successful observations.",
					),
				);
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		h = await createHarness({
			models: [{ id: "index-budget", contextWindow: 64000, maxTokens: 8192 }],
			settings: {
				compaction: {
					contextProjection: "clm-v1",
					reserveTokens: 8192,
					keepRecentTokens: 20000,
					autoClm: { enabled: false },
				},
			},
			tools: [inspect, edit],
		});
		harnesses.push(h);
		const initial = [
			{ role: "user" as const, content: "Fix the parser while preserving its API", timestamp: 1 },
			fauxAssistantMessage(oldText, { timestamp: 2 }),
			fauxAssistantMessage("Investigation complete; implementation remains", { timestamp: 3 }),
		];
		for (const message of initial) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = initial;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({ role: "toolResult", isError: false });
				expect(JSON.stringify(result)).toContain("read-only");
				return fauxAssistantMessage(fauxToolCall("organize_context", {}), { stopReason: "toolUse" });
			},
			(context) => {
				expect(
					context.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.content.some((part) => part.type === "text" && part.text === oldText),
					),
				).toBe(false);
				expect(JSON.stringify(context.messages)).toContain("Retain the exact parser failure");
				return fauxAssistantMessage("organized");
			},
		]);
		await h.session.prompt("Organize the completed investigation");
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(JSON.stringify(h.sessionManager.getEntries())).toContain("obsolete diagnostic observation");
	});

	it("supplies the index and an atomic edit recipe in the explicit compact request", async () => {
		const h = await createHarness({ settings: { compaction: { contextProjection: "clm-v1", enabled: false } } });
		harnesses.push(h);
		const old = "old observation to summarize ".repeat(1000);
		const messages = [
			{ role: "user" as const, content: "Preserve the public API", timestamp: 1 },
			fauxAssistantMessage(old, { timestamp: 2 }),
			fauxAssistantMessage("current state", { timestamp: 3 }),
		];
		for (const message of messages) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = messages;
		let compactPrompt = "";
		h.setResponses([
			(context) => {
				compactPrompt =
					context.messages
						.filter((m) => m.role === "user")
						.map((m) =>
							typeof m.content === "string"
								? m.content
								: m.content
										.filter((p) => p.type === "text")
										.map((p) => p.text)
										.join("\n"),
						)
						.find((text) => text.startsWith("Organize your working context")) ?? "";
				return fauxAssistantMessage("No further edit needed");
			},
		]);
		await h.session.prompt("/clm-compact preserve exact errors");
		expect(compactPrompt).toContain("# Working context index (read-only)");
		expect(compactPrompt).toContain("replacements =");
		expect(compactPrompt).toContain("preserve exact errors");
		expect(compactPrompt).not.toContain(old);
	});

	it.skipIf(!hasPython)("executes the supplied recipe without changing protected CRLF text", async () => {
		let h: Harness;
		let compactPrompt = "";
		const tool: AgentTool = {
			name: "apply_recipe",
			label: "Apply",
			description: "Execute the supplied atomic edit recipe",
			parameters: Type.Object({}),
			execute: async () => {
				const path = h.session.getLiveContextStatus()!.path;
				const id = /index=2 role=assistant id=([a-zA-Z0-9-]+) protected=false/.exec(readFileSync(path, "utf8"))![1];
				const recipe = compactPrompt
					.slice(compactPrompt.indexOf("from pathlib import Path\n"))
					.replace(
						'replacements = {"ID_FROM_INDEX": "Your concise summary preserving exact useful findings"}',
						`replacements = ${JSON.stringify({ [id]: "retained finding" })}`,
					);
				execFileSync("python3", ["-c", recipe], { timeout: 5000 });
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		h = await createHarness({
			settings: { compaction: { contextProjection: "clm-v1", enabled: false } },
			tools: [tool],
		});
		harnesses.push(h);
		const messages = [
			{
				role: "user" as const,
				content: "Exact requirement:\r\nPreserve public API.\rDo not change this text.",
				timestamp: 1,
			},
			fauxAssistantMessage("old finding", { timestamp: 2 }),
			fauxAssistantMessage("latest state", { timestamp: 3 }),
		];
		for (const message of messages) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = messages;
		h.setResponses([
			(context) => {
				compactPrompt =
					context.messages
						.filter((m) => m.role === "user")
						.map((m) =>
							typeof m.content === "string"
								? m.content
								: m.content
										.filter((p) => p.type === "text")
										.map((p) => p.text)
										.join("\n"),
						)
						.find((text) => text.startsWith("Organize your working context")) ?? "";
				return fauxAssistantMessage(fauxToolCall("apply_recipe", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("organized"),
		]);
		let previousStopChecks = 0;
		const previousStop = () => {
			previousStopChecks++;
			return false;
		};
		h.session.agent.shouldStopAfterTurn = previousStop;
		await h.session.prompt("/clm-compact");
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.eventsOfType("live_context").at(-1)?.outcome.accepted).toBe(true);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(previousStopChecks).toBe(1);
		expect(h.session.agent.shouldStopAfterTurn).toBe(previousStop);
		await h.session.prompt("Continue the project task");
		expect(h.getPendingResponseCount()).toBe(0);
		expect(previousStopChecks).toBe(2);
	});

	it("creates the default working view on the first request without a maintenance call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let request: Context | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("Hello.");
			},
		]);
		await harness.session.prompt("hello");
		const status = harness.session.getLiveContextStatus();
		expect(status?.revision).toBe(0);
		expect(existsSync(status!.path)).toBe(true);
		expect(readFileSync(status!.path, "utf8")).toContain("hello");
		expect(request?.systemPrompt).toContain("The host handles routine context reductions");
		expect(harness.eventsOfType("auto_clm_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each([{ contextProjection: "off" as const }, { enabled: false }])(
		"does not install a working view when disabled with %j",
		async (compaction) => {
			const harness = await createHarness({ settings: { compaction } });
			harnesses.push(harness);
			let request: Context | undefined;
			harness.setResponses([
				(context) => {
					request = context;
					return fauxAssistantMessage("Hello.");
				},
			]);
			await harness.session.prompt("hello");
			expect(harness.session.getLiveContextStatus()).toBeUndefined();
			expect(request?.systemPrompt).not.toContain("## Working context");
			expect(harness.eventsOfType("auto_clm_start")).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);
	it("budgets the edited request without replacing historical provider usage", async () => {
		let h: Harness;
		const tool: AgentTool = {
			name: "organize",
			label: "Organize",
			description: "Retain useful findings",
			parameters: Type.Object({}),
			execute: async () => {
				const path = h.session.getLiveContextStatus()!.path;
				writeFileSync(
					path,
					readFileSync(path, "utf8").replace("obsolete observation ".repeat(4000), "Use csv.reader."),
				);
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		h = await createHarness({
			settings: { compaction: { enabled: false, contextProjection: "clm-v1" } },
			models: [{ id: "clm-budget", contextWindow: 128000, maxTokens: 8192 }],
			tools: [tool],
		});
		harnesses.push(h);
		const old = fauxAssistantMessage("obsolete observation ".repeat(4000), { timestamp: 2 });
		old.usage = { ...structuredClone(old.usage), input: 120000, totalTokens: 120000 };
		const latest = fauxAssistantMessage("latest finding", { timestamp: 4 });
		latest.usage = { ...structuredClone(latest.usage), input: 120000, totalTokens: 120000 };
		const messages = [
			{ role: "user" as const, content: "Fix the parser", timestamp: 1 },
			old,
			{ role: "user" as const, content: "Continue", timestamp: 3 },
			latest,
		];
		for (const message of messages) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = messages;
		const originalUsage = structuredClone(old.usage);
		let before = 0;
		let after = 0;
		h.setResponses([
			(context) => {
				before = context.estimatedInputTokens!;
				return fauxAssistantMessage(fauxToolCall("organize", {}), { stopReason: "toolUse" });
			},
			(context) => {
				after = context.estimatedInputTokens!;
				expect(JSON.stringify(context.messages)).toContain("Use csv.reader");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("Retain findings before continuing");
		expect(before).toBeGreaterThan(20000);
		expect(before).toBeLessThan(120000);
		expect(after).toBeGreaterThan(0);
		expect(after).toBeLessThan(10000);
		expect(h.session.getContextUsage()!.tokens).toBeLessThan(10000);
		expect(old.usage).toEqual(originalUsage);
		expect(latest.usage.input).toBe(120000);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});
	it("keeps model-authored notes in native compaction and preserves edited retained history", async () => {
		let harness: Harness;
		const tool: AgentTool = {
			name: "organize_context",
			label: "Organize",
			description: "Edit live context",
			parameters: Type.Object({}),
			execute: async () => {
				const path = harness.session.getLiveContextStatus()!.path!;
				let text = readFileSync(path, "utf8").replace("original retained detail", "edited retained detail");
				const nonce = /document=([a-f0-9]+)/.exec(text)![1];
				text += `\n\n[[CTX_TURN document=${nonce} index=0 role=notes id=new-current-plan protected=false]]\nUNIQUE_PLAN_NOTE: do not retry the failed regex approach`;
				writeFileSync(path, text);
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		harness = await createHarness({
			settings: { compaction: { contextProjection: "clm-v1", keepRecentTokens: 400 } },
			tools: [tool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old history ".repeat(3000)),
			fauxAssistantMessage("original retained detail"),
			fauxAssistantMessage("latest context"),
		]);
		await harness.session.prompt("original task");
		await harness.session.prompt("next step");
		await harness.session.prompt("continue");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("organize_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("organized"),
		]);
		await harness.session.prompt("organize");
		expect(harness.session.getLiveContextStatus()!.revision).toBe(1);
		let sawNote = false;
		harness.setResponses([
			(context) => {
				sawNote ||= JSON.stringify(context.messages).includes("UNIQUE_PLAN_NOTE");
				return fauxAssistantMessage("Handoff summary including UNIQUE_PLAN_NOTE");
			},
			fauxAssistantMessage("Turn prefix summary"),
		]);
		await harness.session.compact();
		expect(sawNote).toBe(true);
		let next: Context | undefined;
		harness.setResponses([
			(context) => {
				next = context;
				return fauxAssistantMessage("resumed");
			},
		]);
		await harness.session.prompt("continue after compact");
		expect(JSON.stringify(next!.messages)).toContain("edited retained detail");
		expect(JSON.stringify(next!.messages)).not.toContain("original retained detail");
		expect(JSON.stringify(next!.messages)).toContain("UNIQUE_PLAN_NOTE");
	});
	it.each(["normal", "manual"] as const)(
		"preserves steering and all parallel results when accepting a mirror edit (%s)",
		async (mode) => {
			let harness: Harness;
			const editTool: AgentTool = {
				name: "organize",
				label: "Organize",
				description: "Organize",
				parameters: Type.Object({}),
				execute: async () => {
					const path = harness.session.getLiveContextStatus()!.path!;
					writeFileSync(path, readFileSync(path, "utf8").replace("old finding", "new finding"));
					await harness.session.prompt("NEW CONSTRAINT: retain the output format", { streamingBehavior: "steer" });
					return { content: [{ type: "text", text: "context edited" }], details: {} };
				},
			};
			const otherTool: AgentTool = {
				name: "inspect",
				label: "Inspect",
				description: "Inspect",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "inspection evidence" }], details: {} }),
			};
			harness = await createHarness({
				settings: { compaction: { contextProjection: "clm-v1" } },
				tools: [editTool, otherTool],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("old finding"), fauxAssistantMessage("latest finding")]);
			await harness.session.prompt("task");
			await harness.session.prompt("next");
			let next: Context | undefined;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("organize", {}), fauxToolCall("inspect", {})], {
					stopReason: "toolUse",
				}),
				(context) => {
					next = context;
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt(mode === "manual" ? "/clm-compact" : "execute tools");
			expect(JSON.stringify(next!.messages)).toContain("NEW CONSTRAINT");
			expect(JSON.stringify(next!.messages)).toContain("new finding");
			expect(next!.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
		},
	);
	it("accepts a valid edit after the native loop resamples a leaked tool call", async () => {
		let h: Harness;
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "noop done" }], details: {} }),
		};
		const edit: AgentTool = {
			name: "organize",
			label: "Organize",
			description: "Organize",
			parameters: Type.Object({}),
			execute: async () => {
				const path = h.session.getLiveContextStatus()!.path;
				writeFileSync(path, readFileSync(path, "utf8").replace("old finding", "resampled finding"));
				return { content: [{ type: "text", text: "edit saved" }], details: {} };
			},
		};
		h = await createHarness({
			settings: { compaction: { enabled: false, contextProjection: "clm-v1" } },
			tools: [noop, edit],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("old finding"), fauxAssistantMessage("latest finding")]);
		await h.session.prompt("task");
		await h.session.prompt("next");
		let next: Context | undefined;
		h.setResponses([
			fauxAssistantMessage("<tool_call>parser leak</tool_call>"),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("organize", {}), { stopReason: "toolUse" }),
			(context) => {
				next = context;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("organize after noop");
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(JSON.stringify(next!.messages)).toContain("resampled finding");
		expect(JSON.stringify(next!.messages)).not.toContain("parser leak");
		expect(JSON.stringify(h.sessionManager.getEntries())).toContain("parser leak");
	});

	it("keeps the existing raw-history threshold policy in lightweight mode", async () => {
		const h = await createHarness({
			settings: { compaction: { contextProjection: "lightweight-v1", keepRecentTokens: 100, reserveTokens: 4096 } },
			models: [{ id: "lightweight-threshold", contextWindow: 32000, maxTokens: 4096 }],
		});
		harnesses.push(h);
		const messages = [
			{ role: "user" as const, content: "inspect", timestamp: 1 },
			fauxAssistantMessage(fauxToolCall("read", { path: "log" }, { id: "old" }), {
				stopReason: "toolUse",
				timestamp: 2,
			}),
			{
				role: "toolResult" as const,
				toolCallId: "old",
				toolName: "read",
				content: [{ type: "text" as const, text: "stale tool output\n".repeat(10000) }],
				isError: false,
				timestamp: 3,
			},
			fauxAssistantMessage("completed", { timestamp: 4 }),
			{ role: "user" as const, content: "continue", timestamp: 5 },
		];
		for (const message of messages) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = messages;
		h.setResponses([fauxAssistantMessage("native handoff"), fauxAssistantMessage("prefix handoff")]);
		await (
			h.session as unknown as {
				_compactBeforeNextAssistantResponse(context: {
					systemPrompt: string;
					messages: typeof messages;
					tools: [];
				}): Promise<unknown>;
			}
		)._compactBeforeNextAssistantResponse({ systemPrompt: "", messages, tools: [] });
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
