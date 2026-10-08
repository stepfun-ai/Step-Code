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
	api: ExtensionAPI;
}

function harness(): Recorded {
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const handlers = new Map<string, (event: never, ctx?: ExtensionCommandContext) => unknown>();
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string>();
	const activeTools = ["find_tools"];
	const api = {
		on: (event: string, handler: (event: never, ctx: ExtensionCommandContext) => unknown) => {
			handlers.set(event, (payload, ctx) => handler(payload, ctx ?? makeCtx(notifications, statuses)));
		},
		registerTool: () => {},
		registerCommand: (name: string, command: Command) => {
			commands.set(name, command);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		getActiveTools: () => [...activeTools],
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { entries, handlers, commands, notifications, statuses, activeTools, api };
}

/** Install with both gates open so tests can exercise handler behaviour without a native binding. */
function install(h: Recorded): void {
	createUltraloopOptInExtension({ enabled: true, vmExecutor: () => {} })(h.api);
}

function makeCtx(
	notifications: Array<{ message: string; level: string }>,
	statuses = new Map<string, string>(),
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
		sessionManager: { getEntries: () => [], getSessionId: () => "test" },
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

	test("/ultraloop on enables session-standing reminder every turn", () => {
		const h = harness();
		install(h);

		// Baseline: no signal, no session — no reminder.
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");

		// Turn session mode on via slash.
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		expect(h.notifications.at(-1)?.message).toContain("Ultracode is on for the session");

		// Any subsequent turn — even without a keyword — produces the session reminder.
		const first = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "please review packages/foo",
		} as never) as { message?: { content: string; details: unknown } };
		expect(first?.message?.content).toContain("Ultraloop is on for the session");
		expect(first?.message?.details).toEqual({ source: "session" });

		// Standing reminder repeats across turns; agent_end does not reset session mode.
		h.handlers.get("agent_end")?.({ type: "agent_end", messages: [] } as never);
		const second = h.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "and now migrate the tests",
		} as never) as { message?: { content: string } };
		expect(second?.message?.content).toContain("Ultraloop is on for the session");
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
		expect(h.entries).toEqual([]);
	});

	test("session_start resets session-standing mode", () => {
		const h = harness();
		install(h);
		void h.commands.get("ultraloop")?.handler("on", makeCtx(h.notifications));
		// Simulate new session boundary.
		h.handlers.get("session_start")?.({ type: "session_start" } as never);
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
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

	test("projects enabled mode and clears it on disable and session reset", async () => {
		const h = harness();
		install(h);
		const command = h.commands.get("ultraloop")!;
		const ctx = makeCtx(h.notifications, h.statuses);
		await command.handler("on", ctx);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		await command.handler("help", ctx);
		expect(h.statuses.get("ultracode")).toBe("Ultracode on");
		await command.handler("off", ctx);
		expect(h.statuses.has("ultracode")).toBe(false);
		await command.handler("on", ctx);
		h.handlers.get("session_start")?.({ type: "session_start" } as never, ctx);
		expect(h.statuses.has("ultracode")).toBe(false);
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("explains mode and tool availability without granting consent or replacing the system prompt", () => {
		const h = harness();
		install(h);
		const result = startOrdinaryTurn(h);
		expect(result?.message?.customType).toBe("ultraloop-discovery");
		expect(result?.message?.content).toContain("Ultracode");
		expect(result?.message?.content).toContain("Ultraloop");
		expect(result?.message?.content).toContain("/ultracode on");
		expect(result?.message?.content).toContain("Current session mode: off");
		expect(result?.message?.content).toContain("tool profile");
		expect(result?.message?.content).not.toContain("To load the workflow tool");
		expect(result?.message?.content).toContain("workflow");
		expect(result?.message?.content).toContain("not consent");
		expect(result).not.toHaveProperty("systemPrompt");
		h.handlers.get("tool_call")?.({ toolName: "workflow", toolCallId: "unapproved" } as never);
		expect(h.entries.at(-1)?.data).toEqual({ offConsentCall: true, toolCallId: "unapproved" });
	});

	test("describes active or unavailable tools accurately", () => {
		const h = harness();
		install(h);
		h.activeTools.splice(0, h.activeTools.length, "workflow");
		expect(startOrdinaryTurn(h)?.message?.content).toContain("workflow");
		expect(startOrdinaryTurn(h)?.message?.content).not.toContain("find_tools");
		h.activeTools.length = 0;
		expect(startOrdinaryTurn(h)?.message?.content).toContain("not active");
		expect(startOrdinaryTurn(h)?.message?.customType).not.toBe("ultraloop-opt-in");
	});

	test("disabled registration advertises neither alias nor model guidance", () => {
		const h = harness();
		createUltraloopOptInExtension({ enabled: false })(h.api);
		expect(h.commands.has("ultracode")).toBe(false);
		expect(h.commands.has("ultraloop")).toBe(false);
		expect(h.handlers.has("before_agent_start")).toBe(false);
	});
});
