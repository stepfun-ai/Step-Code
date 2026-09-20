import { visibleWidth } from "@step-harness/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../packages/coding-agent/src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/ui/view/chrome/footer.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	approvalMode?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode }),
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount: number,
	extensionStatuses: ReadonlyMap<string, string> = new Map<string, string>(),
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$0.000 (sub)");
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});

	it("renders the compact Step footer with a right-aligned context readout", () => {
		const session = createSession({
			sessionName: "",
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData(1), {
			presentation: "step",
		});

		const [line = ""] = footer.render(120);
		const plain = stripAnsi(line);
		expect(plain).toContain("⏵ Ask");
		expect(plain).toContain("test-model");
		expect(plain).toContain("high");
		expect(plain).toContain("88% context left");
		expect(visibleWidth(line)).toBe(120);
	});

	it("does not scan token totals or invent unknown context usage in the Step footer", () => {
		const session = createSession({ sessionName: "" });
		const entries = vi.spyOn(session.sessionManager, "getEntries");
		const footer = new FooterComponent(session, createFooterData(1), { presentation: "step" });
		expect(stripAnsi(footer.render(120)[0])).toMatch(/88% context left$/u);
		vi.spyOn(session, "getContextUsage").mockReturnValue(undefined);
		const unknown = stripAnsi(footer.render(120)[0]);
		expect(unknown).not.toContain("context left");
		expect(unknown).not.toContain(" tok");
		expect(entries).not.toHaveBeenCalled();
	});

	// Feedback issue-b39a464025061aa5: the footer named the permission mode but
	// never said that Shift+Tab changes it.
	it("advertises the permission cycle key next to the mode", () => {
		const session = createSession({ sessionName: "", approvalMode: "auto" });
		const footer = new FooterComponent(session, createFooterData(1), {
			presentation: "step",
			permissionCycleKey: () => "shift+tab",
		});

		const plain = stripAnsi(footer.render(120)[0] ?? "");
		expect(plain.startsWith("⏵ Bypass (shift+tab)")).toBe(true);
	});

	it("omits the permission cycle key on a narrow terminal", () => {
		const session = createSession({ sessionName: "", approvalMode: "auto" });
		const footer = new FooterComponent(session, createFooterData(1), {
			presentation: "step",
			permissionCycleKey: () => "shift+tab",
		});

		const plain = stripAnsi(footer.render(50)[0] ?? "");
		expect(plain).not.toContain("shift+tab");
		expect(plain).toContain("⏵ Bypass");
	});

	it("omits the permission cycle key when the session has no cycle", () => {
		const session = createSession({ sessionName: "", approvalMode: "auto" });
		const footer = new FooterComponent(session, createFooterData(1), { presentation: "step" });

		expect(stripAnsi(footer.render(120)[0] ?? "")).not.toContain("shift+tab");
	});

	it("renders the read-only permission status instead of falling back to ask", () => {
		const session = createSession({ sessionName: "", approvalMode: "strict" });
		const footer = new FooterComponent(
			session,
			createFooterData(1, new Map([["step-permission", "Mode: Read Only"]])),
			{ presentation: "step" },
		);

		const [line = ""] = footer.render(120);
		const plain = stripAnsi(line);
		expect(plain.startsWith("⏵ Read-only")).toBe(true);
		expect(plain.startsWith("⏵ Ask")).toBe(false);
		expect(plain).not.toContain("Mode: Read Only");
	});

	it("does not duplicate the permission status while retaining other statuses", () => {
		const session = createSession({ sessionName: "", approvalMode: "auto" });
		const footer = new FooterComponent(
			session,
			createFooterData(
				1,
				new Map([
					["step-permission", "Mode: Autopilot (auto-resume)"],
					["plan-mode", "plan 1/2"],
				]),
			),
			{ presentation: "step" },
		);

		const [line = ""] = footer.render(120);
		const plain = stripAnsi(line);
		expect(plain.startsWith("⏵ Autopilot")).toBe(true);
		expect(plain).not.toContain("Mode: Autopilot");
		expect(plain).toContain("plan 1/2");
	});

	it("keeps the Step footer within narrow widths", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1), {
			presentation: "step",
		});
		for (const width of [1, 20, 59, 79, 99]) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
