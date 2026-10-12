import type { AgentMessage, AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const active: Harness[] = [];
afterEach(() => {
	const harnesses = active.splice(0);
	try {
		for (const h of harnesses) {
			// Faux providers turn callback assertions into assistant errors; surface them here.
			expect(
				h.session.messages
					.filter((message) => message.role === "assistant" && message.stopReason === "error")
					.map((message) => (message.role === "assistant" ? message.errorMessage : "")),
			).toEqual([]);
		}
	} finally {
		for (const h of harnesses) h.cleanup();
	}
});
const oldText = "obsolete successful observation; no new failure\n".repeat(3500);

function seed(h: Harness, text = oldText) {
	const messages: AgentMessage[] = [
		{ role: "user", content: "Repair the parser without changing the public API", timestamp: 1 },
		fauxAssistantMessage(text, { timestamp: 2 }),
		{ role: "user", content: "The investigation is complete", timestamp: 3 },
		fauxAssistantMessage("Current state; implementation and verification remain", { timestamp: 4 }),
	];
	for (const message of messages)
		if (message.role === "assistant" || message.role === "user") h.sessionManager.appendMessage(message);
	h.session.agent.state.messages = messages;
}
async function setup(
	options: {
		auto?: boolean;
		mode?: "off" | "lightweight-v1" | "clm-v1";
		native?: boolean;
		alignNativeThreshold?: boolean;
		contextWindow?: number;
		tools?: AgentTool[];
		extensions?: HarnessOptions["extensionFactories"];
	} = {},
) {
	const h = await createHarness({
		models: [{ id: "automatic-clm", contextWindow: options.contextWindow ?? 64000, maxTokens: 8192 }],
		settings: {
			compaction: {
				...(options.mode === undefined ? {} : { contextProjection: options.mode }),
				enabled: options.native ?? true,
				reserveTokens: options.contextWindow ? 2048 : 8192,
				keepRecentTokens: options.contextWindow ? 4000 : 20000,
				autoClm: {
					...(options.alignNativeThreshold ? {} : { softThresholdRatio: 0.6 }),
					...(options.auto === undefined ? {} : { enabled: options.auto }),
				},
			},
		},
		tools: options.tools ?? [],
		extensionFactories: options.extensions,
	});
	active.push(h);
	seed(h);
	return h;
}
function automaticEdit(
	context: Context,
	text = "Prior investigation complete: preserve exact parser errors and implement csv.reader.",
) {
	const cachedJson = JSON.stringify(context.messages.at(-1)).includes("Reply with only JSON");
	if (!cachedJson) expect(context.tools?.map((tool) => tool.name)).toEqual(["apply_context_edit"]);
	const prompt = context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
		)
		.join("\n");
	const id = /- id=([^ ]+) role=assistant chars=/.exec(prompt)?.[1];
	expect(id).toBeDefined();
	return cachedJson
		? fauxAssistantMessage(JSON.stringify({ replacements: [{ id, text }] }))
		: fauxAssistantMessage(fauxToolCall("apply_context_edit", { replacements: [{ id, text }] }), {
				stopReason: "toolUse",
			});
}

describe("automatic CLM maintenance", () => {
	it("waits for the native threshold by default", async () => {
		const h = await setup({ alignNativeThreshold: true });
		let taskRequest: Context | undefined;
		h.setResponses([
			(context) => {
				taskRequest = context;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("continue below the native threshold");
		expect(h.eventsOfType("auto_clm_start")).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(taskRequest?.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
	});
	it("tries default CLM first when an ordinary prompt crosses the native threshold", async () => {
		const h = await setup({ alignNativeThreshold: true });
		seed(h, "old completed observation\n".repeat(8800));
		const beforeTokens = h.session.getContextUsage()!.tokens!;
		let taskRequest: Context | undefined;
		h.setResponses([
			(context) => automaticEdit(context),
			(context) => {
				taskRequest = context;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("NEW REQUIREMENT: preserve output order");
		expect(h.eventsOfType("auto_clm_start")).toEqual([{ type: "auto_clm_start", reason: "native-threshold" }]);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.session.getSessionStats().contextUsage!.tokens).toBeLessThan(beforeTokens);
		expect(JSON.stringify(taskRequest?.messages)).toContain("NEW REQUIREMENT");
		expect(JSON.stringify(taskRequest?.messages)).toContain("csv.reader");
	});
	it("uses the same native threshold after a complete parallel tool turn", async () => {
		let completed = 0;
		const bulk: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Inspect logs",
			parameters: Type.Object({}),
			execute: async () => {
				completed++;
				return { content: [{ type: "text", text: "evidence".repeat(3500) }], details: {} };
			},
		};
		const check: AgentTool = {
			name: "check",
			label: "Check",
			description: "Verify state",
			parameters: Type.Object({}),
			execute: async () => {
				completed++;
				return { content: [{ type: "text", text: "exact current evidence" }], details: {} };
			},
		};
		const h = await setup({ alignNativeThreshold: true, tools: [bulk, check] });
		seed(h, "old completed observation\n".repeat(7600));
		let taskRequest: Context | undefined;
		let completedAtMaintenance = 0;
		let actorContext: Context | undefined;
		h.setResponses([
			(context) => {
				actorContext = JSON.parse(
					JSON.stringify({
						...context,
						tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
					}),
				) as Context;
				return fauxAssistantMessage([fauxToolCall("bulk", {}), fauxToolCall("check", {})], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(context.systemPrompt).toBe(actorContext!.systemPrompt);
				expect(context.tools).toEqual(actorContext!.tools);
				expect(context.messages.slice(0, actorContext!.messages.length)).toEqual(actorContext!.messages);
				completedAtMaintenance = completed;
				return automaticEdit(context);
			},
			(context) => {
				taskRequest = context;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("inspect the completed investigation");
		expect(completedAtMaintenance).toBe(2);
		expect(h.eventsOfType("auto_clm_start")).toEqual([{ type: "auto_clm_start", reason: "native-threshold" }]);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(taskRequest?.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(JSON.stringify(taskRequest?.messages)).toContain("exact current evidence");
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
	});
	it("defers completed-response CLM until another request needs the context", async () => {
		const h = await setup({ alignNativeThreshold: true });
		const answer = "completed task output ".repeat(2900);
		h.setResponses([fauxAssistantMessage(answer), (context) => automaticEdit(context)]);
		await h.session.prompt("complete this step");
		expect(h.eventsOfType("auto_clm_start")).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: answer }] });
		expect(h.session.getLiveContextStatus()!.revision).toBe(0);
		expect(h.getPendingResponseCount()).toBe(1);

		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("NEW TASK: preserve the completed answer");
				return automaticEdit(context);
			},
			fauxAssistantMessage("Follow-up completed."),
		]);
		await h.session.prompt("NEW TASK: preserve the completed answer");
		expect(h.eventsOfType("auto_clm_start")).toEqual([{ type: "auto_clm_start", reason: "native-threshold" }]);
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("retains the existing eager native behavior when CLM is off", async () => {
		const h = await setup({ alignNativeThreshold: true, mode: "off" });
		h.setResponses([
			fauxAssistantMessage("completed task output ".repeat(2900)),
			fauxAssistantMessage("## Goal\nTask completed. Preserve its result."),
		]);
		await h.session.prompt("complete this step without CLM");
		expect(h.eventsOfType("auto_clm_start")).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(0);
	});
	it("runs before an ordinary user prompt with no manual compact or model reminder", async () => {
		const h = await setup();
		let automaticRequests = 0;
		let taskRequests = 0;
		h.setResponses([
			(context) => {
				automaticRequests++;
				expect(JSON.stringify(context.messages)).toContain("NEW REQUIREMENT: keep the quoted comma error");
				return automaticEdit(context);
			},
			(context) => {
				taskRequests++;
				expect(JSON.stringify(context.messages)).not.toContain(oldText);
				expect(JSON.stringify(context.messages)).toContain("csv.reader");
				expect(JSON.stringify(context.messages)).toContain("NEW REQUIREMENT");
				return fauxAssistantMessage("Implementation complete");
			},
		]);
		await h.session.prompt("NEW REQUIREMENT: keep the quoted comma error");
		expect(automaticRequests).toBe(1);
		expect(taskRequests).toBe(1);
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
		expect(
			h.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "text" && part.text === oldText),
				),
		).toBe(true);
		const entry = h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "step-auto-clm");
		expect(entry).toBeDefined();
	});
	it.each([
		{ auto: false, mode: "clm-v1" as const },
		{ mode: "off" as const },
		{ mode: "lightweight-v1" as const },
		{ native: false },
	])("leaves other modes and explicit opt-out alone: %j", async (options) => {
		const h = await setup(options);
		h.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("ordinary task");
		expect(
			h.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "step-auto-clm"),
		).toBe(false);
	});
	it("does not spend a maintenance request on short contexts", async () => {
		const h = await setup();
		seed(h, "brief investigation");
		h.setResponses([
			(context) => {
				expect(context.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("small task");
		expect(h.session.getLiveContextStatus()!.revision).toBe(0);
	});
	it("uses native compaction directly when incoming input exceeds the context window", async () => {
		const h = await setup({
			extensions: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Native handoff preserves the parser API",
							firstKeptEntryId: event.branchEntries.filter((entry) => entry.type === "message").at(-1)!.id,
							tokensBefore: 60000,
						},
					}));
				},
			],
		});
		const incoming = "NEW EXACT REQUIREMENT: preserve output order. ".repeat(1900);
		h.setResponses([
			(context) => {
				expect(h.eventsOfType("compaction_start")).toHaveLength(1);
				expect(context.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
				expect(context.estimatedInputTokens).toBeLessThan(55808);
				expect(JSON.stringify(context.messages)).toContain("NEW EXACT REQUIREMENT");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt(incoming);
		expect(h.eventsOfType("auto_clm_start")).toHaveLength(0);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(0);
	});
	it("does not run maintenance after native compaction is cancelled at the same pre-request boundary", async () => {
		const h = await setup({
			auto: false,
			extensions: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		h.settingsManager.applyOverrides({ compaction: { reserveTokens: 24000 } });
		let firstRequest = true;
		h.setResponses([
			(context) => {
				expect(h.eventsOfType("compaction_start")).toHaveLength(1);
				expect(context.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
				firstRequest = false;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("ordinary task");
		expect(firstRequest).toBe(false);
		expect(h.eventsOfType("auto_clm_start")).toHaveLength(0);
	});
	it("lets abort finish while maintenance authentication is still waiting", async () => {
		const h = await setup();
		let releaseAuth!: () => void;
		let enteredAuth!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredAuth = resolve;
		});
		const pendingAuth = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		const authSession = h.session as unknown as {
			_getSummarizationRequestAuth: () => Promise<{ model: (typeof h.models)[0] }>;
		};
		authSession._getSummarizationRequestAuth = async () => {
			enteredAuth();
			await pendingAuth;
			return { model: h.models[0] };
		};
		const prompt = h.session.prompt("ordinary task");
		await entered;
		const aborted = await Promise.race([
			h.session.abort().then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
		]);
		try {
			expect(aborted).toBe(true);
			expect(h.session.isCompacting).toBe(false);
			expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		} finally {
			releaseAuth();
			await prompt;
		}
	});
	it("falls back once when a model makes no context edit", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage("I will retain everything"),
			fauxAssistantMessage("Native handoff"),
			fauxAssistantMessage("Prefix handoff"),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("ordinary task");
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.session.getLiveContextStatus()!.revision).toBeGreaterThanOrEqual(1);
	});
	it("does not activate a cosmetic edit that cannot save enough context", async () => {
		const h = await setup();
		h.settingsManager.applyOverrides({ compaction: { autoClm: { maxRequests: 1 } } });
		h.setResponses([
			(context) => automaticEdit(context, oldText.slice(0, -2)),
			fauxAssistantMessage("Native handoff"),
			fauxAssistantMessage("Prefix handoff"),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("ordinary task");
		expect(
			h.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "step-live-context"),
		).toBe(false);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
	});
	it("preserves queued steering and avoids a summary when new input interrupts maintenance", async () => {
		const h = await setup();
		h.setResponses([
			async (context) => {
				await h.session.prompt("STEERING: also preserve output order", { streamingBehavior: "steer" });
				return automaticEdit(context);
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("STEERING");
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("ordinary task");
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.session.getLiveContextStatus()!.revision).toBe(0);
	});
	it("retains parser-resampling exclusions when maintenance is interrupted", async () => {
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Check progress",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "current evidence" }], details: {} }),
		};
		const h = await setup({ tools: [noop] });
		seed(h, "brief prior state");
		h.setResponses([fauxAssistantMessage(oldText)]);
		await h.session.prompt("collect old findings");
		let nextContext: Context | undefined;
		h.setResponses([
			fauxAssistantMessage("<tool_call>UNEXECUTED_PARSER_LEAK</tool_call>"),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async (context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["apply_context_edit"]);
				await h.session.prompt("STEERING: retain output order", { streamingBehavior: "steer" });
				return fauxAssistantMessage("No edit while user input pending");
			},
			(context) => {
				nextContext = context;
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.prompt("inspect task");
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(nextContext).toBeDefined();
		expect(JSON.stringify(nextContext!.messages)).not.toContain("UNEXECUTED_PARSER_LEAK");
		expect(JSON.stringify(nextContext!.messages)).toContain("STEERING");
	});
	it("waits for the complete tool batch and continues the task once", async () => {
		let finished = false;
		const bulk: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Collect evidence",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: oldText.slice(0, 42000) }], details: {} }),
		};
		const slow: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Verify",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				finished = true;
				return { content: [{ type: "text", text: "exact verification evidence" }], details: {} };
			},
		};
		const h = await setup({ tools: [bulk, slow], contextWindow: 16000 });
		seed(h, "brief prior state");
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("bulk", {}), fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			(context) => {
				expect(finished).toBe(true);
				expect(context.tools?.some((tool) => tool.name === "apply_context_edit")).toBe(false);
				expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
				return fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" });
			},
			(context) => {
				expect(finished).toBe(true);
				expect(context.tools?.map((tool) => tool.name)).toEqual(["apply_context_edit"]);
				const prompt = JSON.stringify(context.messages);
				const id = /- id=([^ ]+) role=toolResult chars=/.exec(prompt)?.[1];
				expect(id).toBeDefined();
				const replacements = [{ id, text: "Bulk checks passed; exact verification evidence preserved." }];
				return JSON.stringify(context.messages.at(-1)).includes("Reply with only JSON")
					? fauxAssistantMessage(JSON.stringify({ replacements }))
					: fauxAssistantMessage(fauxToolCall("apply_context_edit", { replacements }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
				expect(JSON.stringify(context.messages)).toContain("exact verification evidence");
				return fauxAssistantMessage("task complete");
			},
		]);
		await h.session.prompt("execute the inspection tools");
		expect(h.session.getLiveContextStatus()!.revision).toBe(1);
		expect(h.session.getSessionStats().toolCalls).toBe(3);
	});
});
