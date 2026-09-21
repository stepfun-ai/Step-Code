import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../src/core/extensions/types.ts";
import { isDangerousCommand } from "../src/step/command-policy.ts";
import { decideStepToolCall, StepPermissionController, stepPermissionStateForPreset } from "../src/step/permissions.ts";

interface ShellCase {
	name: string;
	command: string;
	stdout: string;
	calls: string[];
	analysisIncomplete?: true;
	allowedStderr?: readonly string[];
}

const removal = "rm -rf ./build";
const removalOutput = "executed rm\n";
const arrayOutput = "rm\n-rf\n./build\n";

// MR !95: execution is the independent oracle for the parser's four context regressions.
const cases: ShellCase[] = [
	{
		name: "a static bracket test command is not a command glob",
		command: "[ -n safe ]; printf '%s\\n' safe",
		stdout: "safe\n",
		calls: [],
	},
	...[
		"if [ -n safe ]; then printf '%s\\n' safe; fi",
		"while [ -n safe ]; do printf '%s\\n' safe; break; done",
		"./safe[",
		"'r[m]'",
	].map((command) => ({
		name: `literal bracket command: ${command}`,
		command,
		stdout: "safe\n",
		calls: [],
	})),
	{
		name: "a paired command glob resolves to an executable filename",
		command: "r[m] -rf ./build",
		stdout: removalOutput,
		calls: [removal],
		analysisIncomplete: true,
	},
	{
		name: "export assigns a quoted parameter value without executing it",
		command: `BAR='${removal}'; export FOO="$BAR"; printf '%s\\n' "$FOO"`,
		stdout: `${removal}\n`,
		calls: [],
	},
	...[
		"local",
		"readonly",
		"declare",
		"typeset",
		"builtin export",
		"command export",
		"builtin local",
		"command local",
		"builtin readonly",
		"command readonly",
	].map((declaration) => ({
		name: `scalar declaration value is data: ${declaration}`,
		command: `BAR='${removal}'; show() { ${declaration} FOO="$BAR"; printf '%s\\n' "$FOO"; }; show`,
		stdout: `${removal}\n`,
		calls: [],
	})),
	...['"FOO=$BAR"', 'F"OO"="$BAR"', "'FOO='\"$BAR\"", `'FOO=${removal}'`].map((assignment) => ({
		name: `quoted declaration assignment is data: ${assignment}`,
		command: `BAR='${removal}'; export ${assignment}; printf '%s\\n' "$FOO"`,
		stdout: `${removal}\n`,
		calls: [],
	})),
	...["export", "local", "readonly", "declare", "typeset", "builtin export", "command export"].map((declaration) => ({
		name: `declaration command substitution executes: ${declaration}`,
		command: `show() { ${declaration} FOO="$(${removal})"; printf '%s\\n' "$FOO"; }; show`,
		stdout: removalOutput,
		calls: [removal],
	})),
	{
		name: "array subscript declaration expressions still need approval",
		command: `declare 'args[$(${removal} >/dev/null)0]=value'`,
		stdout: "",
		calls: [removal],
		analysisIncomplete: true,
	},
	{
		name: "integer declaration expressions still need approval",
		command: `declare -i value='args[$(${removal} >/dev/null)0]'`,
		stdout: "",
		calls: [removal],
		analysisIncomplete: true,
	},
	{
		name: "nameref declarations still need approval",
		// Bash 3 rejects -n before resolving the reference.
		command: "declare -n reference=target 2>/dev/null || :",
		stdout: "",
		calls: [],
		analysisIncomplete: true,
	},
	...["builtin declare FOO=$BAR", "command declare FOO=$BAR", 'declare F"OO"=$BAR'].map((declaration) => ({
		name: `split declaration reinterprets a subscript: ${declaration}`,
		command: `BAR='safe args[$(reboot>/dev/null)0]=value'; ${declaration}`,
		stdout: "",
		calls: ["reboot"],
		analysisIncomplete: true as const,
	})),
	...["declare FOO=$BAR", 'builtin declare FOO="$BAR"', 'command declare FOO="$BAR"'].map((declaration) => ({
		name: `unsplit declaration value stays data: ${declaration}`,
		command: `BAR='safe args[$(reboot>/dev/null)0]=value'; ${declaration}; printf '%s\\n' "$FOO"`,
		stdout: "safe args[$(reboot>/dev/null)0]=value\n",
		calls: [],
	})),
	...[
		'builtin declare FOO="$@"',
		'command declare FOO="$@"',
		'declare "FOO=$@"',
		`builtin declare FOO="\${unset:-"$@"}"`,
	].map((declaration) => ({
		name: `quoted multiword declaration: ${declaration}`,
		command: `show() { set -- safe 'args[$(reboot>/dev/null)0]=value'; ${declaration}; }; show`,
		stdout: "",
		calls: ["reboot"],
		analysisIncomplete: true as const,
	})),
	{
		name: "quoted array expansion adds declaration arguments",
		command: `values=(safe 'args[$(reboot>/dev/null)0]=value'); builtin declare FOO="\${values[@]}"`,
		stdout: "",
		calls: ["reboot"],
		analysisIncomplete: true,
	},
	...['declare FOO="$@"', `declare FOO="\${unset:-"$@"}"`].map((declaration) => ({
		name: `direct multiword assignment stays data: ${declaration}`,
		command: `show() { set -- safe 'args[$(reboot>/dev/null)0]=value'; ${declaration}; printf '%s\\n' "$FOO"; }; show`,
		stdout: "safe args[$(reboot>/dev/null)0]=value\n",
		calls: [],
	})),
	...["declare -a", "readonly -a", "local -a"].map((declaration) => ({
		name: `${declaration} reparses a dynamic array value`,
		command: `BAR='($(reboot))'; show() { ${declaration} FOO="$BAR"; }; show`,
		stdout: "",
		calls: ["reboot"],
		analysisIncomplete: true as const,
	})),
	...[
		'FOO=(safe); declare FOO="$BAR"',
		'FOO=(safe); typeset FOO="$BAR"',
		'read -a FOO <<< safe; declare FOO="$BAR"',
		`read 'FOO[0]' <<< safe; declare FOO="$BAR"`,
		'((FOO[0]=1)); declare FOO="$BAR"',
		'((FOO[0]=1)); typeset FOO="$BAR"',
		`let 'FOO[0]=1'; declare FOO="$BAR"`,
		`eval 'FOO=(safe)'; declare FOO="$BAR"`,
		`: "\${FOO[0]:=safe}"; declare FOO="$BAR"`,
		'show() { local FOO; FOO=(safe); local FOO="$BAR"; }; show',
		'show() { for round in 1 2; do local FOO="$BAR"; FOO=(safe); done; }; show',
	].map((command) => ({
		name: `existing array attribute reparses a dynamic value: ${command}`,
		command: `BAR='($(reboot))'; ${command}`,
		stdout: "",
		calls: ["reboot"],
		analysisIncomplete: true as const,
	})),
	{
		name: "literal array declaration value executes its substitution",
		command: "declare -a FOO='($(reboot))'",
		stdout: "",
		calls: ["reboot"],
	},
	{
		name: "literal array declaration value preserves ordinary elements",
		command: `declare -a FOO='(${removal})'; printf '%s\\n' "\${FOO[@]}"`,
		stdout: arrayOutput,
		calls: [],
	},
	...['["!"]', "[$'!']"].map((pattern) => ({
		name: `quoted bracket member expands before eval: ${pattern}`,
		command: `eval ${pattern} reboot; :`,
		stdout: "executed reboot\n",
		calls: ["reboot"],
		analysisIncomplete: true as const,
	})),
	...(["bash", "sh"] as const).flatMap((shell) =>
		["-c", "-ec"].map((option) => ({
			name: `${shell} ${option} skips the option terminator before the script`,
			command: `${shell} ${option} -- '${removal}'`,
			stdout: removalOutput,
			calls: [removal],
		})),
	),
	{
		name: "sh -c -- invokes the lifecycle command",
		command: "sh -c -- 'reboot'",
		stdout: "executed reboot\n",
		calls: ["reboot"],
	},
	...["-c -e --", "-c -", "-c -o errexit --", "-o errexit -c --", "-c -O extglob --"].map((options) => ({
		name: `bash ${options} locates the actual script after shell options`,
		command: `bash ${options} '${removal}'`,
		stdout: removalOutput,
		calls: [removal],
	})),
	...(["bash", "sh"] as const).map((shell) => ({
		name: `${shell} scans a command option following an option-value flag in the same word`,
		command: `${shell} -oc errexit -- '${removal}'`,
		stdout: removalOutput,
		calls: [removal],
	})),
	{
		name: "shell options after a script filename remain positional arguments",
		command: "bash safe-script -c 'rm -rf ./build'",
		stdout: "safe\n",
		calls: [],
	},
	{
		name: "shell option terminator makes -c a script filename",
		command: "bash -- -c 'rm -rf ./build'",
		stdout: "safe\n",
		calls: [],
	},
	{
		name: "arguments after an empty script remain data",
		command: "bash -c -- '' 'rm -rf ./build'",
		stdout: "",
		calls: [],
	},
	{
		name: "arguments following the script are not executable scripts",
		command: "bash -ec -- 'printf %s safe' label 'rm -rf ./build'",
		stdout: "safe",
		calls: [],
	},
	{
		name: "a backtick closes before its inner line comment ends",
		command: "echo `echo ok # ignored`; rm -rf ./build",
		stdout: `ok\n${removalOutput}`,
		calls: [removal],
	},
	{
		name: "a double quoted backtick closes before its inner line comment ends",
		command: 'echo "`echo ok # ignored`"; rm -rf ./build',
		stdout: `ok\n${removalOutput}`,
		calls: [removal],
	},
	{
		name: "escaped nested backticks execute after the outer substitution unescapes them",
		command: "echo `echo \\`rm -rf ./build\\``",
		stdout: removalOutput,
		calls: [removal],
	},
	{
		name: "quoted backticks are inert data",
		command: "printf '%s\\n' '`echo ok # ignored`; rm -rf ./build'",
		stdout: "`echo ok # ignored`; rm -rf ./build\n",
		calls: [],
	},
	{
		name: "a dollar substitution ignores a closing parenthesis in a comment",
		command: 'echo "$(echo ok # )\nrm -rf ./build\n)"',
		stdout: `ok\n${removalOutput}`,
		calls: [removal],
	},
	...[
		{ name: "ANSI quoted", word: "$'EOF'", delimiter: "EOF" },
		{ name: "locale quoted", word: '$"EOF"', delimiter: "EOF" },
		{ name: "hex escaped", word: "$'E\\x4fF'", delimiter: "EOF" },
		{ name: "octal escaped", word: "$'E\\117F'", delimiter: "EOF" },
		{ name: "tab escaped", word: "$'E\\tOF'", delimiter: "E\tOF" },
		{ name: "quote escaped", word: "$'E\\'OF'", delimiter: "E'OF" },
		{ name: "backslash escaped", word: "$'E\\\\OF'", delimiter: "E\\OF" },
		{ name: "unknown escape preserved", word: "$'E\\qOF'", delimiter: "E\\qOF" },
		{ name: "NUL truncated", word: "$'EOF\\000ignored'", delimiter: "EOF" },
		{ name: "NUL truncated with concatenated suffix", word: "$'E\\000ignored'OF", delimiter: "EOF" },
		{ name: "UTF-8 BOM preserved", word: "$'\\xef\\xbb\\xbfEOF'", delimiter: "\uFEFFEOF" },
		{ name: "raw non-BMP Unicode", word: "$'\u{1f680}'", delimiter: "\u{1f680}" },
		{ name: "UTF-8 byte escaped", word: "$'\\xc3\\xa9'", delimiter: "é" },
		{ name: "mixed ANSI quoted", word: "E$'O'F", delimiter: "EOF" },
		{ name: "mixed locale quoted", word: 'E$"O"F', delimiter: "EOF" },
		{ name: "empty ANSI quoted prefix", word: "$''EOF", delimiter: "EOF" },
		{ name: "empty ANSI quoted", word: "$''", delimiter: "" },
		{ name: "empty locale quoted", word: '$""', delimiter: "" },
	].map(({ name, word, delimiter }) => ({
		name: `${name} heredoc ends before the following command`,
		...(word.includes("\\") ? { analysisIncomplete: true as const } : {}),
		command: `cat <<${word}\nhello\n${delimiter}\n${removal}`,
		stdout: `hello\n${removalOutput}`,
		calls: [removal],
	})),
	...(["$'EOF'", '$"EOF"'] as const).map((word) => ({
		name: `${word} heredoc leaves its body substitutions inert`,
		command: `cat <<${word}\n$(rm -rf ./build)\nEOF`,
		stdout: "$(rm -rf ./build)\n",
		calls: [],
	})),
	{
		name: "dollar quoted tab stripping heredoc ends before the following command",
		command: "cat <<-$'EOF'\n\thello\n\tEOF\nrm -rf ./build",
		stdout: `hello\n${removalOutput}`,
		calls: [removal],
	},
	{
		name: "multiple dollar quoted heredocs preserve the following command",
		command: "cat <<$'FIRST' <<$'SECOND'\nfirst\nFIRST\nsecond\nSECOND\nrm -rf ./build",
		stdout: `second\n${removalOutput}`,
		calls: [removal],
	},
	{
		name: "dollar quoted heredoc fed into a shell executes its body",
		command: "sh <<$'EOF'\nrm -rf ./build\nEOF",
		stdout: removalOutput,
		calls: [removal],
	},
	...[
		{ name: "assignment", initialization: "args=(rm -rf ./build)" },
		{ name: "append", initialization: "args=(); args+=(rm -rf ./build)" },
		{ name: "declaration", initialization: "declare -a args=(rm -rf ./build)" },
		{ name: "typeset declaration", initialization: "typeset -a args=(rm -rf ./build)" },
		{ name: "quoted first element", initialization: "args=('rm' -rf ./build)" },
		{ name: "multiline assignment", initialization: "args=(\nrm -rf ./build\n)" },
		{ name: "comment containing a closing parenthesis", initialization: "args=(# ignored )\nrm -rf ./build\n)" },
		{ name: "indexed assignment", initialization: "args=([0]=rm [1]=-rf [2]=./build)" },
	].map(({ name, initialization }) => ({
		name: `array ${name} preserves ordinary elements as data`,
		command: `${initialization}; printf '%s\\n' "\${args[@]}"`,
		stdout: arrayOutput,
		calls: [],
	})),
	{
		name: "local array declarations preserve ordinary elements as data",
		command: `show() { local -a args=(rm -rf ./build); printf '%s\\n' "\${args[@]}"; }; show`,
		stdout: arrayOutput,
		calls: [],
	},
	{
		name: "escaped spaces preserve array elements as data",
		command: `args=(rm\\ -rf ./build); printf '%s\\n' "\${args[@]}"`,
		stdout: "rm -rf\n./build\n",
		calls: [],
	},
	...[
		{ name: "dollar substitution", value: '"$(rm -rf ./build)"' },
		{ name: "backtick substitution", value: '"`rm -rf ./build`"' },
	].map(({ name, value }) => ({
		name: `array ${name} still executes`,
		command: `args=(${value}); printf '%s\\n' "\${args[@]}"`,
		stdout: removalOutput,
		calls: [removal],
	})),
	{
		name: "process substitutions in array values still execute",
		command: `args=("$(cat <(rm -rf ./build))"); printf '%s\\n' "\${args[@]}"`,
		stdout: removalOutput,
		calls: [removal],
	},
	{
		name: "ordinary parenthesized command groups still execute",
		command: "(rm -rf ./build)",
		stdout: removalOutput,
		calls: [removal],
	},
	{
		name: "commands after an array remain executable",
		command: "args=(safe); rm -rf ./build",
		stdout: removalOutput,
		calls: [removal],
	},
	{
		name: "array append remains an assignment prefix before an executable command",
		command: `args+=(safe) ${removal}`,
		stdout: removalOutput,
		calls: [removal],
	},
	{
		name: "an indexed compound assignment diagnostic does not prevent the following command",
		command: `args[0]=(safe) ${removal}`,
		stdout: removalOutput,
		calls: [removal],
		// Bash 5 diagnoses this invalid identifier; Bash 3 does not. Both execute the command.
		allowedStderr: ["", "/bin/bash: line 1: `args[0]': not a valid identifier\n"],
	},
	{
		name: "ANSI quoted array elements do not hide the closing array boundary",
		analysisIncomplete: true,
		command: "args=($'\\'' # )\nbar); rm -rf ./build",
		stdout: removalOutput,
		calls: [removal],
	},
	...[
		`function run { ${removal}; }; run`,
		`if true; then ${removal}; fi`,
		`for item in one; do ${removal}; done`,
		`case x in x) ${removal};; esac`,
		`declare -a args=("$(${removal})"); printf "%s\\n" "\${args[@]}"`,
		`printf "%s\\n" "\${missing:-$(${removal})}"`,
		`sh <<< "${removal}"`,
		`eval '${removal}'`,
		`eval -- '${removal}'`,
		`builtin eval '${removal}'`,
		`builtin command ${removal}`,
		`builtin trap '${removal}' EXIT`,
		`trap '${removal}' EXIT`,
		'$"rm" -rf ./build',
		`printf "%s\\n" "$\\\n(${removal})"`,
	].map((command) => ({
		name: `executable grammar context: ${command}`,
		command,
		stdout: removalOutput,
		calls: [removal],
	})),
	...[
		`[[ "$(${removal})" == "executed rm" ]]`,
		`: "$(( $(${removal} >/dev/null) + 1 ))"`,
		`args[$(${removal} >/dev/null)0]=value`,
		`let 'a[$(${removal} >/dev/null)0]=0'; :`,
	].map((command) => ({
		name: `substitution executes inside an expression: ${command}`,
		command,
		stdout: "",
		calls: [removal],
	})),
	...[
		{ command: 'printf "%s\\n" "$((rm -rf))"', stdout: "0\n" },
		{ command: "[[ x == x && reboot == reboot ]]", stdout: "" },
		{ command: "case x in\nreboot) :;;\nx) :;;\nesac", stdout: "" },
		{ command: "for word in rm -rf ./build; do :; done", stdout: "" },
		{ command: `printf "%s\\n" \${unset:-safe; rm -rf ./build}`, stdout: "safe;\nrm\n-rf\n./build\n" },
		{ command: 'cat <<< "rm -rf ./build"', stdout: `${removal}\n` },
		{ command: "a=(safe); unset 'a[0]'", stdout: "" },
		{ command: "printf '%s\\n' 'a[$(rm -rf ./build)0]'", stdout: "a[$(rm -rf ./build)0]\n" },
		{ command: "printf '%s\\n' value | xargs echo", stdout: "value\n" },
		{ command: "printf '%s\\n' label | xargs bash -c 'printf safe'", stdout: "safe" },
		{ command: "printf -v output %s safe; printf '%s\\n' \"$output\"", stdout: "safe\n" },
		{ command: "eval -- -- 'rm -rf ./build' 2>/dev/null || :", stdout: "" },
		{ command: '"if" rm -rf ./build', stdout: "safe\n" },
		{ command: '"FOO=x" rm -rf ./build', stdout: "safe\n" },
	].map(({ command, stdout }) => ({
		name: `data-only grammar context: ${command}`,
		command,
		stdout,
		calls: [],
	})),
	...[
		{ command: 'COMMAND=rm; "$COMMAND" -rf ./build', stdout: removalOutput },
		{ command: `a=(safe); unset 'a[$(${removal} >/dev/null)0]'`, stdout: "" },
		{ command: `a=(safe); read -r 'a[$(${removal} >/dev/null)0]' <<< ok`, stdout: "" },
		{ command: `printf '%s\\n' '${removal}' | xargs -I{} bash -c '{}'`, stdout: removalOutput },
		{ command: "printf '%s\\n' -rf ./build | xargs rm", stdout: removalOutput },
		{ command: `declare -i a='b[$(${removal} >/dev/null)0]'`, stdout: "" },
		{ command: 'FLAGS=-rf; rm "$FLAGS" ./build', stdout: removalOutput },
		{ command: `cat <<EOF\nhello\nEO\\\nF\n${removal}`, stdout: `hello\n${removalOutput}` },
		{ command: `cat <<EOF\n$\\\n(${removal})\nEOF`, stdout: removalOutput },
		{ command: `cat <\\\n(${removal})`, stdout: removalOutput },
		{ command: "$\\\n'r\\x6d' -rf ./build", stdout: removalOutput },
	].map(({ command, stdout }) => ({
		name: `unsupported context still cannot run unattended: ${command}`,
		command,
		stdout,
		calls: [removal],
		analysisIncomplete: true as const,
	})),
];

describe.skipIf(process.platform === "win32")("command policy agrees with harmless shell execution", () => {
	let directory: string;
	let callLog: string;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "step-command-semantics-"));
		callLog = join(directory, "calls");
		for (const name of ["sh", "cat"]) symlinkSync(`/bin/${name}`, join(directory, name));
		symlinkSync("/bin/echo", join(directory, "echo"));
		symlinkSync("/usr/bin/xargs", join(directory, "xargs"));
		if (existsSync("/bin/dash")) symlinkSync("/bin/dash", join(directory, "dash"));
		writeFileSync(join(directory, "bash"), '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o700 });
		for (const name of ["if", "FOO=x", "safe[", "r[m]"]) {
			writeFileSync(join(directory, name), "#!/bin/sh\nprintf 'safe\\n'\n", { mode: 0o700 });
		}
		for (const name of ["safe-script", "-c"]) writeFileSync(join(directory, name), "printf 'safe\\n'\n");
		writeFileSync(join(directory, "!"), "");
		// PATH contains only this fixture. Nested shells can reach only these harmless replacements.
		const substitute = [
			"#!/bin/sh",
			`printf "%s" "\${0##*/}" >> "$COMMAND_LOG"`,
			'for arg do printf " %s" "$arg" >> "$COMMAND_LOG"; done',
			'printf "\\n" >> "$COMMAND_LOG"',
			`printf "executed %s\\n" "\${0##*/}"`,
			"",
		].join("\n");
		for (const name of ["rm", "reboot"]) writeFileSync(join(directory, name), substitute, { mode: 0o700 });
	});

	beforeEach(() => writeFileSync(callLog, ""));
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	const checkShellCase = async ({
		command,
		stdout,
		calls,
		analysisIncomplete,
		allowedStderr,
	}: ShellCase): Promise<void> => {
		const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
			cwd: directory,
			env: { PATH: directory, COMMAND_LOG: callLog, LC_ALL: "C" },
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(allowedStderr ?? [""]).toContain(result.stderr);
		expect(result.stdout).toBe(stdout);
		expect(readFileSync(callLog, "utf8")).toBe(calls.map((call) => `${call}\n`).join(""));

		const hazardous = calls.length > 0 && !analysisIncomplete;
		expect.soft(isDangerousCommand(command)).toBe(hazardous);
		for (const preset of ["bypass", "autopilot"] as const) {
			expect
				.soft(decideStepToolCall("run_command", { command }, stepPermissionStateForPreset(preset)))
				.toMatchObject({
					action: hazardous || analysisIncomplete ? "confirm" : "allow",
					hazardous,
					...(analysisIncomplete ? { analysisIncomplete: true } : {}),
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
				toolCallId: "shell-context-regression",
				input: { command },
			};
			const result = await controller.handleToolCall(event, { hasUI: false } as ExtensionContext);
			if (hazardous || analysisIncomplete) expect.soft(result).toMatchObject({ block: true, terminate: true });
			else expect.soft(result).toBeUndefined();
		}
	};

	it.each(cases)("$name", checkShellCase);

	it.skipIf(!existsSync("/bin/dash"))("does not trust Bash heredoc boundaries for dash", async () => {
		const script = ["cat <<$'EOF'", "EOF", "printf '%s' '", "$EOF", removal, "#'"].join("\n");
		await checkShellCase({
			name: "dash heredoc dialect",
			command: `dash -c '${script.replaceAll("'", "'\\''")}'`,
			stdout: `EOF\nprintf '%s' '\n${removalOutput}`,
			calls: [removal],
			analysisIncomplete: true,
		});
	});

	it.each([false, true])(
		"Unicode heredoc escapes preserve shell interpretation (alternate in body=%s)",
		async (alternateInBody) => {
			const oracle = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", "printf '%s' $'\\u0045'"], {
				cwd: directory,
				env: { PATH: directory, LC_ALL: "C" },
				encoding: "utf8",
				timeout: 5000,
			});
			expect(oracle.error).toBeUndefined();
			expect(oracle.status, oracle.stderr).toBe(0);
			expect(oracle.stderr).toBe("");
			// Bash 3 preserves this escape; newer Bash versions decode it.
			expect(["E", "\\u0045"]).toContain(oracle.stdout);
			const alternate = oracle.stdout === "E" ? "\\u0045" : "E";
			const body = alternateInBody ? `${alternate}OF\n'\nhello\n` : "hello\n";
			await checkShellCase({
				name: "Unicode heredoc escape",
				analysisIncomplete: true,
				command: `cat <<$'\\u0045OF'\n${body}${oracle.stdout}OF\n${removal}`,
				stdout: `${body}${removalOutput}`,
				calls: [removal],
			});
		},
	);
});
