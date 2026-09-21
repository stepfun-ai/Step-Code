import {
	type ArithmeticExpression,
	type AssignmentPrefix,
	type Node,
	type ParsedScript,
	parse,
	type Redirect,
	type TestExpression,
	type Word,
	type WordPart,
} from "unbash";

export interface ShellInput {
	text?: string;
}

export type ShellWord =
	| string
	| { assignmentTarget: string; requiresAssignmentContext: boolean; assignmentCommand?: string }
	| undefined;

export interface ShellInvocation {
	words: ShellWord[];
	input?: ShellInput;
	pipelineInput?: ShellInvocation;
}

export interface ShellInspection {
	commands: ShellInvocation[];
	arrayVariables: Set<string>;
	unresolved?: string;
}

const MAX_SOURCE_LENGTH = 128_000;
const MAX_VISITED_NODES = 20_000;
const MAX_DEPTH = 128;

interface InspectedWord {
	value?: string;
	prefix: string;
	pattern: string;
	maySplit: boolean;
}

function quotedPattern(value: string): string {
	return value.replace(/[\\*?[\]!^]/gu, "\\$&");
}

function hasFilenameExpansion(pattern: string): boolean {
	for (let index = 0; index < pattern.length; index += 1) {
		if (pattern[index] === "\\") {
			index += 1;
			continue;
		}
		if (pattern[index] === "*" || pattern[index] === "?") return true;
		if (pattern[index] !== "[") continue;
		let end = index + 1;
		if (pattern[end] === "!" || pattern[end] === "^") end += 1;
		// A leading ] belongs to the set; a later unquoted ] must close it.
		if (pattern[end] === "]") end += 1;
		for (; end < pattern.length; end += 1) {
			if (pattern[end] === "\\") end += 1;
			else if (pattern[end] === "]" || pattern[end] === "*" || pattern[end] === "?") return true;
		}
		return false;
	}
	return false;
}

function unsupportedNode(_node: never): never {
	throw new Error("Unsupported shell syntax node");
}

/** Preserve shell syntax roles without evaluating variables, programs, or command-specific options. */
export function inspectShellScript(source: string): ShellInspection {
	const arrayVariables = new Set<string>();
	const result: ShellInspection = { commands: [], arrayVariables };
	let visited = 0;
	let parsedLength = 0;
	const heredocs = new Map<string, Redirect[]>();
	const untrustedRedirects = new Set<Redirect>();
	const unknown = (reason: string): void => {
		result.unresolved ??= reason;
	};
	const enter = (depth: number): boolean => {
		if (++visited > MAX_VISITED_NODES || depth > MAX_DEPTH) {
			unknown("Shell syntax exceeds the inspection budget");
			return false;
		}
		return true;
	};
	const parseSource = (text: string): ParsedScript | undefined => {
		parsedLength += text.length;
		if (parsedLength > MAX_SOURCE_LENGTH) {
			unknown("Shell source exceeds the inspection budget");
			return undefined;
		}
		return parse(text);
	};

	function visitScript(script: ParsedScript, ownerSource: string, depth: number): void {
		if (!enter(depth)) return;
		if (script.errors?.length) unknown("Shell syntax could not be fully parsed");
		const scriptSource = script.source ?? ownerSource;
		for (const statement of script.commands) visitNode(statement, scriptSource, depth + 1);
	}

	function visitParts(parts: readonly WordPart[], ownerSource: string, depth: number, quoted = false): InspectedWord {
		const result: InspectedWord = { value: "", prefix: "", pattern: "", maySplit: false };
		if (!enter(depth)) return { ...result, value: undefined, maySplit: true };
		for (const part of parts) {
			if (!enter(depth + 1)) return { ...result, value: undefined, maySplit: true };
			let value: string | undefined;
			let nested: InspectedWord | undefined;
			let pattern = "";
			let maySplit = false;
			switch (part.type) {
				case "Literal":
					if (part.text.includes("$\\\n")) {
						unknown("Continued expansion syntax could not be fully parsed");
						break;
					}
					value = part.value;
					pattern = quoted ? quotedPattern(value) : part.text.replaceAll("\\\n", "");
					break;
				case "SingleQuoted":
					value = part.value;
					pattern = quotedPattern(value);
					break;
				case "AnsiCQuoted":
					// Byte, Unicode, and control escapes differ across shell versions and encodings.
					if (!/[\u0000-\u001f\u007f-\uffff]/u.test(part.value) && !/\\[uUc]/u.test(part.text)) {
						value = part.value;
						pattern = quotedPattern(value);
					}
					break;
				case "DoubleQuoted":
				case "LocaleString":
					nested = visitParts(part.parts, ownerSource, depth + 1, true);
					break;
				case "CommandExpansion":
				case "ProcessSubstitution": {
					const closing = part.text.startsWith("`") ? "`" : part.text.startsWith("${") ? "}" : ")";
					if (!part.text.endsWith(closing)) unknown("Nested shell boundary could not be verified");
					if (part.script) visitScript(part.script, ownerSource, depth + 1);
					else unknown("Nested shell syntax could not be fully parsed");
					maySplit = !quoted;
					break;
				}
				case "ArithmeticExpansion":
					if (part.expression) visitArithmetic(part.expression, ownerSource, depth + 1);
					else unknown("Shell arithmetic could not be fully parsed");
					maySplit = !quoted;
					break;
				case "ParameterExpansion":
					if (part.index !== undefined && (part.operator === "=" || part.operator === ":=")) {
						arrayVariables.add(part.parameter);
					}
					if (part.indexParts) visitParts(part.indexParts, ownerSource, depth + 1);
					maySplit =
						!quoted ||
						(!part.length &&
							(part.parameter === "@" ||
								part.index === "@" ||
								(part.indirect === true && part.parameter.endsWith("@"))));
					if (part.operand) {
						const operand = inspectWord(part.operand, ownerSource, depth + 1, quoted);
						maySplit ||= operand.maySplit;
					}
					if (part.slice) {
						visitWord(part.slice.offset, ownerSource, depth + 1);
						if (part.slice.length) visitWord(part.slice.length, ownerSource, depth + 1);
					}
					if (part.replace) {
						visitWord(part.replace.pattern, ownerSource, depth + 1);
						visitWord(part.replace.replacement, ownerSource, depth + 1);
					}
					break;
				case "BraceExpansion":
				case "ExtendedGlob":
					if (part.parts) visitParts(part.parts, ownerSource, depth + 1);
					maySplit = true;
					break;
				case "SimpleExpansion":
					maySplit = !quoted || part.text === "$@";
					break;
				default:
					return unsupportedNode(part);
			}
			if (nested) {
				value = nested.value;
				pattern = nested.pattern;
				maySplit = nested.maySplit;
			}
			if (result.value !== undefined) result.prefix += nested?.prefix ?? value ?? "";
			result.value = result.value !== undefined && value !== undefined ? result.value + value : undefined;
			result.pattern += pattern;
			result.maySplit ||= maySplit;
		}
		return result;
	}

	function inspectWord(word: Word, ownerSource: string, depth: number, quoted = false): InspectedWord {
		if (!enter(depth)) return { prefix: "", pattern: "", maySplit: true };
		// These getters are non-enumerable. Object-key traversal silently misses substitutions.
		const parts = word.parts;
		const result = parts
			? visitParts(parts, ownerSource, depth + 1, quoted)
			: {
					value: word.value,
					prefix: word.value,
					pattern: quoted ? quotedPattern(word.value) : word.text.replaceAll("\\\n", ""),
					maySplit: false,
				};
		if (hasFilenameExpansion(result.pattern)) {
			result.value = undefined;
			result.maySplit = true;
		}
		return result;
	}

	function visitWord(word: Word, ownerSource: string, depth: number, quoted = false): string | undefined {
		return inspectWord(word, ownerSource, depth, quoted).value;
	}

	function visitAssignment(assignment: AssignmentPrefix, ownerSource: string, depth: number): void {
		if (!enter(depth)) return;
		if (assignment.name && (assignment.array !== undefined || assignment.index !== undefined)) {
			arrayVariables.add(assignment.name);
		}
		if (assignment.indexParts) visitParts(assignment.indexParts, ownerSource, depth + 1);
		if (assignment.value) visitWord(assignment.value, ownerSource, depth + 1);
		for (const value of assignment.array ?? []) visitWord(value, ownerSource, depth + 1);
	}

	function visitArithmetic(expression: ArithmeticExpression, ownerSource: string, depth: number): void {
		if (!enter(depth)) return;
		switch (expression.type) {
			case "ArithmeticBinary":
				visitArithmetic(expression.left, ownerSource, depth + 1);
				visitArithmetic(expression.right, ownerSource, depth + 1);
				break;
			case "ArithmeticUnary":
				visitArithmetic(expression.operand, ownerSource, depth + 1);
				break;
			case "ArithmeticTernary":
				visitArithmetic(expression.test, ownerSource, depth + 1);
				visitArithmetic(expression.consequent, ownerSource, depth + 1);
				visitArithmetic(expression.alternate, ownerSource, depth + 1);
				break;
			case "ArithmeticGroup":
				visitArithmetic(expression.expression, ownerSource, depth + 1);
				break;
			case "ArithmeticWord":
				if (/^[A-Za-z_][A-Za-z0-9_]*\[/u.test(expression.value)) {
					arrayVariables.add(expression.value.slice(0, expression.value.indexOf("[")));
				}
				if (expression.parts) visitParts(expression.parts, ownerSource, depth + 1);
				break;
			case "ArithmeticCommandExpansion":
				if (expression.script) visitScript(expression.script, ownerSource, depth + 1);
				else unknown("Nested shell arithmetic could not be fully parsed");
				break;
			default:
				unsupportedNode(expression);
		}
	}

	function visitTest(expression: TestExpression, ownerSource: string, depth: number): void {
		if (!enter(depth)) return;
		switch (expression.type) {
			case "TestUnary":
				visitWord(expression.operand, ownerSource, depth + 1);
				break;
			case "TestBinary":
				visitWord(expression.left, ownerSource, depth + 1);
				visitWord(expression.right, ownerSource, depth + 1);
				break;
			case "TestLogical":
				visitTest(expression.left, ownerSource, depth + 1);
				visitTest(expression.right, ownerSource, depth + 1);
				break;
			case "TestNot":
				visitTest(expression.operand, ownerSource, depth + 1);
				break;
			case "TestGroup":
				visitTest(expression.expression, ownerSource, depth + 1);
				break;
			default:
				unsupportedNode(expression);
		}
	}

	function visitRedirects(
		redirects: readonly Redirect[],
		ownerSource: string,
		depth: number,
		inherited?: ShellInput,
	): ShellInput | undefined {
		let input = inherited;
		for (const redirect of redirects) {
			if (!enter(depth)) return input;
			if (redirect.fileDescriptor !== undefined || redirect.variableName !== undefined) {
				const descriptor =
					redirect.variableName !== undefined
						? `{${redirect.variableName}}`
						: /^\d+/u.exec(ownerSource.slice(redirect.pos))?.[0];
				if (!descriptor || !ownerSource.startsWith(descriptor + redirect.operator, redirect.pos)) {
					unknown("Shell redirection descriptor lost its quote provenance");
					untrustedRedirects.add(redirect);
				}
			}
			let text: string | undefined;
			if (redirect.operator === "<<" || redirect.operator === "<<-") {
				const entries = heredocs.get(ownerSource) ?? [];
				entries.push(redirect);
				heredocs.set(ownerSource, entries);
				const delimiter = redirect.target?.text ?? "";
				if (delimiter.includes("$'") && delimiter.includes("\\")) {
					unknown("Escaped ANSI heredoc delimiters have shell-dependent boundaries");
				}
				if (!redirect.heredocQuoted && redirect.content?.includes("\\\n")) {
					unknown("Continued heredoc lines have unsupported parser boundaries");
				}
				text = redirect.body ? visitWord(redirect.body, ownerSource, depth + 1, true) : redirect.content;
				if (text !== undefined && redirect.operator === "<<-") text = text.replace(/^\t+/gm, "");
			} else if (redirect.target) {
				const value = visitWord(redirect.target, ownerSource, depth + 1, redirect.operator === "<<<");
				if (redirect.operator === "<<<" && value !== undefined) text = `${value}\n`;
			}
			if (
				(redirect.fileDescriptor === undefined || redirect.fileDescriptor === 0) &&
				!redirect.variableName &&
				["<", "<<", "<<-", "<<<", "<>", "<&"].includes(redirect.operator)
			) {
				input = text === undefined ? {} : { text };
			}
		}
		return input;
	}

	function visitNode(
		node: Node,
		ownerSource: string,
		depth: number,
		input?: ShellInput,
		pipelineInput?: ShellInvocation,
	): ShellInvocation | undefined {
		if (!enter(depth)) return undefined;
		switch (node.type) {
			case "Command": {
				for (const assignment of node.prefix) visitAssignment(assignment, ownerSource, depth + 1);
				const directInput = visitRedirects(node.redirects, ownerSource, depth + 1, input);
				if (!node.name) return undefined;
				const words = [node.name, ...node.suffix].map((word): ShellWord => {
					const inspected = inspectWord(word, ownerSource, depth + 1);
					if (inspected.value !== undefined) return inspected.value;
					const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u.exec(inspected.prefix);
					if (!assignment) return undefined;
					return {
						assignmentTarget: assignment[1]!,
						requiresAssignmentContext: inspected.maySplit,
						// Only an unquoted declaration command and assignment token suppress splitting.
						...(/^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(word.text) && node.name?.text === node.name?.value
							? { assignmentCommand: node.name?.text }
							: {}),
					};
				});
				// The parser exposes declaration arrays as raw words, including behind wrappers.
				// Reparse only assignment-shaped data, never ordinary arguments as commands.
				for (const word of node.suffix) {
					if (!word.parts && word.text.includes("=")) {
						const assignmentScript = parseSource(word.text);
						if (!assignmentScript) continue;
						if (assignmentScript.errors?.length) unknown("Shell declaration could not be fully parsed");
						for (const statement of assignmentScript.commands) {
							if (statement.command.type === "Command" && !statement.command.name) {
								for (const assignment of statement.command.prefix)
									visitAssignment(assignment, word.text, depth + 1);
							}
						}
					}
				}
				if (node.redirects.some((redirect) => untrustedRedirects.has(redirect))) return undefined;
				const invocation: ShellInvocation = { words };
				if (directInput) invocation.input = directInput;
				if (pipelineInput) invocation.pipelineInput = pipelineInput;
				result.commands.push(invocation);
				return invocation;
			}
			case "Statement":
				return visitNode(
					node.command,
					ownerSource,
					depth + 1,
					visitRedirects(node.redirects, ownerSource, depth + 1, input),
					pipelineInput,
				);
			case "Pipeline": {
				let previous = pipelineInput;
				for (let index = 0; index < node.commands.length; index += 1) {
					previous = visitNode(
						node.commands[index]!,
						ownerSource,
						depth + 1,
						index === 0 ? input : undefined,
						previous,
					) ?? {
						words: [undefined],
					};
				}
				return previous;
			}
			case "AndOr":
			case "CompoundList":
				for (const command of node.commands) visitNode(command, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "If":
				visitNode(node.clause, ownerSource, depth + 1, input, pipelineInput);
				visitNode(node.then, ownerSource, depth + 1, input, pipelineInput);
				if (node.else) visitNode(node.else, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "For":
			case "Select":
				for (const word of node.wordlist) visitWord(word, ownerSource, depth + 1);
				visitNode(node.body, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "While":
				visitNode(node.clause, ownerSource, depth + 1, input, pipelineInput);
				visitNode(node.body, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "Function":
			case "Coproc":
				visitNode(
					node.body,
					ownerSource,
					depth + 1,
					visitRedirects(node.redirects, ownerSource, depth + 1, input),
					pipelineInput,
				);
				break;
			case "Subshell":
			case "BraceGroup":
				visitNode(node.body, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "Case":
				visitWord(node.word, ownerSource, depth + 1);
				for (const item of node.items) {
					for (const word of item.pattern) visitWord(word, ownerSource, depth + 1);
					visitNode(item.body, ownerSource, depth + 1, input, pipelineInput);
				}
				break;
			case "ArithmeticFor":
				if (node.initialize) visitArithmetic(node.initialize, ownerSource, depth + 1);
				if (node.test) visitArithmetic(node.test, ownerSource, depth + 1);
				if (node.update) visitArithmetic(node.update, ownerSource, depth + 1);
				visitNode(node.body, ownerSource, depth + 1, input, pipelineInput);
				break;
			case "ArithmeticCommand":
				if (node.expression) visitArithmetic(node.expression, ownerSource, depth + 1);
				else if (node.body.trim()) unknown("Shell arithmetic could not be fully parsed");
				break;
			case "TestCommand":
				visitTest(node.expression, ownerSource, depth + 1);
				break;
			default:
				return unsupportedNode(node);
		}
		return undefined;
	}

	try {
		const script = parseSource(source);
		if (script) visitScript(script, source, 0);
		for (const [ownerSource, redirects] of heredocs) {
			const continuations = new Map<number, number>();
			for (const redirect of redirects.sort((left, right) => left.pos - right.pos)) {
				const headerEnd = ownerSource.indexOf("\n", redirect.end);
				const bodyStart = redirect.body?.pos ?? continuations.get(headerEnd) ?? headerEnd + 1;
				const bodyEnd = bodyStart + (redirect.content?.length ?? 0);
				const newline = ownerSource.indexOf("\n", bodyEnd);
				const closeEnd = newline < 0 ? ownerSource.length : newline;
				let closingLine = ownerSource.slice(bodyEnd, closeEnd);
				if (redirect.operator === "<<-") closingLine = closingLine.replace(/^\t+/u, "");
				// Validate the boundary the AST claims; do not search for an alternative delimiter.
				if (
					headerEnd < 0 ||
					bodyEnd >= ownerSource.length ||
					redirect.content === undefined ||
					ownerSource.slice(bodyStart, bodyEnd) !== redirect.content ||
					closingLine !== redirect.target?.value
				) {
					unknown("Shell heredoc boundary could not be verified");
				}
				continuations.set(headerEnd, closeEnd + 1);
			}
		}
	} catch {
		unknown("Shell syntax could not be fully inspected");
	}
	return result;
}
