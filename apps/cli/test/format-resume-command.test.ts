import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME, IS_STEP_ENTRYPOINT } from "../../../packages/coding-agent/src/config.ts";
import type { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { formatResumeCommand } from "../src/ui/interactive-mode.ts";

const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-format-resume-command-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function createSessionManager(options: {
	persisted?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	usesDefaultSessionDir?: boolean;
}): SessionManager {
	return {
		isPersisted: () => options.persisted ?? true,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => options.sessionId ?? "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
		getSessionDir: () => options.sessionDir ?? "/tmp/pi-sessions",
		usesDefaultSessionDir: () => options.usesDefaultSessionDir ?? true,
	} as unknown as SessionManager;
}

describe("formatResumeCommand", () => {
	it("returns a session resume command for default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile, sessionId: "test-session" });

		expect(formatResumeCommand(sessionManager)).toBe(`${APP_NAME} --session test-session`);
	});

	it("includes unquoted safe session dirs for non-default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom-pi-sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir /tmp/custom-pi-sessions --session test-session`,
		);
	});

	it("quotes session dirs containing spaces", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom pi sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom pi sessions' --session test-session`,
		);
	});

	it("quotes session dirs containing single quotes", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom pi's sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom pi'\\''s sessions' --session test-session`,
		);
	});

	// The printed hint has to be a command the launched product accepts: Step
	// ships `resume <id>`, while `--session` is pi's spelling. Both the product
	// name and the branch come from config's single entrypoint decision, made at
	// import time, so this suite asserts whichever product it was imported as.
	it("prints a command the launched product accepts", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile, sessionId: "test-session" });

		expect(formatResumeCommand(sessionManager)).toBe(
			IS_STEP_ENTRYPOINT ? `${APP_NAME} resume test-session` : `${APP_NAME} --session test-session`,
		);
	});

	it("keeps a custom session dir after the session selector", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({
			sessionFile,
			sessionId: "test-session",
			sessionDir: "/tmp/custom-step-sessions",
			usesDefaultSessionDir: false,
		});

		// Under Step the id stays directly after `resume`, because the compat layer
		// reads the first positional argument as the session id.
		expect(formatResumeCommand(sessionManager)).toBe(
			IS_STEP_ENTRYPOINT
				? `${APP_NAME} resume test-session --session-dir /tmp/custom-step-sessions`
				: `${APP_NAME} --session-dir /tmp/custom-step-sessions --session test-session`,
		);
	});

	it("returns undefined when stdout is not a TTY", () => {
		setStdoutIsTTY(false);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined for in-memory sessions", () => {
		setStdoutIsTTY(true);
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ persisted: false, sessionFile });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined when the session file is missing", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: "/tmp/pi-missing-session.jsonl" });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined when the session file is not set", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionFile: undefined });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});
});
