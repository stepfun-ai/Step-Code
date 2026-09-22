import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../src/core/extensions/types.ts";
import { analyzeCommandPolicy } from "../src/step/command-policy.ts";
import { decideStepToolCall, StepPermissionController, stepPermissionStateForPreset } from "../src/step/permissions.ts";

// Platform policy assertions must not depend on which shells are installed on the test host.
vi.mock("../src/utils/shell.ts", () => ({ getShellConfig: () => ({ shell: "bash", args: ["-c"] }) }));

const actualPlatform = process.platform;
const mixedCaseCommands = [
	"RM -rf /",
	"ReBoOt",
	"/opt/tools/rM -r -f ./build",
	"EnV MODE=test rm -rf ./build",
	"NoHuP reboot",
	"BaSh -c 'rm -rf ./build'",
	"ENV BASH -c 'RM -rf ./build'",
	"FIND . -exec rM -rf '{}' +",
	"CAT <<'EOF' | BASH\nRM -rf ./build\nEOF",
];

describe.each(["darwin", "linux", "win32"] as const)("executable case on %s", (platform) => {
	beforeEach(() => {
		// Replace this test file's global, not the process object shared by Vitest workers.
		const platformProcess = Object.create(process) as NodeJS.Process;
		Object.defineProperty(platformProcess, "platform", { value: platform });
		vi.stubGlobal("process", platformProcess);
	});

	afterEach(() => vi.unstubAllGlobals());

	it.each(mixedCaseCommands)("keeps platform-specific approval for %s", async (command) => {
		const hazardous = platform !== "linux";
		expect(analyzeCommandPolicy(command)).toMatchObject({ kind: hazardous ? "matched" : "ordinary" });
		for (const preset of ["bypass", "autopilot"] as const) {
			expect(
				decideStepToolCall("run_command", { command }, stepPermissionStateForPreset(preset), {
					run_command: "allow",
				}),
			).toMatchObject({ action: hazardous ? "confirm" : "allow", hazardous });
			const controller = new StepPermissionController({
				env: {},
				initialPreset: preset,
				nonInteractiveApproval: "allow",
				toolOverrides: { run_command: "allow" },
			});
			const event: ToolCallEvent = {
				type: "tool_call",
				toolName: "run_command",
				toolCallId: "executable-case",
				input: { command },
			};
			const result = await controller.handleToolCall(event, { hasUI: false } as ExtensionContext);
			if (hazardous) expect(result).toMatchObject({ block: true, terminate: true });
			else expect(result).toBeUndefined();
		}
	});

	it.each(["rm.exe -rf ./build", "'C:\\Tools\\RM.EXE' -rf ./build", "ENV.ExE BASH.ExE -c 'RM.ExE -rf ./build'"])(
		"only applies Windows path and executable suffix rules to %s",
		(command) => {
			expect(analyzeCommandPolicy(command)).toMatchObject({ kind: platform === "win32" ? "matched" : "ordinary" });
		},
	);

	it.each(["RM -rF ./build", "RM -- -rf", "SYSTEMCTL REBOOT", "ENV BASH -c 'printf %s' label 'RM -rf ./build'"])(
		"preserves argument case and data-only positions: %s",
		(command) => {
			expect(analyzeCommandPolicy(command)).toEqual({ kind: "ordinary" });
		},
	);
});

describe.skipIf(actualPlatform !== "darwin")("case-insensitive executable lookup on macOS", () => {
	let directory: string;
	let callLog: string;
	let caseInsensitive: boolean;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "step-command-case-"));
		callLog = join(directory, "calls");
		const probe = join(directory, "case-probe");
		writeFileSync(probe, "probe");
		const alternate = join(directory, "CASE-PROBE");
		caseInsensitive = existsSync(alternate) && statSync(probe).ino === statSync(alternate).ino;
		if (!caseInsensitive) return;
		symlinkSync("/usr/bin/env", join(directory, "env"));
		writeFileSync(join(directory, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
		const substitute = [
			"#!/bin/sh",
			`printf "%s" "\${0##*/}" >> "$COMMAND_LOG"`,
			'for arg do printf " %s" "$arg" >> "$COMMAND_LOG"; done',
			'printf "\\n" >> "$COMMAND_LOG"',
			"",
		].join("\n");
		for (const name of ["rm", "reboot"]) writeFileSync(join(directory, name), substitute, { mode: 0o700 });
	});

	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it.for([
		{ command: "RM -rf /", call: "RM -rf /" },
		{ command: "ReBoOt", call: "ReBoOt" },
		{ command: "ENV RM -rf ./build", call: "RM -rf ./build" },
		{ command: "BASH -c 'RM -rf ./build'", call: "RM -rf ./build" },
		{ command: "ENV BASH -c 'ReBoOt'", call: "ReBoOt" },
	])("requires approval when the shell resolves $command", ({ command, call }, context) => {
		if (!caseInsensitive) context.skip();
		writeFileSync(callLog, "");
		// A closed PATH ensures the shell can only run the harmless command replacements.
		const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
			cwd: directory,
			env: { PATH: directory, COMMAND_LOG: callLog, LC_ALL: "C" },
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(readFileSync(callLog, "utf8")).toBe(`${call}\n`);
		for (const preset of ["bypass", "autopilot"] as const) {
			expect(decideStepToolCall("run_command", { command }, stepPermissionStateForPreset(preset))).toMatchObject({
				action: "confirm",
				hazardous: true,
			});
		}
	});
});
