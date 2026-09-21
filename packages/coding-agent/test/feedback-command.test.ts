import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveStepDeviceIdPath } from "../src/step/device-id.ts";
import type { FeedbackBundleResult } from "../src/step/feedback/bundle.ts";
import {
	formatFeedbackBundleFailureDetails,
	formatFeedbackBundleSkipMessage,
	formatFeedbackFailureDetails,
	formatFeedbackPendingDetails,
	parseFeedbackArgs,
	runFeedbackCommand,
	submitFeedback,
} from "../src/step/feedback/command.ts";
import { resolveStderrDevLogPath } from "../src/step/stderr-dev-log.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "step-feedback-command-"));
	roots.push(root);
	return root;
}

function captureOutput(): { stream: Writable; text: () => string } {
	const chunks: string[] = [];
	return {
		stream: new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(String(chunk));
				callback();
			},
		}),
		text: () => chunks.join(""),
	};
}

function readyBundle(data = new Uint8Array([1, 2, 3, 4])): FeedbackBundleResult {
	return {
		status: "ready",
		bundle: {
			data,
			files: [{ name: "events.jsonl", bytes: 12 }],
			sessionId: "session-1",
			lastActivityAt: new Date("2026-09-01T00:00:00.000Z"),
		},
	};
}

describe("feedback command argument parsing", () => {
	test.each([
		{
			argv: ["--category", "--json"],
			error: "--category requires a value",
			expected: { json: true },
		},
		{
			argv: ["--message", "--session-bundle"],
			error: "--message requires a value",
			expected: { sessionBundle: true },
		},
		{
			argv: ["--session", "--json"],
			error: "--session requires a value",
			expected: { json: true },
		},
	])("does not consume the next option after $argv", ({ argv, error, expected }) => {
		const parsed = parseFeedbackArgs(argv);

		expect(parsed).toMatchObject({ error, positional: [], ...expected });
		expect(parsed.category).toBeUndefined();
		expect(parsed.message).toBeUndefined();
		expect(parsed.session).toBeUndefined();
	});

	test("preserves the first missing-value error and explicit empty message", () => {
		expect(parseFeedbackArgs(["--category=", "--unknown"]).error).toBe("--category requires a value");
		expect(parseFeedbackArgs(["--session="]).error).toBe("--session requires a value");
		expect(parseFeedbackArgs(["--message="])).toMatchObject({ message: "", positional: [] });
	});
});

describe("feedback command interaction", () => {
	test("reports an unconfigured endpoint without invoking fetch", async () => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const fetchImpl = vi.fn<typeof fetch>();

		const exitCode = await runFeedbackCommand(["--message", "no collector"], {
			storageRootDir: root,
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {},
			fetchImpl,
		});

		expect(exitCode).toBe(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stderr.text()).toContain("no feedback endpoint configured");
		expect(stdout.text()).toBe("");
	});

	test("treats a TTY command with a comment as a shortcut", async () => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi.fn();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand(["the", "composer", "dropped", "a", "key"], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback" },
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(question).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalledOnce();
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(submission).toMatchObject({ comment: "the composer dropped a key" });
		expect(submission.category).toBeUndefined();
		expect(submission.diagnostics).toBeUndefined();
		expect(stdout.text()).toContain("Submitted. Feedback ID:");
		expect(stderr.text()).toBe("");
	});

	test.each([
		{ label: "an explicit empty --message", argv: ["--category", "bug", "--message="] },
		{ label: "an explicit empty positional comment", argv: ["--category", "bug", ""] },
	])("keeps $label out of the guided flow", async ({ argv }) => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi.fn();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand(argv, {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback" },
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(question).not.toHaveBeenCalled();
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(submission).toMatchObject({ category: "bug", comment: "" });
		expect(stdout.text()).toContain("Submitted. Feedback ID:");
		expect(stderr.text()).toBe("");
	});

	test("keeps a category-only TTY command in the guided flow", async () => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi.fn().mockResolvedValueOnce("category details").mockResolvedValueOnce("y");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand(["--category", "bug"], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_CODING_AGENT_DIR: join(root, "agent"),
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
			},
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(question.mock.calls.map(([query]) => query)).toEqual(["Feedback: ", "Submit feedback? [y/N] "]);
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(submission).toMatchObject({ category: "bug", comment: "category details" });
		expect(stdout.text()).toContain("Submitted. Feedback ID:");
		expect(stderr.text()).toBe("");
	});

	test("discovers and previews final diagnostics in the bare guided flow", async () => {
		const root = await makeRoot();
		await mkdir(join(root, "logs"), { recursive: true });
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		await writeFile(resolveStderrDevLogPath(root), `before\nError token=${secret}\nafter\n`);
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi
			.fn()
			.mockResolvedValueOnce("1")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("It failed")
			.mockResolvedValueOnce("y");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand([], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_CODING_AGENT_DIR: join(root, "agent"),
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
			},
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(question.mock.calls.map(([query]) => query)).toEqual([
			expect.stringContaining("Category ("),
			expect.stringContaining("Attach diagnostics from logs/"),
			"Feedback: ",
			"Submit feedback? [y/N] ",
		]);
		expect(String(question.mock.calls[1]?.[0])).toContain("[Y/n]");
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
			diagnostics: { lines: string[]; truncated: boolean };
		};
		const content = submission.diagnostics.lines.join("\n");
		expect(content).not.toContain(secret);
		expect(stdout.text()).not.toContain(secret);
		expect(stdout.text()).toContain("<redacted:");
		expect(stdout.text()).toContain(
			`${Buffer.byteLength(content, "utf8")} bytes, ${submission.diagnostics.lines.length} lines, truncated: ${submission.diagnostics.truncated ? "yes" : "no"}`,
		);
		expect(stdout.text()).toContain(`--- diagnostics begin ---\n${content}\n--- diagnostics end ---`);
		expect(stderr.text()).toBe("");
	});

	test("neutralizes diagnostics paths in guided questions and previews", async () => {
		const root = await makeRoot();
		const diagnosticsDir = join(root, "diagnostics");
		await mkdir(diagnosticsDir, { recursive: true });
		const fileName = "input-trace-\u001b[31msecret\u001b[0m\rspoof\nline.jsonl";
		await writeFile(join(diagnosticsDir, fileName), "safe trace line\n");
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi
			.fn()
			.mockResolvedValueOnce("1")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("It failed")
			.mockResolvedValueOnce("y");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand([], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_CODING_AGENT_DIR: join(root, "agent"),
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
			},
			fetchImpl,
		});

		const safePath = "diagnostics/input-trace-\\x1b[31msecret\\x1b[0m\\rspoof\\nline.jsonl";
		const diagnosticsQuestion = String(question.mock.calls[1]?.[0]);
		expect(exitCode).toBe(0);
		expect(diagnosticsQuestion).toContain(`Attach diagnostics from ${safePath}?`);
		expect(diagnosticsQuestion).not.toMatch(/[\u001b\r\n]/u);
		expect(stdout.text()).toContain(`Diagnostics: ${safePath} —`);
		expect(stdout.text()).not.toContain("\u001b");
		expect(stdout.text()).not.toContain("\r");
		expect(stdout.text()).not.toContain("\nline.jsonl");
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(stderr.text()).toBe("");
	});

	test.each([
		{ label: "category prompt", answers: [undefined] },
		{ label: "comment prompt", answers: [undefined], argv: ["--category", "bug"] },
		{ label: "final confirmation", answers: ["details", undefined], argv: ["--category", "bug"] },
	])("cancels safely when input ends at the $label", async ({ answers, argv = [] }) => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi.fn();
		for (const answer of answers) question.mockResolvedValueOnce(answer);
		const fetchImpl = vi.fn<typeof fetch>();

		const exitCode = await runFeedbackCommand([...argv, "--no-diagnostics", "--no-session-bundle"], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_CODING_AGENT_DIR: join(root, "agent"),
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
			},
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stdout.text()).toContain("Cancelled; nothing was submitted");
		expect(stderr.text()).toBe("");
	});

	test("keeps an automatically discovered bundle session out of the top-level feedback context", async () => {
		const root = await makeRoot();
		const agentDir = join(root, "agent");
		const sessionDir = join(agentDir, "sessions", "project");
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "20260901_guessed-session.jsonl"),
			'{"type":"session","id":"guessed-session"}\n',
		);
		const stdout = captureOutput();
		const stderr = captureOutput();
		const question = vi
			.fn()
			.mockResolvedValueOnce("1")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("It failed")
			.mockResolvedValueOnce("y");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand([], {
			storageRootDir: root,
			interactive: true,
			prompt: { question },
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEP_CODING_AGENT_DIR: agentDir,
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
				STEPCODE_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.test/bundle",
			},
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
			context: Record<string, unknown>;
		};
		expect(submission.context.sessionId).toBeUndefined();
		expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/bundle?");
		expect(stdout.text()).toContain("session guessed-session");
		expect(stderr.text()).toBe("");
	});

	test.each([
		{
			label: "--session",
			argv: ["explicit context", "--session", "argv-session"],
			dependencySessionId: "dependency-session",
			expectedSessionId: "argv-session",
		},
		{
			label: "the explicit command dependency",
			argv: ["explicit context"],
			dependencySessionId: "dependency-session",
			expectedSessionId: "dependency-session",
		},
	])("includes session context from $label", async ({ argv, dependencySessionId, expectedSessionId }) => {
		const root = await makeRoot();
		const stdout = captureOutput();
		const stderr = captureOutput();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand(argv, {
			storageRootDir: root,
			...(dependencySessionId ? { sessionId: dependencySessionId } : {}),
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback" },
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
			context: Record<string, unknown>;
		};
		expect(submission.context.sessionId).toBe(expectedSessionId);
		expect(stderr.text()).toBe("");
	});

	test("uses the bundled header ID instead of an explicit local session path", async () => {
		const root = await makeRoot();
		const sessionFile = join(root, "private", "local-session.jsonl");
		await mkdir(join(root, "private"), { recursive: true });
		await writeFile(sessionFile, '{"type":"session","id":"header-session"}\n{"type":"message"}\n');
		const stdout = captureOutput();
		const stderr = captureOutput();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		const exitCode = await runFeedbackCommand(["path context", "--session", sessionFile, "--session-bundle"], {
			storageRootDir: root,
			sessionId: "dependency-session",
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback",
				STEPCODE_FEEDBACK_BUNDLE_ENDPOINT: "https://feedback.test/bundle",
			},
			fetchImpl,
		});

		expect(exitCode).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
		const submission = JSON.parse(body) as { context: Record<string, unknown> };
		expect(submission.context.sessionId).toBe("header-session");
		expect(body).not.toContain(sessionFile);
		expect(stderr.text()).toBe("");
	});

	test.each(["absolute", "relative", "backslash", "jsonl-filename"] as const)(
		"does not expose an explicit $pathShape session path when no bundle was built",
		async (pathShape) => {
			const root = await makeRoot();
			const sessionArgument =
				pathShape === "absolute"
					? join(root, "private", "local-session.jsonl")
					: pathShape === "relative"
						? "private/local-session.jsonl"
						: pathShape === "backslash"
							? "private\\local-session"
							: "local-session.jsonl";
			const stdout = captureOutput();
			const stderr = captureOutput();
			const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

			const exitCode = await runFeedbackCommand(["path context", "--session", sessionArgument], {
				storageRootDir: root,
				sessionId: "dependency-session",
				interactive: false,
				stdout: stdout.stream,
				stderr: stderr.stream,
				env: { STEPCODE_FEEDBACK_ENDPOINT: "https://feedback.test/feedback" },
				fetchImpl,
			});

			expect(exitCode).toBe(0);
			const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
			const submission = JSON.parse(body) as { context: Record<string, unknown> };
			expect(submission.context.sessionId).toBeUndefined();
			expect(body).not.toContain(sessionArgument);
			expect(body).not.toContain("dependency-session");
			expect(stderr.text()).toBe("");
		},
	);

	test("builds once and does not deliver or track after confirmation is cancelled", async () => {
		const root = await makeRoot();
		const secret = "ghp_ABCDEFGHIJKLMNOPQRST0123456789";
		const fetchImpl = vi.fn<typeof fetch>();
		const track = vi.fn();
		const confirm = vi.fn().mockResolvedValue(false);

		const result = await submitFeedback({
			comment: `token=${secret}`,
			diagnostics: { source: "stderr_dev_log", lines: [`token=${secret}`], truncated: false },
			sessionBundle: readyBundle(),
			storageRootDir: root,
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			telemetry: { track },
			fetchImpl,
			surface: "cli",
			confirm,
		});

		expect(result).toEqual({ status: "cancelled" });
		expect(confirm).toHaveBeenCalledOnce();
		const submission = confirm.mock.calls[0]?.[0] as {
			comment: string;
			diagnostics?: { lines: readonly string[] };
		};
		expect(submission.comment).not.toContain(secret);
		expect(submission.diagnostics?.lines.join("\n")).not.toContain(secret);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(track).not.toHaveBeenCalled();
	});

	test("reports retry failure reason, status, payload kind, and pending path", async () => {
		const root = await makeRoot();
		const endpoint = "https://feedback.test/feedback";
		const initialStdout = captureOutput();
		const initialStderr = captureOutput();
		await runFeedbackCommand(["retry details"], {
			storageRootDir: root,
			interactive: false,
			stdout: initialStdout.stream,
			stderr: initialStderr.stream,
			env: { STEPCODE_FEEDBACK_ENDPOINT: endpoint },
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 413 })),
		});

		const stdout = captureOutput();
		const stderr = captureOutput();
		const exitCode = await runFeedbackCommand(["--retry"], {
			storageRootDir: root,
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: { STEPCODE_FEEDBACK_ENDPOINT: endpoint },
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
		});

		expect(exitCode).toBe(1);
		expect(stdout.text()).toBe("Re-sent 0/1\n");
		expect(stderr.text()).toContain(" report body: The collector has no feedback route yet. (HTTP 404)");
		expect(stderr.text()).toContain(join(root, "feedback", "pending-"));
		expect(stderr.text()).not.toContain("still pending");
	});

	test.each([413, 400])("does not recommend retry for a bundle blocked by permanent body HTTP %i", async (status) => {
		const root = await makeRoot();
		const endpoint = "https://feedback.test/feedback";
		const bundleEndpoint = "https://feedback.test/bundle";
		await submitFeedback({
			comment: "permanent body failure",
			sessionBundle: readyBundle(),
			storageRootDir: root,
			endpoint,
			bundleEndpoint,
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
			surface: "cli",
		});
		const stdout = captureOutput();
		const stderr = captureOutput();

		const exitCode = await runFeedbackCommand(["--retry"], {
			storageRootDir: root,
			interactive: false,
			stdout: stdout.stream,
			stderr: stderr.stream,
			env: {
				STEPCODE_FEEDBACK_ENDPOINT: endpoint,
				STEPCODE_FEEDBACK_BUNDLE_ENDPOINT: bundleEndpoint,
			},
			fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
		});

		expect(exitCode).toBe(1);
		expect(stdout.text()).toBe("Re-sent 0/1\n");
		expect(stderr.text()).toContain("Retrying the saved report and archive cannot work");
		expect(stderr.text()).toContain("modify and submit the report again");
		expect(stderr.text()).not.toContain("`step feedback --retry`");
	});
});

describe("feedback submission metadata", () => {
	test("records bundle telemetry only after an archive upload succeeds", async () => {
		const root = await makeRoot();
		const bundle = readyBundle();
		const pendingTrack = vi.fn();
		const pendingFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 413 }));

		await submitFeedback({
			comment: "pending archive",
			sessionBundle: bundle,
			storageRootDir: root,
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			telemetry: { track: pendingTrack },
			fetchImpl: pendingFetch,
			surface: "cli",
		});

		expect(pendingTrack).toHaveBeenCalledWith(
			"feedback_submitted",
			expect.objectContaining({ bundle_included: false, bundle_bytes: 0 }),
			undefined,
		);

		const uploadedTrack = vi.fn();
		const uploadedFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await submitFeedback({
			comment: "uploaded archive",
			sessionBundle: bundle,
			storageRootDir: root,
			endpoint: "https://feedback.test/feedback",
			bundleEndpoint: "https://feedback.test/bundle",
			telemetry: { track: uploadedTrack },
			fetchImpl: uploadedFetch,
			surface: "cli",
		});

		expect(uploadedTrack).toHaveBeenCalledWith(
			"feedback_submitted",
			expect.objectContaining({
				bundle_included: true,
				bundle_bytes: bundle.status === "ready" ? bundle.bundle.data.byteLength : 0,
			}),
			undefined,
		);
	});

	test("uses the shared username boundary and does not create a device id", async () => {
		const root = await makeRoot();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

		await submitFeedback({
			comment: "identity",
			storageRootDir: root,
			uid: "uid-1",
			username: "  account@example.test\n",
			endpoint: "https://feedback.test/feedback",
			fetchImpl,
			surface: "cli",
		});

		const submission = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
			context: Record<string, unknown>;
		};
		expect(submission.context).toMatchObject({ uid: "uid-1", username: "account@example.test" });
		expect(submission.context.deviceId).toBeUndefined();
		await expect(stat(resolveStepDeviceIdPath(root))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("feedback failure copy", () => {
	test("explains why an oversized session archive was omitted", () => {
		expect(formatFeedbackBundleSkipMessage({ status: "skipped", reason: "too-large" })).toBe(
			"The session archive was not included because it remains larger than 8 MiB after trimming.",
		);
	});

	test("explains why a session archive that cannot be safely redacted was omitted", () => {
		expect(formatFeedbackBundleSkipMessage({ status: "skipped", reason: "unsafe" })).toBe(
			"The session archive was not included because credentials could not be safely removed.",
		);
	});

	test("only recommends retry when the saved payload can converge", () => {
		expect(
			formatFeedbackFailureDetails({
				status: "pending",
				feedbackId: "feedback-1",
				reason: "unsupported-endpoint",
				pendingPath: "/tmp/pending.json",
			}),
		).toContain("once the server is upgraded");
		expect(
			formatFeedbackFailureDetails({
				status: "pending",
				feedbackId: "feedback-1",
				reason: "too-large",
				pendingPath: "/tmp/pending.json",
			}),
		).toContain("Retrying the same text cannot work");
		expect(
			formatFeedbackBundleFailureDetails({
				status: "pending",
				reason: "body-pending",
				pendingPath: "/tmp/pending.tar.gz",
				bodyPendingPath: "/tmp/pending.json",
			}),
		).toContain("`step feedback --retry`");
		const archiveWithoutPendingBody = formatFeedbackBundleFailureDetails({
			status: "pending",
			reason: "body-pending",
			pendingPath: "/tmp/pending.tar.gz",
		});
		expect(archiveWithoutPendingBody).toContain("report body was not saved locally");
		expect(archiveWithoutPendingBody).not.toContain("`step feedback --retry`");
		expect(
			formatFeedbackBundleFailureDetails({
				status: "pending",
				reason: "body-missing",
				pendingPath: "/tmp/pending.tar.gz",
				bodyPendingPath: "/tmp/pending.json",
			}),
		).toContain("`step feedback --retry`");
		const archiveWithoutBody = formatFeedbackBundleFailureDetails({
			status: "pending",
			reason: "body-missing",
			pendingPath: "/tmp/pending.tar.gz",
		});
		expect(archiveWithoutBody).toContain("report body was not saved locally");
		expect(archiveWithoutBody).not.toContain("`step feedback --retry`");
		const rejectedArchive = formatFeedbackBundleFailureDetails({
			status: "pending",
			reason: "rejected",
			pendingPath: "/tmp/pending.tar.gz",
		});
		expect(rejectedArchive).toContain("Retrying the same archive cannot work");
		expect(rejectedArchive).not.toContain("`step feedback --retry`");
	});

	test.each(["too-large", "rejected"] as const)(
		"does not recommend retrying a bundle whose report body is permanently %s",
		(reason) => {
			const details = formatFeedbackPendingDetails({
				status: "pending",
				feedbackId: "feedback-1",
				reason,
				pendingPath: "/tmp/pending.json",
				bundle: {
					status: "pending",
					reason: "body-pending",
					pendingPath: "/tmp/pending.tar.gz",
					bodyPendingPath: "/tmp/pending.json",
				},
			});

			expect(details).toContain("Retrying the saved report and archive cannot work");
			expect(details).toContain("modify and submit the report again");
			expect(details).not.toContain("`step feedback --retry`");
		},
	);

	test("states when no local body or archive copy was saved", () => {
		expect(
			formatFeedbackFailureDetails({
				status: "pending",
				feedbackId: "feedback-1",
				reason: "unreachable",
			}),
		).toContain("report body could not be saved locally");
		expect(
			formatFeedbackBundleFailureDetails({
				status: "pending",
				reason: "unreachable",
			}),
		).toContain("no local archive to retry");
	});
});
