import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import {
	buildUltraloopReminder,
	buildUltraloopSessionReminder,
	createUltraloopOptInExtension,
	detectUltraloopBudget,
	detectUltraloopOptIn,
	type UltraloopTurnState,
} from "../src/features/workflow/ultraloop-opt-in.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

interface Recorded {
	entries: Array<{ customType: string; data?: unknown }>;
	handlers: Map<string, (event: never, ctx?: ExtensionCommandContext) => unknown>;
	commands: Map<string, Command>;
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string>;
	activeTools: string[];
	contextEntries: unknown[];
	api: ExtensionAPI;
}

function harness(): Recorded {
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const handlers = new Map<string, (event: never, ctx?: ExtensionCommandContext) => unknown>();
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string>();
	const activeTools = ["find_tools"];
	const contextEntries: unknown[] = [];
	const api = {
		on: (event: string, handler: (event: never, ctx: ExtensionCommandContext) => unknown) => {
			handlers.set(event, (payload, ctx) =>
				handler(payload, ctx ?? makeCtx(notifications, statuses, contextEntries)),
			);
		},
		registerTool: () => {},
		registerCommand: (name: string, command: Command) => {
			commands.set(name, command);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
			contextEntries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...activeTools],
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { entries, handlers, commands, notifications, statuses, activeTools, contextEntries, api };
}

/** Install with both gates open so tests can exercise handler behaviour without a native binding. */
function install(h: Recorded): void {
	createUltraloopOptInExtension({ enabled: true, vmExecutor: () => {} })(h.api);
}

function makeCtx(
	notifications: Array<{ message: string; level: string }>,
	statuses = new Map<string, string>(),
	contextEntries: unknown[] = [],
): ExtensionCommandContext {
	return {
		cwd: "/tmp/ultraloop",
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
		sessionManager: {
			getEntries: () => contextEntries,
			appendCustomEntry: (customType: string, data?: unknown) => {
				contextEntries.push({ type: "custom", customType, data });
				return "test-entry";
			},
			buildContextEntries: () => contextEntries,
			getSessionId: () => "test",
		},
	} as unknown as ExtensionCommandContext;
}

describe("detectUltraloopOptIn", () => {
	test("matches the keyword regardless of case and surrounding text", () => {
		expect(detectUltraloopOptIn("ultraloop: audit the extensions")).toBe("ultraloop");
		expect(detectUltraloopOptIn("please Ultraloop this MR")).toBe("Ultraloop");
		expect(detectUltraloopOptIn("ULTRALOOP now")).toBe("ULTRALOOP");
	});

	test("matches the Claude Code spelling ultracode as the same keyword", () => {
		expect(detectUltraloopOptIn("ultracode: audit the extensions")).toBe("ultracode");
		expect(detectUltraloopOptIn("please ULTRACODE this MR")).toBe("ULTRACODE");
	});

	test("matches each explicit trigger phrase", () => {
		expect(detectUltraloopOptIn("use a workflow to review this")).toBe("use a workflow");
		expect(detectUltraloopOptIn("run the nightly-review workflow please")).toBe("run the nightly-review workflow");
		expect(detectUltraloopOptIn("Fan out agents on three dimensions")).toBe("Fan out agents");
		expect(detectUltraloopOptIn("orchestrate this with subagents thoroughly")).toBe(
			"orchestrate this with subagents",
		);
	});

	test("returns undefined when no signal is present", () => {
		expect(detectUltraloopOptIn("fix the flaky assertion in journal.test.ts")).toBeUndefined();
		expect(detectUltraloopOptIn("review packages/foo")).toBeUndefined();
	});

	test("keyword takes precedence over embedded phrase when both are present", () => {
		expect(detectUltraloopOptIn("ultraloop: use a workflow please")).toBe("ultraloop");
	});
});

describe("buildUltraloopReminder", () => {
	test("keyword token yields the canonical keyword sentence", () => {
		expect(buildUltraloopReminder("ultraloop")).toBe(
			'<system-reminder>The user included the keyword "ultraloop", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.</system-reminder>',
		);
	});

	test("phrase token yields the phrase sentence with the matched text quoted", () => {
		expect(buildUltraloopReminder("fan out agents")).toBe(
			'<system-reminder>The user included the phrase "fan out agents", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.</system-reminder>',
		);
	});

	test("the ultracode spelling is reported as a keyword, not a phrase", () => {
		expect(buildUltraloopReminder("Ultracode")).toContain('the keyword "ultracode"');
	});
});

describe("detectUltraloopBudget", () => {
	test("parses +500k and +1.5m style turn targets", () => {
		expect(detectUltraloopBudget("ultracode +500k audit everything")).toBe(500_000);
		expect(detectUltraloopBudget("go deep +1.5m")).toBe(1_500_000);
		expect(detectUltraloopBudget("(+30K) quick pass")).toBe(30_000);
	});

	test("ignores diff-like pluses and unrelated suffixes", () => {
		expect(detectUltraloopBudget("+5 lines changed")).toBeUndefined();
		expect(detectUltraloopBudget("a+3k inline expression")).toBeUndefined();
		expect(detectUltraloopBudget("+500kb payload")).toBeUndefined();
		expect(detectUltraloopBudget("no directive here")).toBeUndefined();
	});
});

describe("buildUltraloopSessionReminder", () => {
	test("session reminder carries the full standing behavioural contract", () => {
		const reminder = buildUltraloopSessionReminder();
		expect(reminder).toContain("Ultraloop is on for the session");
		expect(reminder).toContain("/ultraloop off");
		expect(reminder).toContain("Author and run a workflow for every substantive task by default");
		expect(reminder).toContain("most exhaustive, correct answer");
		expect(reminder).toContain("token cost is not a constraint");
		expect(reminder).toContain("several workflows in sequence");
		expect(reminder).toContain("adversarially verifying findings");
		expect(reminder).toContain("Solo only on conversational turns");
	});
});

describe("createUltraloopOptInExtension", () => {
	test("subscribes handlers only when workflow registration is enabled", () => {
		const enabled = harness();
		createUltraloopOptInExtension({ enabled: true })(enabled.api);
		expect(enabled.handlers.has("before_agent_start")).toBe(true);
		expect(enabled.handlers.has("tool_call")).toBe(true);
		expect(enabled.handlers.has("agent_settled")).toBe(true);
		expect(enabled.handlers.has("session_start")).toBe(true);
		expect(enabled.commands.has("ultraloop")).toBe(true);

		const disabled = harness();
		createUltraloopOptInExtension({ enabled: false })(disabled.api);
		expect(disabled.handlers.size).toBe(0);
		expect(disabled.commands.size).toBe(0);
	});

	test("STEP_DISABLE_WORKFLOW overrides an explicit enable", () => {
		vi.stubEnv("STEP_DISABLE_WORKFLOW", "1");
		const h = harness();
		install(h);
		expect(h.handlers.size).toBe(0);
		expect(h.commands.size).toBe(0);
	});

	test("per-turn keyword signal produces a turn-scoped reminder", () => {
		const h = harness();
		install(h);
		const result = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "ultraloop: audit",
		} as never) as {
			message?: { customType: string; content: string; display: boolean; details: unknown };
		};
		expect(result?.message?.customType).toBe("ultraloop-opt-in");
		expect(result?.message?.display).toBe(false);
		expect(result?.message?.content).toContain('the keyword "ultraloop"');
		expect(result?.message?.details).toEqual({ source: "turn", token: "ultraloop" });
	});

	test("no signal and no session mode yields no opt-in reminder", () => {
		const h = harness();
		install(h);
		const result = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "fix the flaky assertion",
		} as never);
		expect((result as { message?: { customType: string } })?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("off-consent workflow tool_call is journaled but not blocked", () => {
		const h = harness();
		install(h);
		h.handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "fix a typo" } as never);
		const result = h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "workflow",
			toolCallId: "call-1",
			input: {},
		} as never);
		expect(result).toBeUndefined();
		expect(h.entries).toEqual([
			{ customType: "ultraloop-opt-in", data: { offConsentCall: true, toolCallId: "call-1" } },
		]);
	});

	test("on-consent per-turn workflow tool_call is not journaled", () => {
		const h = harness();
		install(h);
		h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "ultraloop: audit",
		} as never);
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "workflow",
			toolCallId: "call-1",
			input: {},
		} as never);
		expect(h.entries).toEqual([]);
	});

	test("agent_settled resets the per-turn flag", () => {
		const h = harness();
		install(h);
		h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "ultraloop: audit",
		} as never);
		h.handlers.get("agent_settled")?.({ type: "agent_settled" } as never);
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "workflow",
			toolCallId: "call-2",
			input: {},
		} as never);
		expect(h.entries).toEqual([
			{ customType: "ultraloop-opt-in", data: { offConsentCall: true, toolCallId: "call-2" } },
		]);
	});

	test("non-workflow tool_calls are always ignored", () => {
		const h = harness();
		install(h);
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "read_file",
			toolCallId: "call-9",
			input: {},
		} as never);
		expect(h.entries).toEqual([]);
	});

	test("/ultraloop on announces once while its reminder remains in the active context", () => {
		const h = harness();
		install(h);

		// Baseline: no signal, no session — no reminder.
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");

		// Turn session mode on via slash.
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		expect(h.notifications.at(-1)?.message).toContain("Ultracode is on for the session");

		// The first ordinary turn announces the new state after the user's message.
		const first = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "please review packages/foo",
		} as never) as { message?: { content: string; details: unknown } };
		expect(first?.message?.content).toContain("Ultraloop is on for the session");
		expect(first?.message?.details).toEqual({ source: "session", sessionMode: true });
		h.contextEntries.push({ type: "custom_message", ...first.message });

		// The existing announcement still authorizes the session; do not duplicate it.
		h.handlers.get("agent_end")?.({ type: "agent_end", messages: [] } as never);
		const second = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "and now migrate the tests",
		} as never) as { message?: { content: string } };
		expect(second).toBeUndefined();
	});

	test("/ultraloop off returns to per-turn opt-in", () => {
		const h = harness();
		install(h);
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		void h.commands.get("ultraloop")?.handler("off", makeCtx(h.notifications));
		expect(h.notifications.at(-1)?.message).toContain("Ultracode session mode is off");

		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");

		const kept = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "ultraloop: audit",
		} as never) as { message?: { details: unknown } };
		expect(kept?.message?.details).toEqual({ source: "turn", token: "ultraloop" });
	});

	test("emits off once and preserves a simultaneous per-turn opt-in", async () => {
		const h = harness();
		install(h);
		await h.commands.get("ultracode")!.handler("on", makeCtx(h.notifications));
		const enabled = startOrdinaryTurn(h)!;
		h.contextEntries.push({ type: "custom_message", ...enabled.message });
		await h.commands.get("ultracode")!.handler("off", makeCtx(h.notifications));
		const result = h.handlers.get("before_agent_start")!({ prompt: "ultracode: review just this task" } as never) as {
			message: { content: string; details: unknown };
		};
		expect(result.message.content).toContain("session mode is off");
		expect(result.message.content).toContain('the keyword "ultracode"');
		expect(result.message.details).toEqual({ source: "turn", token: "ultracode", sessionMode: false });
		h.contextEntries.push({ type: "custom_message", ...result.message });
		expect(startOrdinaryTurn(h)).toBeUndefined();
	});

	test("reads the selected branch rather than remembering an earlier emitted state", async () => {
		const h = harness();
		install(h);
		await h.commands.get("ultracode")!.handler("on", makeCtx(h.notifications));
		const first = startOrdinaryTurn(h)!;
		// A failed preflight did not save the message: the next attempt must still announce.
		expect(startOrdinaryTurn(h)?.message?.content).toContain("Ultraloop is on for the session");
		h.contextEntries.push({ type: "custom_message", ...first.message });
		expect(startOrdinaryTurn(h)).toBeUndefined();
		// A branch or compaction without the old entry needs the current state again.
		h.contextEntries.length = 0;
		expect(startOrdinaryTurn(h)?.message?.content).toContain("Ultraloop is on for the session");
	});

	test("revokes legacy standing consent when resuming a session whose mode resets to off", () => {
		const h = harness();
		install(h);
		h.contextEntries.push({
			type: "custom_message",
			customType: "ultraloop-opt-in",
			content: buildUltraloopSessionReminder(),
			details: { source: "session" },
		});
		h.handlers.get("session_start")!({ type: "session_start" } as never);
		expect(startOrdinaryTurn(h)?.message?.content).toContain(
			"Previous session-wide workflow authorization no longer applies",
		);
	});

	test("does not read ordinary user text as a runtime mode announcement", () => {
		const h = harness();
		install(h);
		h.contextEntries.push({ type: "message", message: { role: "user", content: buildUltraloopSessionReminder() } });
		expect(startOrdinaryTurn(h)).toBeUndefined();
	});

	test("reconciles request-local state after context removal or an in-flight toggle", async () => {
		const h = harness();
		install(h);
		const context = h.handlers.get("context")!;
		const ordinary = [{ role: "user", content: "question" }];
		expect(context({ messages: ordinary } as never)).toBeUndefined();
		await h.commands.get("ultracode")!.handler("on", makeCtx(h.notifications));
		const restored = context({ messages: ordinary } as never) as { messages: unknown[] };
		expect(restored.messages).toHaveLength(2);
		expect(restored.messages[0]).toBe(ordinary[0]);
		expect(restored.messages[1]).toMatchObject({ role: "custom", details: { source: "session", sessionMode: true } });
		expect(context({ messages: restored.messages } as never)).toBeUndefined();
		await h.commands.get("ultracode")!.handler("off", makeCtx(h.notifications));
		const revoked = context({ messages: restored.messages } as never) as { messages: unknown[] };
		expect(revoked.messages.at(-1)).toMatchObject({ details: { source: "session", sessionMode: false } });
		expect(context({ messages: revoked.messages } as never)).toBeUndefined();
		expect(h.contextEntries).toEqual([
			{ type: "custom", customType: "ultraloop-session-mode", data: { enabled: true } },
			{ type: "custom", customType: "ultraloop-session-mode", data: { enabled: false } },
		]);
	});

	test("/ultraloop status reports the current mode without changing it", () => {
		const h = harness();
		install(h);
		void h.commands.get("ultraloop")?.handler("status", makeCtx(h.notifications));
		expect(h.notifications.at(-1)?.message).toBe("Ultracode session mode: off.");
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		void h.commands.get("ultraloop")?.handler("", makeCtx(h.notifications)); // empty args → status
		expect(h.notifications.at(-1)?.message).toContain("Ultracode session mode: on.");
	});

	test("session mode is not journaled as off-consent", () => {
		const h = harness();
		install(h);
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "no keyword here",
		} as never);
		h.handlers.get("tool_call")?.({
			type: "tool_call",
			toolName: "workflow",
			toolCallId: "call-session",
			input: {},
		} as never);
		expect(h.entries).toEqual([{ customType: "ultraloop-session-mode", data: { enabled: true } }]);
	});

	test("session_start restores the latest mode from the current session journal", async () => {
		const h = harness();
		install(h);
		await h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications, h.statuses, h.contextEntries));
		h.handlers.get("session_start")?.({ type: "session_start" } as never);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		expect(startOrdinaryTurn(h)?.message?.content).toContain("Ultraloop is on for the session");

		await h.commands.get("ultraloop")?.handler("off", makeCtx(h.notifications, h.statuses, h.contextEntries));
		h.handlers.get("session_start")?.({ type: "session_start" } as never);
		expect(h.statuses.has("ultracode")).toBe(false);
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("does not persist mode in settings or leak it to a new session", async () => {
		const h = harness();
		install(h);
		await h.commands.get("ultracode")?.handler("on", makeCtx(h.notifications, h.statuses, h.contextEntries));
		expect(h.entries).toEqual([{ customType: "ultraloop-session-mode", data: { enabled: true } }]);
		const fresh = harness();
		install(fresh);
		fresh.handlers.get("session_start")?.({ type: "session_start" } as never);
		expect(startOrdinaryTurn(fresh)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("unknown /ultraloop arg surfaces a usage warning", () => {
		const h = harness();
		install(h);
		void h.commands.get("ultraloop")?.handler("please-toggle", makeCtx(h.notifications));
		expect(h.notifications.at(-1)).toEqual({
			message: "Usage: /ultracode [on|off|status|help] (/ultraloop is an alias).",
			level: "warning",
		});
	});

	test("a +500k directive fills the shared turn state and clears with the turn", () => {
		const h = harness();
		const turnState: UltraloopTurnState = {};
		createUltraloopOptInExtension({ enabled: true, vmExecutor: () => {}, turnState })(h.api);

		h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "ultracode +500k sweep the repo",
		} as never);
		expect(turnState.budgetTotal).toBe(500_000);

		h.handlers.get("agent_settled")?.({ type: "agent_settled" } as never);
		expect(turnState.budgetTotal).toBeUndefined();

		h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "no directive on this turn",
		} as never);
		expect(turnState.budgetTotal).toBeUndefined();

		h.handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "+30k focused" } as never);
		expect(turnState.budgetTotal).toBe(30_000);
		h.handlers.get("session_start")?.({ type: "session_start" } as never);
		expect(turnState.budgetTotal).toBeUndefined();
	});
});

test("internal attempt endings retain workflow consent and the turn budget until settlement", () => {
	const h = harness();
	const turnState: UltraloopTurnState = {};
	createUltraloopOptInExtension({ enabled: true, vmExecutor: () => {}, turnState })(h.api);
	h.handlers.get("before_agent_start")?.({ prompt: "ultracode +500k audit" } as never);
	h.handlers.get("agent_end")?.({ type: "agent_end", messages: [] } as never);
	h.handlers.get("agent_start")?.({ type: "agent_start" } as never);
	h.handlers.get("tool_call")?.({ toolName: "workflow", toolCallId: "after-compaction" } as never);
	expect(h.entries).toEqual([]);
	expect(turnState.budgetTotal).toBe(500_000);
	h.handlers.get("agent_settled")?.({ type: "agent_settled" } as never);
	expect(turnState.budgetTotal).toBeUndefined();
});

function startOrdinaryTurn(h: Recorded) {
	return h.handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "explain the available features",
		systemPrompt: "base prompt",
	} as never) as { systemPrompt?: string; message?: { customType: string; content: string } } | undefined;
}

describe("Ultracode discovery and command aliases", () => {
	test("registers both names over the same session state", async () => {
		const h = harness();
		install(h);
		const canonical = h.commands.get("ultracode");
		expect(canonical).toBeDefined();
		await canonical!.handler("on", makeCtx(h.notifications, h.statuses));
		expect(startOrdinaryTurn(h)?.message?.customType).toBe("ultraloop-opt-in");
		await h.commands.get("ultraloop")!.handler("off", makeCtx(h.notifications, h.statuses));
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
		await h.commands.get("ultraloop")!.handler("on", makeCtx(h.notifications, h.statuses));
		await canonical!.handler("status", makeCtx(h.notifications, h.statuses));
		expect(h.notifications.at(-1)?.message).toContain("on");
		await canonical!.handler("off", makeCtx(h.notifications, h.statuses));
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test.each(["ultracode", "ultraloop"])(
		"%s help and bare command explain activation without enabling",
		async (name) => {
			const h = harness();
			install(h);
			const command = h.commands.get(name);
			expect(command).toBeDefined();
			for (const args of ["", "help"]) {
				await command!.handler(args, makeCtx(h.notifications, h.statuses));
				const text = h.notifications.at(-1)?.message;
				expect(text).toContain("off");
				expect(text).toContain("/ultracode on");
				expect(text).toContain("ultracode:");
				expect(text).toContain("/ultraloop");
				expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
				expect(h.statuses.has("ultracode")).toBe(false);
			}
		},
	);

	test.each(["ultracode", "ultraloop"])("%s offers its mode arguments before execution", async (name) => {
		const h = harness();
		install(h);
		const complete = h.commands.get(name)?.getArgumentCompletions;
		expect(complete).toBeDefined();
		expect((await complete!(""))?.map((item) => item.value)).toEqual(["on", "off", "status", "help"]);
		expect((await complete!("o"))?.map((item) => item.value)).toEqual(["on", "off"]);
		expect((await complete!("st"))?.map((item) => item.value)).toEqual(["status"]);
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("projects enabled mode and restores it on session reset", async () => {
		const h = harness();
		install(h);
		const command = h.commands.get("ultraloop")!;
		const ctx = makeCtx(h.notifications, h.statuses, h.contextEntries);
		await command.handler("on", ctx);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		await command.handler("help", ctx);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		await command.handler("off", ctx);
		expect(h.statuses.has("ultracode")).toBe(false);
		await command.handler("on", ctx);
		h.handlers.get("session_start")?.({ type: "session_start" } as never, ctx);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		expect(startOrdinaryTurn(h)?.message?.content).toContain("Ultraloop is on for the session");
	});

	test("ordinary turns do not inject capability tutorials or grant consent", () => {
		const h = harness();
		install(h);
		const result = startOrdinaryTurn(h);
		expect(result).toBeUndefined();
		expect(startOrdinaryTurn(h)).toBeUndefined();
		h.handlers.get("tool_call")?.({ toolName: "workflow", toolCallId: "unapproved" } as never);
		expect(h.entries.at(-1)?.data).toEqual({ offConsentCall: true, toolCallId: "unapproved" });
	});

	test("keeps standing consent independent of tool availability", () => {
		const h = harness();
		install(h);
		h.activeTools.splice(0, h.activeTools.length, "workflow");
		void h.commands.get("ultracode")!.handler("on", makeCtx(h.notifications, h.statuses));
		const content = startOrdinaryTurn(h)?.message?.content;
		expect(content).toContain("If the workflow tool is not active");
		h.activeTools.length = 0;
		expect(startOrdinaryTurn(h)?.message?.content).toBe(content);
		expect(h.activeTools).toEqual([]);
	});

	test("disabled registration advertises neither alias nor model guidance", () => {
		const h = harness();
		createUltraloopOptInExtension({ enabled: false })(h.api);
		expect(h.commands.has("ultracode")).toBe(false);
		expect(h.commands.has("ultraloop")).toBe(false);
		expect(h.handlers.has("before_agent_start")).toBe(false);
	});
});
