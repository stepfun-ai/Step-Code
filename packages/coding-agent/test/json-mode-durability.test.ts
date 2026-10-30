import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/**
 * The end-to-end guard for the log amplification, on the real CLI.
 *
 * `--mode json` is what a harness redirects to `stepcode.jsonl`, so this spawns
 * the real entry point with an offline provider, has a tool stream progress
 * frames, and inspects the actual stdout. A JSON run is a record of facts:
 * progress belongs to live consumers, which opt in explicitly.
 */

const cli = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/streaming-provider.ts", import.meta.url));

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RunResult {
	stdout: string;
	stderr: string;
	status: number | null;
	events: Array<Record<string, unknown>>;
}

function runJson(extraFlags: string[] = []): RunResult {
	const root = mkdtempSync(join(tmpdir(), "step-json-durability-"));
	roots.push(root);
	const env: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		XDG_CONFIG_HOME: join(root, ".config"),
		XDG_CACHE_HOME: join(root, ".cache"),
		STEP_CODING_AGENT_DIR: join(root, "config", "agent"),
		STEPCODE_STORAGE_ROOT_DIR: join(root, "storage"),
		STEP_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
		NODE_ENV: "test",
		FORCE_COLOR: "0",
		TMPDIR: root,
	};
	for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	// The provider fixture runs offline; keep MCP from reaching the network.
	writeFileSync(join(root, "config.toml"), "");
	const entry = join(root, "entry.mjs");
	writeFileSync(entry, `await import(${JSON.stringify(cli)});`);

	const result = spawnSync(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			entry,
			"--provider",
			"stream-offline",
			"--model",
			"faux-1",
			"--api-key",
			"offline-test-key",
			"--tools",
			"stream_probe",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-session",
			"--no-update-check",
			// The probe tool is treated as a workspace-mutating tool by the default
			// policy; this run is offline and has no human to approve it.
			"--non-interactive-approval",
			"allow",
			"--mode",
			"json",
			"-e",
			fixture,
			...extraFlags,
			"probe",
		],
		{ cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
	);

	const events: Array<Record<string, unknown>> = [];
	for (const line of (result.stdout ?? "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				events.push(parsed as Record<string, unknown>);
			}
		} catch {
			// Not an event line; the assertion below reports what did arrive.
		}
	}
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, events };
}

function typesOf(events: Array<Record<string, unknown>>): string[] {
	return events.map((event) => String(event.type ?? ""));
}

// Each case spawns the real CLI through tsx; that startup alone can exceed the
// default 30s budget on a loaded CI runner.
const TIMEOUT_MS = 180_000;

test(
	"a json run writes facts, not live progress",
	() => {
		const result = runJson();
		expect(result.status, result.stderr).toBe(0);

		const types = typesOf(result.events);
		// The tool really did stream, and the run really did complete.
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");
		expect(types).toContain("message_end");
		// Progress frames are live-only, so the record has none of them.
		expect(types).not.toContain("tool_execution_update");
		expect(types).not.toContain("message_update");
	},
	TIMEOUT_MS,
);

test(
	"turn_end and agent_end keep the boundary, not a second copy of the messages",
	() => {
		const result = runJson();
		expect(result.status, result.stderr).toBe(0);

		const turnEnds = result.events.filter((event) => event.type === "turn_end");
		const agentEnds = result.events.filter((event) => event.type === "agent_end");
		expect(turnEnds.length).toBeGreaterThan(0);
		expect(agentEnds.length).toBeGreaterThan(0);
		for (const event of turnEnds) {
			expect(Object.keys(event).sort()).toEqual(["messageRole", "toolResultCount", "type"]);
		}
		for (const event of agentEnds) {
			expect(Object.keys(event).sort()).toEqual(["messageCount", "type", "willRetry"]);
		}
		// The assistant answer reaches the record exactly once — on its own
		// `message_end` — and is not repeated by the turn and run boundaries that
		// close over it. Before the projection it appeared four times.
		const answered = result.events.filter((event) => JSON.stringify(event).includes("CLI offline final"));
		expect(typesOf(answered)).toEqual(["message_end"]);
	},
	TIMEOUT_MS,
);

test(
	"--include-live-events restores the live frames on the same run",
	() => {
		const result = runJson(["--include-live-events"]);
		expect(result.status, result.stderr).toBe(0);

		const types = typesOf(result.events);
		expect(types).toContain("tool_execution_update");
		// Still the same run: durable events are unaffected by the flag.
		expect(types).toContain("tool_execution_end");
	},
	TIMEOUT_MS,
);
