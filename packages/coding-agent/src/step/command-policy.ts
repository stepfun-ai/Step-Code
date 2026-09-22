import { inspectShellScript, type ShellInput, type ShellInvocation, type ShellWord } from "./shell-analysis.ts";

const DANGEROUS_LIFECYCLE_COMMANDS = new Set(["reboot", "shutdown"]);
const DANGEROUS_LIFECYCLE_SUBCOMMANDS = new Set(["init", "loginctl", "systemctl", "telinit"]);
const COMMAND_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
	builtin: [],
	command: [],
	doas: ["-u", "-C"],
	env: ["-u", "--unset", "-C", "--chdir"],
	exec: ["-a"],
	nice: ["-n", "--adjustment"],
	nohup: [],
	setsid: [],
	stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
	sudo: [
		"-u",
		"--user",
		"-g",
		"--group",
		"-h",
		"--host",
		"-p",
		"--prompt",
		"-C",
		"-D",
		"--chdir",
		"-R",
		"--chroot",
		"-r",
		"--role",
		"-t",
		"--type",
	],
	time: ["-f", "--format", "-o", "--output"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-a", "--arg-file", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
};
const WRAPPER_FLAGS: Readonly<Record<string, readonly string[]>> = {
	builtin: [],
	command: ["-p", "-v", "-V"],
	doas: ["-n", "-L"],
	env: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
	exec: ["-c", "-l"],
	nice: [],
	nohup: [],
	setsid: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"],
	stdbuf: [],
	sudo: [
		"-n",
		"--non-interactive",
		"-E",
		"--preserve-env",
		"-H",
		"--set-home",
		"-b",
		"--background",
		"-k",
		"-K",
		"-S",
		"--stdin",
	],
	time: ["-p", "--portability", "-v", "--verbose", "-a", "--append"],
	timeout: ["--foreground", "--preserve-status", "-v", "--verbose"],
	xargs: ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit"],
};
const BOURNE_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const OTHER_SHELLS = new Set(["fish", "powershell", "pwsh"]);
const MAX_SCRIPT_DEPTH = 12;
const MAX_ANALYZED_CHARACTERS = 256_000;
const VARIABLE_BUILTINS: Readonly<Record<string, { flags: string; values: string }>> = {
	unset: { flags: "fnv", values: "" },
	read: { flags: "ers", values: "adnNptui" },
	mapfile: { flags: "t", values: "dnOscuC" },
	readarray: { flags: "t", values: "dnOscuC" },
	declare: { flags: "aAfFgiIlnprtux", values: "" },
	typeset: { flags: "aAfFgiIlnprtux", values: "" },
	local: { flags: "aAfFgiIlnprtux", values: "" },
	readonly: { flags: "aAfp", values: "" },
	export: { flags: "fnp", values: "" },
};

interface ShellCommand {
	name: string;
	args: readonly (string | undefined)[];
	operands: readonly ShellWord[];
}

type CommandApprovalRule =
	| { id: string; kind: "shell"; matches: (command: ShellCommand) => boolean }
	| { id: string; kind: "pattern"; pattern: RegExp };

/** Rule meaning is independent of shell grammar and permission presets. */
const COMMAND_APPROVAL_RULES: readonly CommandApprovalRule[] = [
	{ id: "recursive-force-remove", kind: "shell", matches: isRecursiveForceRemove },
	{ id: "system-lifecycle", kind: "shell", matches: isLifecycleCommand },
	{ id: "format-filesystem", kind: "pattern", pattern: /\bmkfs(?:\.[\w.-]+)?\b/iu },
	{ id: "copy-device", kind: "pattern", pattern: /\bdd\s+if=/iu },
	{ id: "truncate-device", kind: "pattern", pattern: /\b:>\s*\/dev\//u },
	{
		id: "destructive-git",
		kind: "pattern",
		pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|push\s+[^\n]*--force(?:-with-lease)?)/iu,
	},
	{ id: "destructive-sql", kind: "pattern", pattern: /\b(?:drop\s+database|truncate\s+table)\b/iu },
];

export type CommandPolicyAnalysis =
	| { kind: "matched"; ruleId: string }
	| { kind: "unresolved"; reason: string }
	| { kind: "ordinary" };

/** An ordinary result means no static rule matched, not that a program is sandboxed. */
export function analyzeCommandPolicy(command: string, dialect: "bash" | "unsupported" = "bash"): CommandPolicyAnalysis {
	const inspection = collectShellCommands(command);
	if (inspection.syntaxUnresolved) return { kind: "unresolved", reason: inspection.unresolved ?? "shell-syntax" };
	const rule = COMMAND_APPROVAL_RULES.find((candidate) =>
		candidate.kind === "shell" ? inspection.commands.some(candidate.matches) : candidate.pattern.test(command),
	);
	if (rule) return { kind: "matched", ruleId: rule.id };
	if (dialect !== "bash") return { kind: "unresolved", reason: "unsupported-shell" };
	if (inspection.unresolved) return { kind: "unresolved", reason: inspection.unresolved };
	return { kind: "ordinary" };
}

/** Detection alone is not authorization: callers must also handle unresolved analysis. */
export function findCommandApprovalRule(command: string): string | undefined {
	const result = analyzeCommandPolicy(command);
	return result.kind === "matched" ? result.ruleId : undefined;
}

export function isDangerousCommand(command: string): boolean {
	return findCommandApprovalRule(command) !== undefined;
}

export function containsDangerousLifecycleCommand(command: string): boolean {
	return collectShellCommands(command).commands.some(isLifecycleCommand);
}

function isRecursiveForceRemove(command: ShellCommand): boolean {
	if (command.name !== "rm") return false;
	let recursive = false;
	let force = false;
	for (const arg of command.args) {
		if (arg === "--") break;
		if (arg === undefined) continue;
		if (arg === "--recursive") recursive = true;
		else if (arg === "--force") force = true;
		else if (arg.startsWith("-") && !arg.startsWith("--")) {
			recursive ||= /[rR]/u.test(arg.slice(1));
			force ||= arg.includes("f");
		}
	}
	return recursive && force;
}

function isLifecycleCommand(command: ShellCommand): boolean {
	return (
		DANGEROUS_LIFECYCLE_COMMANDS.has(command.name) ||
		(DANGEROUS_LIFECYCLE_SUBCOMMANDS.has(command.name) &&
			command.args.some((arg) => arg !== undefined && DANGEROUS_LIFECYCLE_COMMANDS.has(arg)))
	);
}

function collectShellCommands(command: string): {
	commands: ShellCommand[];
	unresolved?: string;
	syntaxUnresolved: boolean;
} {
	const commands: ShellCommand[] = [];
	let unresolved: string | undefined;
	let syntaxUnresolved = false;
	let analyzedCharacters = 0;
	const pending = [{ text: command, depth: 0 }];
	const seen = new Set<string>();
	const arrayVariables = new Set<string>();
	const arrayValues: { target: string; value?: string; depth: number }[] = [];
	const enqueue = (text: string | undefined, depth: number): void => {
		if (text === undefined) unresolved ??= "dynamic-script";
		else if (!seen.has(text)) pending.push({ text, depth });
	};
	do {
		for (let next = pending.shift(); next; next = pending.shift()) {
			if (seen.has(next.text)) continue;
			seen.add(next.text);
			analyzedCharacters += next.text.length;
			if (next.depth > MAX_SCRIPT_DEPTH || analyzedCharacters > MAX_ANALYZED_CHARACTERS) {
				unresolved ??= "analysis-limit";
				continue;
			}
			const parsed = inspectShellScript(next.text);
			for (const variable of parsed.arrayVariables) arrayVariables.add(variable);
			syntaxUnresolved ||= parsed.unresolved !== undefined;
			unresolved ??= parsed.unresolved;
			const invocations = [...parsed.commands];
			for (let position = 0; position < invocations.length; position += 1) {
				if (invocations.length > 4096) {
					unresolved ??= "analysis-limit";
					break;
				}
				const invocation = invocations[position]!;
				const unwrapped = unwrapInvocation(invocation.words);
				if (!unwrapped.command) {
					unresolved ??= unwrapped.unresolved;
					continue;
				}
				const current = unwrapped.command;
				commands.push(current);
				unresolved ??= unwrapped.unresolved;
				if (
					((current.name === "rm" && !isRecursiveForceRemove(current)) ||
						(DANGEROUS_LIFECYCLE_SUBCOMMANDS.has(current.name) && !isLifecycleCommand(current))) &&
					current.args
						.slice(0, current.args.indexOf("--") < 0 ? undefined : current.args.indexOf("--"))
						.includes(undefined)
				) {
					unresolved ??= "dynamic-options";
				}
				if (current.name === "find") {
					if (current.args.includes(undefined)) unresolved ??= "dynamic-find";
					for (let index = 0; index < current.args.length; index += 1) {
						if (!["-exec", "-execdir", "-ok", "-okdir"].includes(current.args[index] ?? "")) continue;
						const end = current.args.findIndex((arg, offset) => offset > index && (arg === ";" || arg === "+"));
						invocations.push({ words: current.operands.slice(index + 1, end < 0 ? undefined : end) });
						index = end < 0 ? current.args.length : end;
					}
				}
				if (current.name === "eval") {
					const source = current.args[0] === "--" ? current.args.slice(1) : current.args;
					enqueue(source.includes(undefined) ? undefined : source.join(" "), next.depth + 1);
				} else if (current.name === "let") {
					for (const expression of current.args) {
						enqueue(expression === undefined ? undefined : `((${expression}))`, next.depth + 1);
					}
				} else if (current.name === "trap" && !["-p", "-l", "-"].includes(current.args[0] ?? "")) {
					enqueue(current.args[current.args[0] === "--" ? 1 : 0], next.depth + 1);
				}
				const builtin = inspectBuiltinOperands(current);
				unresolved ??= builtin.unresolved;
				for (const variable of builtin.arrays) arrayVariables.add(variable);
				for (const assignment of builtin.arrayValues) arrayValues.push({ ...assignment, depth: next.depth + 1 });
				if (!BOURNE_SHELLS.has(current.name) && !OTHER_SHELLS.has(current.name)) continue;
				const script = interpreterScript(current);
				if (script.kind === "script") enqueue(script.text, next.depth + 1);
				if (script.kind === "stdin") {
					const input = invocation.input ?? pipelineInput(invocation.pipelineInput);
					if (input) enqueue(input.text, next.depth + 1);
				}
				if (script.kind === "unresolved") unresolved ??= "interpreter-options";
				if (current.name !== "bash") {
					// Bash grammar is not evidence that another shell interpreted all syntax.
					unresolved ??= "unsupported-shell";
				}
			}
		}
		// Array attributes can be established in another branch, loop iteration, or literal eval.
		// Collect possible array names before deciding whether a declaration can reparse its value.
		for (const assignment of arrayValues) {
			if (!arrayVariables.has(assignment.target)) continue;
			if (assignment.value === undefined) unresolved ??= "dynamic-array-assignment";
			else if (assignment.value.startsWith("("))
				enqueue(`${assignment.target}=${assignment.value}`, assignment.depth);
		}
	} while (pending.length > 0);
	return { commands, unresolved, syntaxUnresolved };
}

/** Resolve only the data flow we know: literal stdin passed through cat. */
function pipelineInput(producer: ShellInvocation | undefined, depth = 0): ShellInput | undefined {
	if (!producer) return undefined;
	if (depth > MAX_SCRIPT_DEPTH) return {};
	const { command } = unwrapInvocation(producer.words);
	if (command?.name !== "cat" || command.args.some((arg) => arg !== "-" && arg !== "--")) return {};
	return producer.input ?? pipelineInput(producer.pipelineInput, depth + 1) ?? {};
}

interface BuiltinOperandInspection {
	unresolved?: string;
	arrays: string[];
	arrayValues: { target: string; value?: string }[];
}

/** Variable destinations and compound array values can be evaluated after quote removal. */
function inspectBuiltinOperands({ name, args, operands }: ShellCommand): BuiltinOperandInspection {
	const result: BuiltinOperandInspection = { arrays: [], arrayValues: [] };
	const unknown = (reason: string): BuiltinOperandInspection => ({ ...result, unresolved: reason });
	const simpleTarget = (value: string | undefined): value is string =>
		value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*(?:\[-?\d+\])?$/u.test(value);
	const recordIndexedTarget = (value: string | undefined): void => {
		const array = /^([A-Za-z_][A-Za-z0-9_]*)\[/u.exec(value ?? "");
		if (array) result.arrays.push(array[1]!);
	};
	if (name === "printf") {
		if (args[0] === "-v") recordIndexedTarget(args[1]);
		return args[0] === undefined || (args[0] === "-v" && !simpleTarget(args[1]))
			? unknown("variable-operand")
			: result;
	}
	if (name === "getopts") {
		recordIndexedTarget(args[1]);
		return simpleTarget(args[1]) ? result : unknown("variable-operand");
	}
	const options = Object.hasOwn(VARIABLE_BUILTINS, name) ? VARIABLE_BUILTINS[name] : undefined;
	if (!options) return result;
	const acceptsAssignments = ["declare", "typeset", "local", "readonly", "export"].includes(name);
	const isScalarAssignment = (word: ShellWord): word is Exclude<ShellWord, string | undefined> =>
		acceptsAssignments &&
		typeof word === "object" &&
		(!word.requiresAssignmentContext || word.assignmentCommand === name) &&
		simpleTarget(word.assignmentTarget);
	let index = 0;
	let functionsOnly = false;
	let arrayAttribute = name === "mapfile" || name === "readarray";
	while (index < args.length) {
		if (isScalarAssignment(operands[index])) break;
		const option = args[index];
		if (option === undefined) return unknown("builtin-options");
		if (option === "--") {
			index += 1;
			break;
		}
		if (!option.startsWith("-") || option === "-") break;
		if (option.startsWith("--")) return unknown("builtin-options");
		index += 1;
		for (let flag = 1; flag < option.length; flag += 1) {
			const token = option[flag]!;
			if (options.values.includes(token)) {
				const value = flag + 1 < option.length ? option.slice(flag + 1) : args[index++];
				if (value === undefined) return unknown("builtin-options");
				if ((name === "mapfile" || name === "readarray") && token === "C") return unknown("builtin-callback");
				if (name === "read" && token === "a") {
					if (!simpleTarget(value)) return unknown("variable-operand");
					result.arrays.push(value.split("[", 1)[0]!);
				}
				break;
			}
			if (!options.flags.includes(token)) return unknown("builtin-options");
			if (token === "f" || token === "F") functionsOnly = true;
			if (token === "a" || token === "A") arrayAttribute = true;
			// Integer/nameref attributes can promote later assignments to evaluation.
			if (["declare", "typeset", "local"].includes(name) && (token === "i" || token === "n" || token === "I")) {
				return unknown("variable-attributes");
			}
		}
	}
	if (functionsOnly) return result;
	if (arrayAttribute && index === operands.length && (name === "mapfile" || name === "readarray")) {
		result.arrays.push("MAPFILE");
	}
	for (const operand of operands.slice(index)) {
		const value = shellWordValue(operand);
		const target = isScalarAssignment(operand)
			? operand.assignmentTarget
			: value?.split("=", 1)[0]?.replace(/\+$/u, "");
		if (!simpleTarget(target)) return unknown("variable-operand");
		const variable = target.split("[", 1)[0]!;
		if (arrayAttribute) result.arrays.push(variable);
		if (name !== "unset") recordIndexedTarget(target);
		if (acceptsAssignments && (arrayAttribute || ["declare", "typeset", "local"].includes(name))) {
			if (value === undefined) result.arrayValues.push({ target: variable });
			else if (value.includes("="))
				result.arrayValues.push({ target: variable, value: value.slice(value.indexOf("=") + 1) });
		}
	}
	return result;
}

function shellWordValue(word: ShellWord): string | undefined {
	return typeof word === "string" ? word : undefined;
}

function unwrapInvocation(words: readonly ShellWord[]): { command?: ShellCommand; unresolved?: string } {
	let index = 0;
	while (index < words.length) {
		const executable = shellWordValue(words[index]);
		if (executable === undefined) return { unresolved: "dynamic-command" };
		const name = normalizeExecutable(executable);
		const valueOptions = Object.hasOwn(COMMAND_WRAPPERS, name) ? COMMAND_WRAPPERS[name]! : undefined;
		if (!valueOptions) {
			const operands = words.slice(index + 1);
			return { command: { name, args: operands.map(shellWordValue), operands } };
		}
		const wrapperIndex = index++;
		let replacement: string | undefined;
		while (index < words.length) {
			const word = words[index];
			if (name === "env" && typeof word === "object" && !word.requiresAssignmentContext) {
				index += 1;
				continue;
			}
			const option = shellWordValue(word);
			if (option === undefined) return { unresolved: "dynamic-wrapper" };
			if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(option)) {
				index += 1;
				continue;
			}
			if (option === "--") {
				index += 1;
				break;
			}
			if (!option.startsWith("-") || option === "-") break;
			if (name === "command" && /^-[^-]*[vV]/u.test(option)) {
				const operands = words.slice(wrapperIndex + 1);
				return { command: { name, args: operands.map(shellWordValue), operands } };
			}
			if (name === "env" && (option.startsWith("--split-string") || /^-[^-]*S/u.test(option))) {
				return { unresolved: "wrapper-split-string" };
			}
			index += 1;
			let takesNextValue = false;
			if (option.startsWith("--")) {
				const separator = option.indexOf("=");
				const optionName = separator < 0 ? option : option.slice(0, separator);
				if (valueOptions.includes(optionName)) takesNextValue = separator < 0;
				else if (separator >= 0 || !WRAPPER_FLAGS[name]?.includes(optionName))
					return { unresolved: "wrapper-options" };
			} else {
				for (let flag = 1; flag < option.length; flag += 1) {
					const token = `-${option[flag]}`;
					if (valueOptions.includes(token)) {
						takesNextValue = flag === option.length - 1;
						if (name === "xargs" && token === "-I") {
							replacement = takesNextValue ? shellWordValue(words[index]) : option.slice(flag + 1);
							if (!replacement) return { unresolved: "xargs-input" };
						}
						break;
					}
					if (!WRAPPER_FLAGS[name]?.includes(token)) return { unresolved: "wrapper-options" };
				}
			}
			if (takesNextValue) {
				if (shellWordValue(words[index]) === undefined) return { unresolved: "dynamic-wrapper" };
				index += 1;
			}
		}
		if (name === "timeout") {
			// DURATION is mandatory; only subsequent words can name the wrapped command.
			if (shellWordValue(words[index]) === undefined) return { unresolved: "dynamic-wrapper" };
			index += 1;
		}
		if (name === "xargs" && index < words.length) {
			const remaining = words.slice(index).map(shellWordValue);
			// Input either appends arguments or replaces text inside existing words.
			// Keep that uncertainty in argv instead of analyzing the placeholder as code.
			words = words
				.slice(0, index)
				.concat(
					replacement === undefined
						? [...remaining, undefined]
						: remaining.map((word) => (word?.includes(replacement!) ? undefined : word)),
				);
		}
	}
	return {};
}

type InterpreterScript = { kind: "script"; text?: string } | { kind: "stdin" | "file" | "unresolved" };

/** Interpreter argv semantics live above the grammar; positional arguments are never reparsed as code. */
function interpreterScript(command: ShellCommand): InterpreterScript {
	const { args, name } = command;
	if (OTHER_SHELLS.has(name)) {
		for (let index = 0; index < args.length; index += 1) {
			const option = args[index];
			if (option === undefined) return { kind: "unresolved" };
			if (option === "--") return { kind: "file" };
			if (/^-[^-]*c/u.test(option) || option.toLowerCase() === "-command") {
				const script = args.slice(index + 1);
				return {
					kind: "script",
					text: script.includes(undefined) ? undefined : name === "fish" ? script[0] : script.join(" "),
				};
			}
		}
		return { kind: "unresolved" };
	}
	let commandString = false;
	let standardInput = false;
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === undefined) return commandString ? { kind: "script" } : { kind: "unresolved" };
		if (option === "--" || option === "-" || !/^[+-]/u.test(option)) {
			if (commandString)
				return { kind: "script", text: option === "--" || option === "-" ? args[index + 1] : option };
			return {
				kind:
					standardInput || index + (option === "--" || option === "-" ? 1 : 0) === args.length ? "stdin" : "file",
			};
		}
		const namedOption = /^[+-][^-]*?[oO](.*)$/u.exec(option);
		const switches = name === "zsh" && namedOption ? option.slice(0, option.length - namedOption[1]!.length) : option;
		commandString ||= /^-[^-]*c/u.test(switches);
		standardInput ||= /^-[^-]*s/u.test(switches);
		if (option === "--rcfile" || option === "--init-file") {
			if (args[++index] === undefined) return { kind: "unresolved" };
		} else if (namedOption && !(name === "zsh" && namedOption[1])) {
			if (args[index + 1] === undefined && index + 1 < args.length) return { kind: "unresolved" };
			if (args[index + 1] !== undefined && !/^[+-]/u.test(args[index + 1]!)) index += 1;
		}
	}
	return commandString ? { kind: "unresolved" } : { kind: "stdin" };
}

function normalizeExecutable(word: string): string {
	if (process.platform === "win32") return (word.split(/[\\/]/u).at(-1) ?? word).toLowerCase().replace(/\.exe$/u, "");
	const name = word.split("/").at(-1) ?? word;
	// macOS can resolve case variants on case-insensitive volumes; approval must cover those lookups.
	return process.platform === "darwin" ? name.toLowerCase() : name;
}
