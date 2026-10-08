import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeHost } from "../../src/core/agent-session-runtime.ts";
import * as output from "../../src/core/output-guard.ts";
import { createStepPlanExtension } from "../../src/features/step-plan.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { readStepConfig, resolveStepConfigPath } from "../../src/step/config-toml.ts";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const roots: string[] = [];
let stdout = "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function setup(external: boolean) {
	const storage = mkdtempSync(join(tmpdir(), "step-plan-storage-"));
	roots.push(storage);
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				// Step file tools take their working directory from the real session context.
				for (const tool of createStepToolProfile(process.cwd(), { agentDir: join(storage, "agent") })) {
					if (["read_file", "write_file", "edit_file"].includes(tool.name)) pi.registerTool(tool);
				}
			},
			createStepPlanExtension(),
		],
	});
	harnesses.push(harness);
	const cwd = harness.tempDir;
	// Reuse existing history without creating commits; sparse checkout keeps the
	// fixture small. Git still reads .gitignore from its index, so the project
	// override below uses a directory that this repository does not ignore.
	const source = fileURLToPath(new URL("../../../../", import.meta.url));
	git(cwd, "clone", "--quiet", "--shared", "--no-checkout", "--template=", source, ".");
	git(cwd, "config", "core.excludesFile", join(cwd, ".git", "info", "exclude"));
	git(cwd, "sparse-checkout", "set", "--no-cone", "/package.json");
	git(cwd, "checkout", "--quiet", "--detach", "HEAD");
	expect(git(cwd, "status", "--porcelain")).toBe("");
	expect(existsSync(join(cwd, ".gitignore"))).toBe(false);

	const planDir = external ? join(storage, "runtime plans") : join(cwd, "runtime-plans");
	vi.stubEnv("STEP_CODING_AGENT_PLAN_DIR", planDir);
	const planPath = join(planDir, `session-${harness.session.sessionId}.md`);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("enter_plan_mode", {})]),
		fauxAssistantMessage([
			fauxToolCall("write_file", { path: planPath, content: "# Proposal\nCheck the parser.\n" }),
		]),
		fauxAssistantMessage([
			fauxToolCall("edit_file", {
				path: planPath,
				search: "Check the parser.",
				replace: "Check the parser and tests.",
			}),
		]),
		fauxAssistantMessage([fauxToolCall("exit_plan_mode", {})]),
		fauxAssistantMessage("Done."),
		fauxAssistantMessage("Done."),
	]);
	const host = {
		session: harness.session,
		cwd,
		setRebindSession: vi.fn<AgentSessionRuntimeHost["setRebindSession"]>(),
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		dispose: async () => {
			await harness.session.abort();
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			harness.session.dispose();
		},
	};
	const run = () =>
		runPrintMode(host as unknown as AgentSessionRuntimeHost, {
			mode: "json",
			initialMessage: "Plan the change, implement it, and finish with committed work.",
			completionCheck: "git-committed",
			completionCheckAttempts: 1,
		});
	return { harness, cwd, planPath, run };
}

beforeEach(() => {
	stdout = "";
	initTheme("dark");
	vi.spyOn(output, "writeRawStdout").mockImplementation((chunk) => {
		stdout += chunk;
	});
	vi.spyOn(output, "waitForRawStdoutBackpressure").mockResolvedValue();
	vi.spyOn(output, "flushRawStdout").mockResolvedValue();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

test.each([false, true])(
	"native planning keeps Git completion sensitive to plan location (external: %s)",
	async (external) => {
		const { harness, cwd, planPath, run } = await setup(external);
		expect(await run()).toBe(0);
		const tools = harness.eventsOfType("tool_execution_end");
		expect(tools.map((event) => [event.toolName, event.isError])).toEqual([
			["enter_plan_mode", false],
			["write_file", false],
			["edit_file", false],
			["exit_plan_mode", false],
		]);
		expect(getMessageText(tools[0].result)).toContain(planPath);
		expect(getMessageText(tools[3].result)).toContain("caller must gate approval externally");
		expect(getMessageText(tools[3].result)).toContain("Check the parser and tests.");
		expect(readFileSync(planPath, "utf8")).toBe("# Proposal\nCheck the parser and tests.\n");
		expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
		// Physical absence catches accidental project writes even if Git ignores them.
		expect(existsSync(join(cwd, ".stepcode"))).toBe(false);
		const checks = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((event) => event.type === "completion_check");
		// The checkout already has committed work; this fixture makes no new commit.
		// The check must still require one, including when external plans keep it clean.
		expect(checks[0]).toMatchObject({
			hasNewCommit: false,
			hasCommittedChanges: false,
			trackedDirty: false,
			untrackedFiles: !external,
			hasFinalText: true,
			status: "follow_up",
			willFollowUp: true,
		});
		expect(checks).toHaveLength(2);
		expect(checks[1]).toMatchObject({ status: "exhausted", untrackedFiles: !external });
		expect(getUserTexts(harness)[1]).toContain("no new commit since the starting HEAD");
		if (external) {
			expect(git(cwd, "status", "--porcelain")).toBe("");
			expect(getUserTexts(harness)[1]).not.toContain("unignored untracked files remain");
		} else {
			expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe(
				`?? runtime-plans/session-${harness.session.sessionId}.md\n`,
			);
			expect(getUserTexts(harness)[1]).toContain("unignored untracked files remain");
		}
	},
);

test("external planning preserves project settings, tracked plans and untracked user files", async () => {
	const { harness, cwd, planPath, run } = await setup(true);
	git(cwd, "sparse-checkout", "set", "--no-cone", "/package.json", "/.stepcode/");
	const oldPlanPath = join(cwd, ".stepcode", "plans", `session-${harness.session.sessionId}.md`);
	const configPath = join(cwd, ".stepcode", "config.toml");
	const userPath = join(cwd, "user-notes.md");
	mkdirSync(join(cwd, ".stepcode", "plans"), { recursive: true });
	writeFileSync(configPath, '# Keep project settings\ntheme = "step-blue"\n');
	writeFileSync(oldPlanPath, "A user-maintained plan.\n");
	writeFileSync(userPath, "Untracked user notes.\n");
	git(
		cwd,
		"add",
		"--sparse",
		"--force",
		".stepcode/config.toml",
		`.stepcode/plans/session-${harness.session.sessionId}.md`,
	);
	const before = git(cwd, "status", "--porcelain", "--untracked-files=all");
	const trackedBefore = git(cwd, "ls-files", "--stage", "--", ".stepcode");

	expect(await run()).toBe(0);
	expect(readFileSync(planPath, "utf8")).toContain("Check the parser and tests.");
	expect(readFileSync(configPath, "utf8")).toBe('# Keep project settings\ntheme = "step-blue"\n');
	expect(readFileSync(oldPlanPath, "utf8")).toBe("A user-maintained plan.\n");
	expect(readFileSync(userPath, "utf8")).toBe("Untracked user notes.\n");
	expect(resolveStepConfigPath(process.env, cwd)).toBe(configPath);
	expect(readStepConfig(configPath)).toEqual({ theme: "step-blue" });
	expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe(before);
	expect(git(cwd, "ls-files", "--stage", "--", ".stepcode")).toBe(trackedBefore);
	expect(getUserTexts(harness)[1]).toContain("tracked changes remain");
	expect(getUserTexts(harness)[1]).toContain("unignored untracked files remain");
	expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
});
