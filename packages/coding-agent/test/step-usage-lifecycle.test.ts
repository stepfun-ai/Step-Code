import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { PlanUsageController } from "../src/step/usage/account.ts";
import { registerStepUsageCommands, type StepUsageHost } from "../src/step/usage/commands.ts";
import type { UsageOverview, UsagePresentation } from "../src/step/usage/types.ts";

const empty: UsageOverview = {
	days: [{ date: "2026-10-13", tokens: 0, chats: 0 }],
	tokens: 0,
	chats: 0,
	activeDays: 0,
	reasoning: [],
	discoveredSkills: null,
	usedSkills: null,
	topResources: [],
	limited: [],
	scope: "all",
};
function fixture() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const entries: Record<string, unknown>[] = [];
	let sessionId = "first";
	const ctx = {
		mode: "tui",
		cwd: "/work",
		model: { id: "step-model", provider: "step", baseUrl: "https://api.stepfun.com/v1" },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 10, contextWindow: 100 }),
		getSystemPromptOptions: () => ({}),
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
		ui: { notify: vi.fn() },
	} as unknown as ExtensionCommandContext;
	const pi = {
		on: (event: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const previous = handlers.get(event);
			handlers.set(event, async (value, context) => {
				await previous?.(value, context);
				return callback(value, context);
			});
		},
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	const account = new PlanUsageController(() => ({
		identity: "signed-out",
		projection: { presence: "missing", eligible: false, source: "none", reason: "Sign in" },
	}));
	let presentation!: UsagePresentation;
	let finish!: () => void;
	const host: StepUsageHost = {
		account,
		resources: () => ({ agents: ["/work/AGENTS.md"], skills: [] }),
		scan: vi.fn().mockResolvedValue(empty),
		present: (_ctx, model) => {
			presentation = model;
			return new Promise<void>((resolve) => {
				finish = resolve;
				model.onClose = resolve;
			});
		},
		output: vi.fn(),
	};
	const commands = registerStepUsageCommands(pi, host, () => "Ask");
	return {
		ctx,
		commands,
		host,
		handlers,
		entries,
		pi,
		presentation: () => presentation,
		finish: () => finish(),
		changeSession: () => {
			sessionId = "second";
		},
	};
}

describe("usage command lifecycle", () => {
	it("captures actual local status without querying the account or scanning files", async () => {
		const f = fixture(),
			query = vi.spyOn(f.host.account, "query");
		const pending = f.commands.status("", f.ctx);
		expect(f.presentation().status).toMatchObject({
			permissions: "Ask",
			session: "first",
			agents: ["/work/AGENTS.md"],
			reasoning: "high",
		});
		expect(query).not.toHaveBeenCalled();
		expect(f.host.scan).not.toHaveBeenCalled();
		f.finish();
		await pending;
	});
	it("rejects retired commands before creating UI or starting requests", async () => {
		const f = fixture();
		await f.commands.usage("history", f.ctx);
		expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("overview|account"), "warning");
		expect(f.host.scan).not.toHaveBeenCalled();
	});
	it("closes the old view on session replacement and suppresses a late scan result", async () => {
		const f = fixture();
		let resolve!: (value: UsageOverview) => void;
		f.host.scan = vi.fn().mockImplementation(
			() =>
				new Promise<UsageOverview>((done) => {
					resolve = done;
				}),
		);
		const pending = f.commands.usage("", f.ctx),
			model = f.presentation();
		f.changeSession();
		await f.handlers.get("session_start")!({}, f.ctx);
		await pending;
		resolve(empty);
		await Promise.resolve();
		expect(model.overview).toBeUndefined();
		expect(model.status.session).toBe("first");
	});
	it("cancels old tab scans, only publishes the selected scope, and updates main-session totals", async () => {
		const f = fixture();
		const resolvers: ((v: UsageOverview) => void)[] = [];
		f.host.scan = vi.fn().mockImplementation(() => new Promise<UsageOverview>((r) => resolvers.push(r)));
		const pending = f.commands.usage("", f.ctx),
			model = f.presentation();
		model.selectScope("project");
		resolvers[0]({ ...empty, tokens: 999 });
		resolvers[1]({ ...empty, scope: "project", tokens: 42 });
		await Promise.resolve();
		expect(model.overview?.tokens).toBe(42);
		expect(model.overview?.scope).toBe("project");
		model.select("account");
		f.entries.push({
			type: "message",
			message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 } },
		});
		await f.handlers.get("agent_end")!({}, f.ctx);
		expect(model.session.total).toBe(15);
		f.finish();
		await pending;
	});
	it("keeps recorder hooks and command teardown active in the same session lifecycle", async () => {
		const f = fixture();
		let replacing = false,
			closed = false;
		f.host.resources = () => {
			if (replacing) expect(closed).toBe(true);
			return { agents: [], skills: [{ name: "example", filePath: "/work/SKILL.md" }] };
		};
		await f.handlers.get("session_start")!({}, f.ctx);
		await f.handlers.get("before_agent_start")!({}, f.ctx);
		expect(f.pi.appendEntry).toHaveBeenCalledWith(
			"step.activity_capabilities",
			expect.objectContaining({ sessionId: "first" }),
		);
		expect(vi.mocked(f.pi.appendEntry).mock.calls.filter(([type]) => type === "step.activity")).toHaveLength(1);
		const pending = f.commands.usage("account", f.ctx);
		const close = f.presentation().onClose;
		f.presentation().onClose = () => {
			closed = true;
			close?.();
		};
		replacing = true;
		f.changeSession();
		await f.handlers.get("session_start")!({}, f.ctx);
		await pending;
		expect(f.pi.appendEntry).toHaveBeenCalledWith(
			"step.activity_capabilities",
			expect.objectContaining({ sessionId: "second" }),
		);
		expect(vi.mocked(f.pi.appendEntry).mock.calls.filter(([type]) => type === "step.activity")).toHaveLength(2);
	});

	it("uses the explicit RPC sink and does not send command output as an assistant message", async () => {
		const f = fixture();
		const rpc = { ...f.ctx, mode: "rpc" } as ExtensionCommandContext;
		await f.commands.usage("overview", rpc);
		expect(f.host.output).toHaveBeenCalledWith(rpc, expect.objectContaining({ overview: empty }));
		expect(f.pi.appendEntry).not.toHaveBeenCalled();
	});
});
