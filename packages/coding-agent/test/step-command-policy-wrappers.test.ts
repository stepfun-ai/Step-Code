import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../src/core/extensions/types.ts";
import { analyzeCommandPolicy, type CommandPolicyAnalysis } from "../src/step/command-policy.ts";
import { decideStepToolCall, StepPermissionController, stepPermissionStateForPreset } from "../src/step/permissions.ts";

vi.mock("../src/utils/shell.ts", () => ({ getShellConfig: () => ({ shell: "bash", args: ["-c"] }) }));

async function checkDecision(command: string, kind: CommandPolicyAnalysis["kind"]): Promise<void> {
	expect(analyzeCommandPolicy(command)).toMatchObject({ kind });
	for (const preset of ["bypass", "autopilot"] as const) {
		expect(
			decideStepToolCall("run_command", { command }, stepPermissionStateForPreset(preset), { run_command: "allow" }),
		).toMatchObject({
			action: kind === "ordinary" ? "allow" : "confirm",
			hazardous: kind === "matched",
			...(kind === "unresolved" ? { analysisIncomplete: true } : {}),
		});
		const controller = new StepPermissionController({
			env: {},
			initialPreset: preset,
			nonInteractiveApproval: "allow",
			toolOverrides: { run_command: "allow" },
		});
		const event: ToolCallEvent = {
			type: "tool_call",
			toolName: "run_command",
			toolCallId: "wrapper-approval",
			input: { command },
		};
		const result = await controller.handleToolCall(event, { hasUI: false } as ExtensionContext);
		if (kind === "ordinary") expect(result).toBeUndefined();
		else expect(result).toMatchObject({ block: true, terminate: true });
	}
}

describe("command wrappers preserve approval requirements", () => {
	it.each([
		"timeout 5 rm -rf ./build",
		"timeout -s TERM -k 1 5 reboot",
		"timeout -sTERM -k1 5 rm -rf ./build",
		"timeout --signal TERM --kill-after 1 5 reboot",
		"timeout --signal=TERM --kill-after=1 5 rm -rf ./build",
		"timeout --foreground --preserve-status -v 5 reboot",
		"timeout --verbose -- 5 rm -rf ./build",
		"timeout 0.5s bash -c 'rm -rf ./build'",
		"nice rm -rf ./build",
		"nice -n 5 reboot",
		"nice -n5 rm -rf ./build",
		"nice --adjustment 5 reboot",
		"nice --adjustment=5 rm -rf ./build",
		"nice -- rm -rf ./build",
		"setsid rm -rf ./build",
		"setsid -cfw reboot",
		"setsid --ctty --fork --wait rm -rf ./build",
		"setsid -- bash -c 'reboot'",
		"stdbuf -i 0 -o L -e 0 rm -rf ./build",
		"stdbuf -i0 -oL -e0 reboot",
		"stdbuf --input 0 --output L --error 0 rm -rf ./build",
		"stdbuf --input=0 --output=L --error=0 reboot",
		"stdbuf -oL -- bash -c 'rm -rf ./build'",
		"env MODE=test timeout -s TERM 5 nice -n 0 setsid -w stdbuf -oL rm -rf ./build",
	])("requires approval for %s", async (command) => {
		await checkDecision(command, "matched");
	});

	it.each([
		"timeout 5 echo rm -rf ./build",
		"timeout 5 -- rm -rf ./build",
		"timeout -- 5 -- reboot",
		"timeout 5 bash -c 'printf %s' label 'rm -rf ./build'",
		"nice -n 5 echo reboot",
		"nice --adjustment=5 rm -rF ./build",
		"setsid -w printf '%s' 'rm -rf ./build'",
		"stdbuf -oL echo reboot",
		"stdbuf --output='rm -rf ./build' printf safe",
	])("does not promote wrapper operands or command data to code: %s", async (command) => {
		await checkDecision(command, "ordinary");
	});

	it.each([
		"timeout --unknown 5 rm -rf ./build",
		"timeout -x 5 rm -rf ./build",
		"timeout -s",
		"timeout",
		'timeout "$DURATION" rm -rf ./build',
		'timeout -- DURATION="$VALUE" rm -rf ./build',
		'timeout -s "$SIGNAL" 5 rm -rf ./build',
		'timeout 5 "$COMMAND" -rf ./build',
		"nice -5 rm -rf ./build",
		"nice --5 rm -rf ./build",
		"nice -+5 rm -rf ./build",
		"nice --unknown rm -rf ./build",
		"nice -n",
		'nice -n "$PRIORITY" rm -rf ./build',
		'nice "$COMMAND" -rf ./build',
		"setsid --unknown rm -rf ./build",
		"setsid --wait=yes rm -rf ./build",
		'setsid "$OPTIONS" rm -rf ./build',
		"stdbuf --unknown rm -rf ./build",
		"stdbuf -o",
		'stdbuf -o "$BUFFER" rm -rf ./build',
		'stdbuf -oL "$COMMAND" -rf ./build',
	])("requires explicit review for unsupported or dynamic arguments: %s", async (command) => {
		await checkDecision(command, "unresolved");
	});
});

describe.skipIf(process.platform === "win32" || !existsSync("/bin/bash"))(
	"native wrappers execute harmless replacements",
	() => {
		let directory: string;
		let callLog: string;
		const nativeWrappers = new Map<string, string>();

		beforeAll(() => {
			directory = mkdtempSync(join(tmpdir(), "step-command-wrappers-"));
			callLog = join(directory, "calls");
			for (const name of ["timeout", "nice", "setsid", "stdbuf"]) {
				const candidates = ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].flatMap((path) => [
					join(path, name),
					join(path, `g${name}`),
				]);
				const executable = candidates.find((candidate) => existsSync(candidate));
				if (!executable) continue;
				nativeWrappers.set(name, executable);
				symlinkSync(executable, join(directory, name));
			}
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
			{ wrapper: "timeout", prefix: "timeout -s TERM -k 1 5" },
			{ wrapper: "nice", prefix: "nice" },
			{ wrapper: "nice", prefix: "nice -n 0" },
			{ wrapper: "setsid", prefix: "setsid -w" },
			{ wrapper: "stdbuf", prefix: "stdbuf -oL" },
		])("requires approval after native $prefix reaches rm", async ({ wrapper, prefix }, context) => {
			if (!nativeWrappers.has(wrapper)) context.skip();
			writeFileSync(callLog, "");
			const command = `${prefix} rm -rf ./build`;
			// Only the native wrapper and harmless targets are reachable through PATH.
			const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
				cwd: directory,
				env: { PATH: directory, COMMAND_LOG: callLog, LC_ALL: "C" },
				encoding: "utf8",
				timeout: 5000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(readFileSync(callLog, "utf8")).toBe("rm -rf ./build\n");
			await checkDecision(command, "matched");
		});
	},
);
