import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, type ImageContent } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeHost } from "../../src/core/agent-session-runtime.ts";
import * as output from "../../src/core/output-guard.ts";
import { type PrintModeOptions, runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
let stdout = "";

function getCompletionEvents(): Record<string, unknown>[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === "completion_check");
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Completion Test",
			"-c",
			"user.email=completion@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
	);
}

function commitTask(harness: Harness): void {
	writeFileSync(join(harness.tempDir, "source.txt"), "completed task\n");
	git(harness.tempDir, "add", "source.txt");
	git(harness.tempDir, "commit", "--quiet", "-m", "task change");
}

async function setup(options: HarnessOptions = {}, repository = true) {
	const harness = await createHarness({
		...options,
		settings: { compaction: { enabled: false }, retry: { enabled: false }, ...options.settings },
	});
	harnesses.push(harness);
	if (repository) {
		git(harness.tempDir, "init", "--quiet", "--template=");
		writeFileSync(join(harness.tempDir, "source.txt"), "base\n");
		git(harness.tempDir, "add", "source.txt");
		git(harness.tempDir, "commit", "--quiet", "-m", "base");
	}
	// The session, agent loop, provider, extension runner, and Git reads are real.
	// Only host replacement/disposal and process output are test doubles.
	const host = {
		session: harness.session,
		cwd: harness.tempDir,
		setRebindSession: vi.fn<AgentSessionRuntimeHost["setRebindSession"]>(),
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		dispose: vi.fn(async () => {
			await host.session.abort();
			await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			host.session.dispose();
		}),
	};
	const run = (options: Partial<PrintModeOptions> = {}) =>
		runPrintMode(host as unknown as AgentSessionRuntimeHost, {
			mode: "text",
			initialMessage: "Complete the task and commit the changes.",
			completionCheck: "git-committed",
			...options,
		});
	return { harness, host, run };
}

beforeEach(() => {
	stdout = "";
	vi.spyOn(output, "writeRawStdout").mockImplementation((chunk) => {
		stdout += chunk;
	});
	vi.spyOn(output, "waitForRawStdoutBackpressure").mockResolvedValue();
	vi.spyOn(output, "flushRawStdout").mockResolvedValue();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

describe("runPrintMode same-session completion check", () => {
	it("continues dirty work in the same session and emits only the final answer", async () => {
		const { harness, host, run } = await setup();
		const sessionId = harness.session.sessionId;
		const prompt = vi.spyOn(harness.session, "prompt");
		harness.setResponses([
			() => {
				writeFileSync(join(harness.tempDir, "source.txt"), "unfinished task\n");
				return fauxAssistantMessage("premature answer");
			},
			(context) => {
				expect(context.messages.some((message) => message.role === "assistant")).toBe(true);
				commitTask(harness);
				return fauxAssistantMessage("committed and verified");
			},
		]);
		expect(await run()).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.sessionId).toBe(sessionId);
		expect(getUserTexts(harness)[1]).toContain("tracked changes remain");
		expect(prompt.mock.calls[1]?.[1]).toEqual({ expandPromptTemplates: false });
		expect(host.newSession).not.toHaveBeenCalled();
		expect(host.fork).not.toHaveBeenCalled();
		expect(host.switchSession).not.toHaveBeenCalled();
		expect(host.dispose).toHaveBeenCalledTimes(1);
		expect(stdout).toBe("committed and verified\n");
		expect(git(harness.tempDir, "status", "--porcelain")).toBe("");
	});

	it.each(["text", "json"] as const)("adds no model calls for a clean committed result in %s mode", async (mode) => {
		const { harness, run } = await setup();
		harness.setResponses([
			() => {
				commitTask(harness);
				return fauxAssistantMessage("done");
			},
		]);
		expect(await run({ mode })).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toHaveLength(1);
		if (mode === "json") {
			const events = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.filter((event) => event.type === "completion_check")).toEqual([
				{
					type: "completion_check",
					check: "git-committed",
					attempt: 0,
					maxAttempts: 2,
					hasNewCommit: true,
					hasCommittedChanges: true,
					trackedDirty: false,
					untrackedFiles: false,
					hasFinalText: true,
					status: "passed",
					willFollowUp: false,
				},
			]);
		}
	});

	it("requires a new commit even when the worktree is already clean", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			fauxAssistantMessage("nothing committed yet"),
			() => {
				commitTask(harness);
				return fauxAssistantMessage("done");
			},
		]);
		expect(await run()).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)[1]).toContain("no new commit since the starting HEAD");
	});

	it.each(["empty commit", "full revert"])("does not accept a clean tree after %s", async (kind) => {
		const { harness, run } = await setup();
		harness.setResponses([
			() => {
				if (kind === "empty commit") git(harness.tempDir, "commit", "--quiet", "--allow-empty", "-m", "empty");
				else {
					commitTask(harness);
					git(harness.tempDir, "revert", "--no-edit", "HEAD");
				}
				return fauxAssistantMessage("task is still incomplete");
			},
			fauxAssistantMessage("still incomplete"),
			fauxAssistantMessage("unable to finish"),
			fauxAssistantMessage("must not be used"),
		]);
		expect(await run({ mode: "json" })).toBe(0);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)[1]).toContain("no committed tree changes from the starting HEAD");
		const checks = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((event) => event.type === "completion_check");
		expect(checks).toHaveLength(3);
		for (const check of checks)
			expect(check).toMatchObject({ hasNewCommit: true, hasCommittedChanges: false, trackedDirty: false });
		expect(checks[2].status).toBe("exhausted");
	});

	it("preserves extra user messages and initial images before checking completion", async () => {
		const { harness, run } = await setup();
		const prompt = vi.spyOn(harness.session, "prompt");
		const messages = ["Also check the edge case.", "Include the test result in the final answer."];
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
			() => {
				commitTask(harness);
				return fauxAssistantMessage("final");
			},
		]);
		expect(await run({ initialMessage: "initial task", initialImages: images, messages })).toBe(0);
		expect(getUserTexts(harness).slice(0, 3)).toEqual(["initial task", ...messages]);
		expect(prompt.mock.calls[0]).toEqual(["initial task", { images }]);
		expect(prompt.mock.calls[1]).toEqual([messages[0]]);
		expect(prompt.mock.calls[2]).toEqual([messages[1]]);
		expect(messages).toEqual(["Also check the edge case.", "Include the test result in the final answer."]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(stdout).toBe("final\n");
	});

	it.each([1, 2, 3])("ends a valid failed task normally after %i follow-ups without resampling", async (attempts) => {
		const { harness, host, run } = await setup();
		harness.setResponses(Array.from({ length: attempts + 2 }, () => fauxAssistantMessage("Unable to finish.")));
		expect(await run({ completionCheckAttempts: attempts })).toBe(0);
		expect(harness.faux.state.callCount).toBe(attempts + 1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).toHaveLength(attempts + 1);
		expect(host.newSession).not.toHaveBeenCalled();
		expect(stdout).toBe("Unable to finish.\n");
		expect(console.error).toHaveBeenCalledWith(`Completion check incomplete after ${attempts} follow-up(s).`);
	});

	it.each([[], [fauxThinking("reasoning only")], [{ type: "text" as const, text: " \n " }]])(
		"bounds empty or thinking-only final responses and returns incomplete status 2: %j",
		async (...content) => {
			const { harness, run } = await setup();
			harness.setResponses([
				() => {
					commitTask(harness);
					return fauxAssistantMessage(content);
				},
				fauxAssistantMessage(content),
				fauxAssistantMessage(content),
				fauxAssistantMessage("must not be used"),
			]);
			expect(await run()).toBe(2);
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getUserTexts(harness)[1]).toContain("final answer text is missing");
			expect(stdout.trim()).toBe("");
			expect(console.error).toHaveBeenCalledWith(
				"Completion check incomplete: no final answer text after bounded follow-up.",
			);
		},
	);

	it("recovers thinking-only output with one bounded final-answer prompt", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			() => {
				commitTask(harness);
				return fauxAssistantMessage(fauxThinking("done thinking"));
			},
			fauxAssistantMessage("final answer"),
		]);
		expect(await run()).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(stdout).toBe("final answer\n");
	});

	it.each([
		{ stopReason: "error", completionReview: false },
		{ stopReason: "error", completionReview: true },
		{ stopReason: "aborted", completionReview: false },
		{ stopReason: "aborted", completionReview: true },
	] as const)(
		"never prompts after assistant $stopReason with review=$completionReview",
		async ({ stopReason, completionReview }) => {
			const { harness, run } = await setup();
			harness.setResponses([
				fauxAssistantMessage("", { stopReason, errorMessage: "terminal failure" }),
				fauxAssistantMessage("must not be used"),
			]);
			expect(await run({ mode: "json", completionReview, messages: ["pending user prompt"] })).toBe(1);
			expect(harness.faux.state.callCount).toBe(1);
			expect(getUserTexts(harness)).toHaveLength(1);
			expect(console.error).toHaveBeenCalledWith("terminal failure");
			expect(getCompletionEvents()).toEqual([]);
		},
	);

	it.each([false, true])(
		"does not add prompts after native retry recovery with review=%s",
		async (completionReview) => {
			const { harness, run } = await setup({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			});
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				fauxAssistantMessage("native retry recovered"),
				fauxAssistantMessage("must not be used"),
			]);
			expect(await run({ mode: "json", completionReview })).toBe(0);
			expect(harness.faux.state.callCount).toBe(2);
			expect(getUserTexts(harness)).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getCompletionEvents()).toEqual([]);
		},
	);

	it.each([false, true])("never follows a terminating permission denial with review=%s", async (completionReview) => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unsafe" }], details: {} }));
		const tool: AgentTool = {
			name: "blocked_tool",
			label: "Blocked tool",
			description: "test tool",
			parameters: Type.Object({}),
			execute,
		};
		const { harness, run } = await setup({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => ({ block: true, reason: "explicit permission denial", terminate: true }));
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("blocked_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be used"),
		]);
		expect(await run({ mode: "json", completionReview, messages: ["pending user prompt"] })).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(execute).not.toHaveBeenCalled();
		expect(stdout).toContain("explicit permission denial");
		expect(stdout).not.toContain('"type":"completion_check"');
	});

	it("leaves default-off behavior unchanged without Git or a final answer", async () => {
		const { harness, run } = await setup({}, false);
		harness.setResponses([fauxAssistantMessage(fauxThinking("thinking only")), fauxAssistantMessage("unused")]);
		expect(await run({ completionCheck: undefined })).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("fails non-Git preflight before binding extensions or calling the model and cleans up", async () => {
		const { harness, host, run } = await setup({}, false);
		const bind = vi.spyOn(harness.session, "bindExtensions");
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		const before = signals.map((signal) => process.listenerCount(signal));
		expect(await run()).toBe(1);
		expect(bind).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(host.dispose).toHaveBeenCalledTimes(1);
		expect(output.flushRawStdout).toHaveBeenCalledTimes(1);
		expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
	});

	it("rejects invalid options before any model or extension call", async () => {
		const { harness, host, run } = await setup();
		const bind = vi.spyOn(harness.session, "bindExtensions");
		expect(await run({ completionCheckAttempts: 4 })).toBe(1);
		expect(bind).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(host.dispose).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"retains final-text exit 0 after Git becomes unavailable with review=%s",
		async (completionReview) => {
			const { harness, run } = await setup();
			harness.setResponses([
				() => {
					renameSync(join(harness.tempDir, ".git"), join(harness.tempDir, ".git-unavailable"));
					return fauxAssistantMessage("task failed, here is the result");
				},
			]);
			expect(await run({ mode: "json", completionReview })).toBe(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(stdout).toContain('"status":"unavailable"');
			if (completionReview) expect(getCompletionEvents()[0].review).toEqual({ requested: false, sent: false });
		},
	);

	it("keeps JSON history and waits for stdout backpressure before a follow-up", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			fauxAssistantMessage("first"),
			() => {
				commitTask(harness);
				return fauxAssistantMessage("last");
			},
		]);
		let release: () => void = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(output.waitForRawStdoutBackpressure).mockImplementation(async () => {
			if (stdout.includes('"type":"completion_check"') && harness.faux.state.callCount === 1) await blocked;
		});
		const running = run({ mode: "json" });
		try {
			await vi.waitFor(() => expect(stdout).toContain('"status":"follow_up"'));
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			release();
		}
		expect(await running).toBe(0);
		const events = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events.filter((event) => event.type === "completion_check").map((event) => event.status)).toEqual([
			"follow_up",
			"passed",
		]);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "user")).toHaveLength(2);
		expect(stdout).toContain('"text":"first"');
		expect(stdout).toContain('"text":"last"');
	});

	it.each([false, true])(
		"preserves explicit rebinding without automatic continuation with review=%s",
		async (completionReview) => {
			const first = await setup();
			const second = await setup();
			first.harness.setResponses([fauxAssistantMessage("before replacement")]);
			second.harness.setResponses([fauxAssistantMessage("after replacement")]);
			const originalPrompt = first.harness.session.prompt.bind(first.harness.session);
			vi.spyOn(first.harness.session, "prompt").mockImplementationOnce(async (text, options) => {
				await originalPrompt(text, options);
				first.host.session = second.harness.session;
				first.host.cwd = second.harness.tempDir;
				await first.host.setRebindSession.mock.calls[0]?.[0]?.(second.harness.session);
			});
			expect(await first.run({ mode: "json", completionReview, messages: ["explicit next message"] })).toBe(0);
			expect(getUserTexts(second.harness)).toEqual(["explicit next message"]);
			expect(stdout).toContain('"text":"after replacement"');
			expect(stdout).not.toContain('"type":"completion_check"');
			expect(first.host.dispose).toHaveBeenCalledTimes(1);
		},
	);
});

describe("opt-in completion self-review", () => {
	it.each(["text", "json"] as const)(
		"reviews a clean committed result once in the same session/model in %s mode",
		async (mode) => {
			const { harness, host, run } = await setup();
			const sessionId = harness.session.sessionId;
			const model = harness.session.model;
			const prompt = vi.spyOn(harness.session, "prompt");
			harness.setResponses([
				() => {
					commitTask(harness);
					return fauxAssistantMessage("initial final");
				},
				(context) => {
					expect(context.messages.some((message) => message.role === "assistant")).toBe(true);
					expect(getUserTexts(harness)[1]).toContain("original visible task");
					expect(getUserTexts(harness)[1]).toContain("public interfaces and types");
					expect(getUserTexts(harness)[1]).toContain("after the last edit");
					return fauxAssistantMessage("reviewed final");
				},
				fauxAssistantMessage("must not be used"),
			]);
			expect(await run({ mode, completionReview: true })).toBe(0);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getUserTexts(harness)).toHaveLength(2);
			expect(prompt.mock.calls[1]?.[1]).toEqual({ expandPromptTemplates: false });
			expect(harness.session.sessionId).toBe(sessionId);
			expect(harness.session.model).toBe(model);
			expect(host.newSession).not.toHaveBeenCalled();
			expect(host.fork).not.toHaveBeenCalled();
			expect(host.switchSession).not.toHaveBeenCalled();
			if (mode === "text") {
				expect(stdout).toBe("reviewed final\n");
			} else {
				const checks = getCompletionEvents();
				expect(checks.map((event) => [event.attempt, event.status, event.followUpKind, event.review])).toEqual([
					[0, "follow_up", "review", { requested: true, sent: false }],
					[0, "follow_up", "review", { requested: true, sent: true }],
					[1, "passed", undefined, { requested: true, sent: true }],
				]);
				expect(checks[0]).toMatchObject({
					hasNewCommit: true,
					hasCommittedChanges: true,
					trackedDirty: false,
					hasFinalText: true,
				});
			}
		},
	);

	it("combines review with dirty repair and uses only the shared two-follow-up budget", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			() => {
				writeFileSync(join(harness.tempDir, "source.txt"), "unfinished task\n");
				return fauxAssistantMessage("initial final");
			},
			fauxAssistantMessage("reviewed, but work remains"),
			() => {
				commitTask(harness);
				return fauxAssistantMessage("fixed and verified");
			},
			fauxAssistantMessage("must not be used"),
		]);
		expect(await run({ mode: "json", completionReview: true, completionCheckAttempts: 2 })).toBe(0);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		const users = getUserTexts(harness);
		expect(users).toHaveLength(3);
		expect(users[1]).toContain("Final self-review:");
		expect(users[1]).toContain("tracked changes remain");
		expect(users[1]).toContain("no new commit since the starting HEAD");
		expect(users[2]).toContain("tracked changes remain");
		expect(users[2]).not.toContain("Final self-review:");
		expect(getCompletionEvents().map((event) => [event.attempt, event.status, event.followUpKind])).toEqual([
			[0, "follow_up", "review"],
			[0, "follow_up", "review"],
			[1, "follow_up", "completion"],
			[2, "passed", undefined],
		]);
		expect(git(harness.tempDir, "status", "--porcelain")).toBe("");
	});

	it.each([1, 2, 3])(
		"does not extend a budget of %i or resample an incomplete result with final text",
		async (attempts) => {
			const { harness, host, run } = await setup();
			const head = git(harness.tempDir, "rev-parse", "HEAD");
			harness.setResponses(Array.from({ length: attempts + 2 }, () => fauxAssistantMessage("Unable to finish.")));
			expect(await run({ mode: "json", completionReview: true, completionCheckAttempts: attempts })).toBe(0);
			expect(harness.faux.state.callCount).toBe(attempts + 1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getUserTexts(harness).filter((text) => text.includes("Final self-review:"))).toHaveLength(1);
			expect(getCompletionEvents().at(-1)).toMatchObject({
				attempt: attempts,
				status: "exhausted",
				willFollowUp: false,
			});
			expect(git(harness.tempDir, "rev-parse", "HEAD")).toBe(head);
			expect(host.newSession).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledWith(`Completion check incomplete after ${attempts} follow-up(s).`);
		},
	);

	it.each([[], [fauxThinking("reasoning only")], [{ type: "text" as const, text: " \n " }]])(
		"keeps missing final-text handling within the shared budget: %j",
		async (...content) => {
			const { harness, run } = await setup();
			harness.setResponses([
				() => {
					commitTask(harness);
					return fauxAssistantMessage(content);
				},
				fauxAssistantMessage(content),
				fauxAssistantMessage(content),
				fauxAssistantMessage("unused"),
			]);
			expect(await run({ completionReview: true })).toBe(2);
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(getUserTexts(harness)[1]).toContain("final answer text is missing");
			expect(getUserTexts(harness)[1]).toContain("Final self-review:");
			expect(getUserTexts(harness)[2]).not.toContain("Final self-review:");
			expect(stdout.trim()).toBe("");
		},
	);

	it("keeps explicit user prompts before the single review", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			fauxAssistantMessage("first"),
			() => {
				commitTask(harness);
				return fauxAssistantMessage("second");
			},
			fauxAssistantMessage("reviewed"),
		]);
		expect(await run({ completionReview: true, messages: ["Explicit extra requirement."] })).toBe(0);
		expect(getUserTexts(harness).slice(0, 2)).toEqual([
			"Complete the task and commit the changes.",
			"Explicit extra requirement.",
		]);
		expect(getUserTexts(harness)[2]).toContain("Final self-review:");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("rejects review without the check before binding extensions or prompting", async () => {
		const { harness, run } = await setup({}, false);
		const bind = vi.spyOn(harness.session, "bindExtensions");
		expect(await run({ completionCheck: undefined, completionReview: true })).toBe(1);
		expect(bind).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("records requested but not sent when the review prompt fails preflight", async () => {
		const { harness, run } = await setup();
		harness.setResponses([
			() => {
				commitTask(harness);
				return fauxAssistantMessage("initial final");
			},
		]);
		const originalPrompt = harness.session.prompt.bind(harness.session);
		vi.spyOn(harness.session, "prompt")
			.mockImplementationOnce(originalPrompt)
			.mockRejectedValueOnce(new Error("review preflight failed"));
		expect(await run({ mode: "json", completionReview: true })).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toHaveLength(1);
		expect(getCompletionEvents()).toHaveLength(1);
		expect(getCompletionEvents()[0].review).toEqual({ requested: true, sent: false });
	});

	it.each(["error", "aborted", "recovered retry"] as const)(
		"retains a sent receipt if review ends with %s",
		async (outcome) => {
			const { harness, run } = await setup({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			});
			harness.setResponses([
				() => {
					commitTask(harness);
					return fauxAssistantMessage("initial final");
				},
				fauxAssistantMessage("", {
					stopReason: outcome === "aborted" ? "aborted" : "error",
					errorMessage: outcome === "recovered retry" ? "overloaded_error" : "terminal review failure",
				}),
				fauxAssistantMessage("recovered final"),
				fauxAssistantMessage("unused"),
			]);
			expect(await run({ mode: "json", completionReview: true })).toBe(outcome === "recovered retry" ? 0 : 1);
			expect(harness.faux.state.callCount).toBe(outcome === "recovered retry" ? 3 : 2);
			expect(getUserTexts(harness)).toHaveLength(2);
			expect(getCompletionEvents().map((event) => event.review)).toEqual([
				{ requested: true, sent: false },
				{ requested: true, sent: true },
			]);
		},
	);

	it.each(["signal", "session", "cwd"] as const)(
		"does not send review after %s changes while stdout is blocked",
		async (interruption) => {
			const first = await setup();
			first.harness.setResponses([
				() => {
					commitTask(first.harness);
					return fauxAssistantMessage("initial final");
				},
				fauxAssistantMessage("must not be used"),
			]);
			let release: () => void = () => {};
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.mocked(output.waitForRawStdoutBackpressure).mockImplementation(async () => {
				if (stdout.includes('"followUpKind":"review"') && first.harness.faux.state.callCount === 1) await blocked;
			});
			const running = first.run({ mode: "json", completionReview: true });
			try {
				await vi.waitFor(() => expect(getCompletionEvents()).toHaveLength(1));
				expect(getCompletionEvents()[0].review).toEqual({ requested: true, sent: false });
				expect(getUserTexts(first.harness)).toHaveLength(1);
				if (interruption === "signal") {
					const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
					process.emit("SIGINT");
					await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
				} else if (interruption === "session") {
					const second = await setup();
					second.harness.session.agent.state.messages = [fauxAssistantMessage("replacement final")];
					first.host.session = second.harness.session;
					first.host.cwd = second.harness.tempDir;
					await first.host.setRebindSession.mock.calls[0]?.[0]?.(second.harness.session);
					expect(second.harness.faux.state.callCount).toBe(0);
				} else {
					first.host.cwd = join(first.harness.tempDir, "other-workspace");
				}
			} finally {
				release();
			}
			expect(await running).toBe(0);
			expect(first.harness.faux.state.callCount).toBe(1);
			expect(first.harness.getPendingResponseCount()).toBe(1);
			expect(getCompletionEvents()).toHaveLength(1);
			expect(getCompletionEvents()[0].review).toEqual({ requested: true, sent: false });
		},
	);
});
