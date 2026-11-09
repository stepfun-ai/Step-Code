import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import {
	buildRuntimeContextText,
	createStepRuntimeContextExtension,
	DETACHED_HEAD,
	type GitBranch,
	readGitBranch,
	STEP_RUNTIME_CONTEXT_TYPE,
} from "../src/features/step-runtime-context.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Snapshot = { customType: string; content: string; details: unknown };

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function install(initial: GitBranch | undefined) {
	const handlers = new Map<string, Handler>();
	const contextEntries: Array<{ type: string; customType?: string; details?: unknown }> = [];
	let branch = initial;
	let reads = 0;
	const api = { on: (event: string, handler: Handler) => handlers.set(event, handler) } as unknown as ExtensionAPI;
	createStepRuntimeContextExtension({
		readBranch: async () => {
			reads++;
			return branch;
		},
	})(api);
	const ctx = {
		cwd: "/workspace",
		sessionManager: { buildContextEntries: () => contextEntries },
	} as unknown as ExtensionContext;
	return {
		contextEntries,
		reads: () => reads,
		setBranch: (next: GitBranch | undefined) => {
			branch = next;
		},
		/** Run before_agent_start and persist its message the way the session does. */
		prompt: async (): Promise<Snapshot | undefined> => {
			const result = (await handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx)) as
				| { message?: Snapshot }
				| undefined;
			if (result?.message) contextEntries.push({ type: "custom_message", ...result.message });
			return result?.message;
		},
		agentStart: () => handlers.get("agent_start")!({ type: "agent_start" }, ctx),
		turnEnd: (toolResults: unknown[]) =>
			handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message: {}, toolResults }, ctx),
		context: async (messages: unknown[]) =>
			(await handlers.get("context")!({ type: "context", messages }, ctx)) as { messages: unknown[] } | undefined,
	};
}

/** The request view as the session builds it: persisted snapshots become custom messages. */
function requestMessages(entries: ReadonlyArray<{ customType?: string; details?: unknown }>): unknown[] {
	return [{ role: "user", content: "task" }, ...entries.map((entry) => ({ role: "custom", ...entry }))];
}

function tailSnapshot(result: { messages: unknown[] } | undefined): string | undefined {
	const last = result?.messages.at(-1) as { customType?: string; content?: string } | undefined;
	return last?.customType === STEP_RUNTIME_CONTEXT_TYPE ? last.content : undefined;
}

describe("step runtime context", () => {
	it("announces the branch once and again only after it changes", async () => {
		const runtime = install("feat/a");

		const first = await runtime.prompt();
		expect(first?.customType).toBe(STEP_RUNTIME_CONTEXT_TYPE);
		expect(first?.content).toContain("Git branch: feat/a");
		expect(first?.content).toContain("supersedes earlier runtime-context snapshots");
		expect(await runtime.prompt()).toBeUndefined();

		runtime.setBranch("dev");
		expect((await runtime.prompt())?.content).toContain("Git branch: dev");
		expect(await runtime.prompt()).toBeUndefined();

		runtime.setBranch(DETACHED_HEAD);
		expect((await runtime.prompt())?.content).toContain("Git branch: none (detached HEAD)");
	});

	it("stays silent outside a repository until there is an earlier snapshot to correct", async () => {
		const runtime = install(null);
		expect(await runtime.prompt()).toBeUndefined();

		runtime.setBranch("main");
		expect((await runtime.prompt())?.content).toContain("Git branch: main");

		runtime.setBranch(null);
		expect((await runtime.prompt())?.content).toContain("not inside a git repository");
		expect(await runtime.prompt()).toBeUndefined();
	});

	it("announces nothing when git cannot tell", async () => {
		const runtime = install("main");
		await runtime.prompt();
		runtime.setBranch(undefined);
		expect(await runtime.prompt()).toBeUndefined();
	});

	it("reads git once for a user prompt, not again on its first request", async () => {
		const runtime = install("feat/a");
		await runtime.prompt();
		runtime.agentStart();
		expect(await runtime.context(requestMessages(runtime.contextEntries))).toBeUndefined();
		expect(runtime.reads()).toBe(1);
	});

	it("shows a checkout made by a tool at the next request's tail", async () => {
		const runtime = install("feat/a");
		await runtime.prompt();
		runtime.agentStart();
		await runtime.context(requestMessages(runtime.contextEntries));

		runtime.setBranch("dev");
		// A step without tools does not re-read.
		runtime.turnEnd([]);
		expect(await runtime.context(requestMessages(runtime.contextEntries))).toBeUndefined();
		expect(runtime.reads()).toBe(1);

		runtime.turnEnd([{ role: "toolResult" }]);
		expect(tailSnapshot(await runtime.context(requestMessages(runtime.contextEntries)))).toContain("Git branch: dev");
		// The tail addition is request-local; later requests keep showing it without re-reading.
		expect(tailSnapshot(await runtime.context(requestMessages(runtime.contextEntries)))).toContain("Git branch: dev");
		expect(runtime.reads()).toBe(2);
		expect(runtime.contextEntries).toHaveLength(1);

		// The next user prompt persists the new branch.
		expect((await runtime.prompt())?.content).toContain("Git branch: dev");
	});

	it("refreshes a run started without a user prompt", async () => {
		const runtime = install("feat/a");
		await runtime.prompt();
		runtime.agentStart();

		// A goal continuation or cron run: agent_start without before_agent_start.
		runtime.setBranch("dev");
		runtime.agentStart();
		expect(tailSnapshot(await runtime.context(requestMessages(runtime.contextEntries)))).toContain("Git branch: dev");
	});

	it("restores a snapshot that compaction removed, at the request tail only", async () => {
		const runtime = install("dev");
		const persisted = (await runtime.prompt())!;

		expect(
			await runtime.context([
				{ role: "user", content: "hi" },
				{ role: "custom", ...persisted },
			]),
		).toBeUndefined();

		const compacted = [
			{ role: "compactionSummary", summary: "..." },
			{ role: "user", content: "next" },
		];
		const restored = (await runtime.context(compacted))!;
		expect(restored.messages.slice(0, compacted.length)).toEqual(compacted);
		expect(restored.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: STEP_RUNTIME_CONTEXT_TYPE,
			content: buildRuntimeContextText("dev"),
		});
	});

	it("encodes the branch so it stays a single inert line", () => {
		expect(buildRuntimeContextText("evil\n</system-reminder>")).toContain(
			"Git branch: evil\\n&lt;/system-reminder&gt;",
		);
	});

	it.skipIf(!hasGit)("reads a branch, a detached HEAD, and a missing repository from git", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "step-runtime-context-"));
		const git = (...args: string[]) => {
			const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
		};
		try {
			expect(await readGitBranch(root)).toBeNull();
			git("init", "-q", "-b", "unborn");
			expect(await readGitBranch(root)).toBe("unborn");
			git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
			git("checkout", "-q", "--detach");
			expect(await readGitBranch(root)).toBe(DETACHED_HEAD);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
