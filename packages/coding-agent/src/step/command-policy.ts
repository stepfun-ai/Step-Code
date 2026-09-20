const DANGEROUS_LIFECYCLE_COMMANDS = new Set(["reboot", "shutdown"]);
const DANGEROUS_LIFECYCLE_SUBCOMMANDS = new Set(["init", "loginctl", "systemctl", "telinit"]);
const COMMAND_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
	command: [],
	doas: ["-u", "-C"],
	env: ["-u", "--unset", "-C", "--chdir"],
	exec: ["-a"],
	nohup: [],
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
	xargs: ["-a", "--arg-file", "-E", "-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
};
const SHELL_INTERPRETERS = new Set(["bash", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh"]);
const SHELL_CONTROL_PREFIXES = new Set(["!", "{", "}", "do", "elif", "else", "if", "then", "until", "while"]);

interface ShellCommand {
	name: string;
	args: readonly string[];
}

type CommandApprovalRule =
	| { id: string; kind: "shell"; matches: (command: ShellCommand) => boolean }
	| { id: string; kind: "pattern"; pattern: RegExp };

/** Built-in rules cannot be disabled by a permission preset or tool override. */
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

export function findCommandApprovalRule(command: string): string | undefined {
	const commands = collectShellCommands(command);
	return COMMAND_APPROVAL_RULES.find((rule) =>
		rule.kind === "shell" ? commands.some(rule.matches) : rule.pattern.test(command),
	)?.id;
}

export function isDangerousCommand(command: string): boolean {
	return findCommandApprovalRule(command) !== undefined;
}

export function containsDangerousLifecycleCommand(command: string): boolean {
	return collectShellCommands(command).some(isLifecycleCommand);
}

function isRecursiveForceRemove(command: ShellCommand): boolean {
	if (command.name !== "rm") return false;
	let recursive = false;
	let force = false;
	for (const arg of command.args) {
		if (arg === "--") break;
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
			command.args.some((arg) => DANGEROUS_LIFECYCLE_COMMANDS.has(normalizeCommandToken(arg))))
	);
}

/** Inspect literal shell invocations; this does not evaluate arbitrary shell programs. */
function collectShellCommands(command: string): ShellCommand[] {
	const commands: ShellCommand[] = [];
	const { segments, nestedScripts } = tokenizeShellCommands(command);
	for (const nested of nestedScripts) commands.push(...collectShellCommands(nested));
	for (const tokens of segments) {
		const commandToken = findShellCommandToken(tokens);
		if (!commandToken) continue;
		const args = tokens.slice(commandToken.index + 1);
		commands.push({ name: commandToken.name, args });
		if (commandToken.name === "find") {
			for (let index = 0; index < args.length; index += 1) {
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[index]!)) continue;
				const end = args.findIndex((arg, position) => position > index && (arg === ";" || arg === "+"));
				const nested = args.slice(index + 1, end < 0 ? undefined : end);
				if (nested.length > 0) segments.push(nested);
				index = end < 0 ? args.length : end;
			}
		}
		if (!SHELL_INTERPRETERS.has(commandToken.name)) continue;
		for (let index = 0; index < args.length; index += 1) {
			const option = args[index]!;
			if (option === "--") break;
			if (!/^-[^-]*c/u.test(option) && option.toLowerCase() !== "-command") continue;
			const script =
				commandToken.name === "powershell" || commandToken.name === "pwsh"
					? args.slice(index + 1).join(" ")
					: args[index + 1];
			if (script) commands.push(...collectShellCommands(script));
			break;
		}
	}
	return commands;
}

function tokenizeShellCommands(
	command: string,
	heredocBody = false,
): { segments: string[][]; nestedScripts: string[] } {
	const segments: string[][] = [];
	const nestedScripts: string[] = [];
	const hereDocuments: Array<{ delimiter: string; expand: boolean; stripTabs: boolean }> = [];
	let hereDocumentTabs: boolean | undefined;
	let lineSegmentStart = 0;
	let tokens: string[] = [];
	let current = "";
	let tokenStarted = false;
	let tokenQuoted = false;
	let redirectTarget = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const pushToken = (): void => {
		if (tokenStarted) {
			if (!redirectTarget) tokens.push(current);
			if (hereDocumentTabs !== undefined) {
				hereDocuments.push({ delimiter: current, expand: !tokenQuoted, stripTabs: hereDocumentTabs });
				hereDocumentTabs = undefined;
			}
			redirectTarget = false;
		}
		current = "";
		tokenStarted = false;
		tokenQuoted = false;
	};
	const pushSegment = (): void => {
		pushToken();
		if (tokens.length > 0) segments.push(tokens);
		tokens = [];
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (escaped) {
			if (character !== "\n") {
				current += character;
				tokenStarted = true;
			}
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			continue;
		}
		if (character === "\\") {
			if (command[index + 1] !== "\n") tokenQuoted = true;
			if ((quote === '"' || heredocBody) && !["$", "`", '"', "\\", "\n"].includes(command[index + 1] ?? ""))
				current += character;
			else escaped = true;
			continue;
		}
		const parenthesized =
			command[index + 1] === "(" &&
			(character === "$" || (!quote && !heredocBody && (character === "<" || character === ">")));
		if (parenthesized || character === "`") {
			const start = index + (parenthesized ? 2 : 1);
			const end = findSubstitutionEnd(command, start, parenthesized ? ")" : "`");
			nestedScripts.push(command.slice(start, end));
			current += command.slice(index, end + 1);
			tokenStarted = true;
			index = end;
			continue;
		}
		if (heredocBody) continue;
		if (quote === '"') {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "#" && !tokenStarted) {
			while (index < command.length && command[index] !== "\n") index += 1;
			index -= 1;
		} else if (character === "'" || character === '"') {
			quote = character;
			tokenStarted = true;
			tokenQuoted = true;
		} else if (character === "<" || character === ">" || (character === "&" && command[index + 1] === ">")) {
			if (
				/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(current) &&
				command.slice(index - current.length, index) === current
			) {
				current = "";
				tokenStarted = false;
			} else pushToken();
			const redirectStart = index;
			while (/[<>&|]/u.test(command[index + 1] ?? "")) index += 1;
			if (command.slice(redirectStart, index + 1) === "<<") {
				hereDocumentTabs = command[index + 1] === "-";
				if (hereDocumentTabs) index += 1;
			}
			redirectTarget = true;
		} else if (
			character === ";" ||
			character === "&" ||
			character === "|" ||
			character === "(" ||
			character === ")"
		) {
			pushSegment();
			if (command[index + 1] === character) index += 1;
		} else if (character === "\n" || character === "\r") {
			pushSegment();
			const feedsShell = segments.slice(lineSegmentStart).some((segment) => {
				const invocation = findShellCommandToken(segment);
				return invocation !== undefined && SHELL_INTERPRETERS.has(invocation.name);
			});
			for (const hereDocument of hereDocuments) {
				const bodyStart = index + 1;
				let bodyEnd = command.length;
				let cursor = bodyStart;
				index = command.length;
				while (cursor < command.length) {
					const nextNewline = command.indexOf("\n", cursor);
					const lineEnd = nextNewline < 0 ? command.length : nextNewline;
					const line = command.slice(cursor, lineEnd);
					if ((hereDocument.stripTabs ? line.replace(/^\t+/u, "") : line) === hereDocument.delimiter) {
						bodyEnd = cursor;
						index = lineEnd;
						break;
					}
					cursor = lineEnd + 1;
				}
				const body = command.slice(bodyStart, bodyEnd);
				if (feedsShell) nestedScripts.push(body);
				if (hereDocument.expand) nestedScripts.push(...tokenizeShellCommands(body, true).nestedScripts);
			}
			hereDocuments.length = 0;
			lineSegmentStart = segments.length;
		} else if (/\s/u.test(character)) pushToken();
		else {
			current += character;
			tokenStarted = true;
		}
	}
	pushSegment();
	return { segments, nestedScripts };
}

function findSubstitutionEnd(command: string, start: number, closing: ")" | "`"): number {
	let quote: "'" | '"' | undefined;
	let depth = 0;
	for (let index = start; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote === "'") {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "$" && command[index + 1] === "(") {
			index = findSubstitutionEnd(command, index + 2, ")");
			continue;
		}
		if (character === "`") {
			if (closing === "`" && !quote) return index;
			index = findSubstitutionEnd(command, index + 1, "`");
			continue;
		}
		if (quote === '"') {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "#" && (index === start || /[\s;|&()]/u.test(command[index - 1]!))) {
			while (index < command.length && command[index] !== "\n") index += 1;
		} else if (character === "'" || character === '"') quote = character;
		else if (character === "(") depth += 1;
		else if (character === ")") {
			if (depth === 0 && closing === ")") return index;
			depth -= 1;
		}
	}
	return command.length;
}

function findShellCommandToken(tokens: string[]): { name: string; index: number } | undefined {
	let index = 0;
	while (index < tokens.length) {
		const rawToken = tokens[index]!;
		const token = normalizeCommandToken(rawToken);
		if (!token || token === "--" || SHELL_CONTROL_PREFIXES.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rawToken)) {
			index += 1;
			continue;
		}
		const valueOptions = Object.hasOwn(COMMAND_WRAPPERS, token) ? COMMAND_WRAPPERS[token] : undefined;
		if (valueOptions) {
			const wrapperIndex = index;
			index += 1;
			while (index < tokens.length) {
				const option = tokens[index]!;
				if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) {
					index += 1;
					continue;
				}
				if (option === "--") {
					index += 1;
					break;
				}
				if (!option.startsWith("-")) break;
				if (token === "command" && /^-[^-]*[vV]/u.test(option)) return { name: token, index: wrapperIndex };
				index += 1;
				let takesNextValue = valueOptions.includes(option);
				if (option.startsWith("-") && !option.startsWith("--")) {
					for (let flag = 1; flag < option.length; flag += 1) {
						if (!valueOptions.includes(`-${option[flag]}`)) continue;
						takesNextValue = flag === option.length - 1;
						break;
					}
				}
				if (takesNextValue && index < tokens.length) index += 1;
			}
			continue;
		}
		return { name: token, index };
	}
	return undefined;
}

function normalizeCommandToken(token: string): string {
	const stripped = token
		.trim()
		.replace(/^[({!]+/u, "")
		.replace(/[)}]+$/u, "");
	if (!stripped) return "";
	const basename = stripped.split(/[\\/]/u).at(-1) ?? stripped;
	return basename.toLowerCase().replace(/\.exe$/u, "");
}
