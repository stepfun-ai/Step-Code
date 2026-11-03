import { describe, expect, it } from "vitest";
import { inspectShellScript } from "../src/step/shell-analysis.ts";

// MR !95: syntax role, rather than text resemblance, determines executable contexts.
describe("shell syntax inspection", () => {
	it.each([
		"if true; then rm -rf ./build; fi",
		"case x in x) rm -rf ./build;; esac",
		"for x in one; do rm -rf ./build; done",
		"while false; do rm -rf ./build; done",
		"function f { rm -rf ./build; }; f",
		"f() { rm -rf ./build; }; f",
		"(rm -rf ./build)",
		'"rm" "-rf" ./build',
		'$"rm" -rf ./build',
		"$'r\\x6d' -rf ./build",
		"r\\\nm -rf ./build",
	])("finds executable commands in %s", (source) => {
		const result = inspectShellScript(source);
		expect(result.unresolved).toBeUndefined();
		expect(result.commands.map((command) => command.words)).toContainEqual(["rm", "-rf", "./build"]);
	});

	it.each([
		"a=(rm -rf ./build)",
		"declare -a a=(rm -rf ./build)",
		"a=(); a+=(rm -rf ./build)",
		'printf "%s" "$((rm -rf))"',
		"(( rm -rf )); :",
		"[[ x == x && reboot == reboot ]]",
		"case x in\nreboot) :;;\nx) :;;\nesac",
		`printf "%s" \${unset:-safe; rm -rf ./build}`,
		`printf "%s" "\${unset:-safe; rm -rf ./build}"`,
		'"if" rm -rf ./build',
		'"FOO=x" rm -rf ./build',
		"for word in reboot shutdown; do :; done",
		"cat <<'EOF'\n$(rm -rf ./build)\nEOF",
		'cat <<< "rm -rf ./build"',
		"printf safe >reboot",
	])("keeps data out of executable commands in %s", (source) => {
		const result = inspectShellScript(source);
		expect(result.unresolved).toBeUndefined();
		expect(
			result.commands.some(
				({ words }) => typeof words[0] === "string" && ["rm", "reboot", "shutdown"].includes(words[0]),
			),
		).toBe(false);
	});

	it.each([
		'a=("$(rm -rf ./build)")',
		'declare -a a=("$(rm -rf ./build)")',
		'typeset -a a=("$(rm -rf ./build)")',
		'local -a a=("$(rm -rf ./build)")',
		'command declare -a a=("$(rm -rf ./build)")',
		"a[$(rm -rf ./build)]=value",
		`: "\${a[$(rm -rf ./build)]}"`,
		`: "\${unset:-$(rm -rf ./build)}"`,
		`: "\${value/x/$(rm -rf ./build)}"`,
		': "$(( $(rm -rf ./build) + 1 ))"',
		"(( value[$(rm -rf ./build)] ))",
		'[[ "$(rm -rf ./build)" == safe ]]',
		'cat >"$(rm -rf ./build)"',
		"cat <(rm -rf ./build)",
		'printf "%s" "$\\\n(rm -rf ./build)"',
		'printf "%s" "$(case x in x) rm -rf ./build;; esac)"',
		'printf "%s" "$(cat <<EOF\n)\nEOF\nrm -rf ./build\n)"',
		"echo `echo \\`rm -rf ./build\\``",
		"cat <<EOF\n$(rm -rf ./build)\nEOF",
		"sh <<EOF\n# $(rm -rf ./build)\nEOF",
		"sh <<EOF\n'$(rm -rf ./build)'\nEOF",
	])("finds substitutions inside %s", (source) => {
		const result = inspectShellScript(source);
		expect(result.unresolved).toBeUndefined();
		expect(result.commands.map((command) => command.words)).toContainEqual(["rm", "-rf", "./build"]);
	});

	it("retains direct input and pipeline producers without interpreting their commands", () => {
		const result = inspectShellScript("cat <<'EOF' | cat | sh\nrm -rf ./build\nEOF");
		expect(result.unresolved).toBeUndefined();
		expect(result.commands.map((command) => command.words)).toEqual([["cat"], ["cat"], ["sh"]]);
		const shell = result.commands[2]!;
		expect(shell.pipelineInput).toBe(result.commands[1]);
		expect(shell.pipelineInput?.pipelineInput).toBe(result.commands[0]);
		expect(shell.pipelineInput?.pipelineInput?.input).toEqual({ text: "rm -rf ./build\n" });
	});

	it("lets later stdin redirection override earlier literal input", () => {
		expect(inspectShellScript('sh <<< "rm -rf ./build" < script').commands[0]?.input).toEqual({});
		expect(inspectShellScript('sh < script <<< "printf safe"').commands[0]?.input).toEqual({ text: "printf safe\n" });
	});

	it("keeps here-string wildcards as literal input", () => {
		expect(inspectShellScript("cat <<< *").commands[0]?.input).toEqual({ text: "*\n" });
	});

	it("retains stdin attached to a compound command", () => {
		const result = inspectShellScript("{ sh; } <<'EOF'\nrm -rf ./build\nEOF");
		expect(result.unresolved).toBeUndefined();
		expect(result.commands).toEqual([{ words: ["sh"], input: { text: "rm -rf ./build\n" } }]);
	});

	it("validates multiple heredoc bodies against their own AST boundaries", () => {
		const result = inspectShellScript("cat <<FIRST <<SECOND\nfirst\nFIRST\nsecond\nSECOND\n:");
		expect(result.unresolved).toBeUndefined();
		expect(result.commands[0]?.input).toEqual({ text: "second\n" });
	});

	it("strips leading tabs from literal <<- input", () => {
		const result = inspectShellScript("sh <<-EOF\n\trm -rf ./build\n\tEOF");
		expect(result.unresolved).toBeUndefined();
		expect(result.commands[0]?.input).toEqual({ text: "rm -rf ./build\n" });
	});

	it.each([
		"cat <<EOF\nhello",
		"cat <<EOF\nhello\nEO\\\nF\nrm -rf ./build",
		"cat <<EOF\n$\\\n(rm -rf ./build)\nEOF",
		"cat <<$'E\\x4fF'\nhello\nEOF",
		"cat <<$'EOF\\000ignored'\nhello\nEOF",
		"cat <<$'\\u0045OF'\nhello\nEOF",
		"if true; then :",
		'printf "%s" "$(if true; then :)"',
		"$\\\n'r\\x6d' -rf ./build",
		"cat <\\\n(rm -rf ./build)",
		`printf "%s" "$(printf %s \${unset:-)}; rm -rf ./build)"`,
		`: "\${value/$(printf /; rm -rf ./build)/safe}"`,
	])("preserves explicit uncertainty for unsupported or incomplete syntax: %s", (source) => {
		expect(inspectShellScript(source).unresolved).toBeDefined();
	});

	it("preserves commands that were found before a parse failure", () => {
		const result = inspectShellScript("rm -rf ./build; if true; then :");
		expect(result.unresolved).toBeDefined();
		expect(result.commands.map((command) => command.words)).toContainEqual(["rm", "-rf", "./build"]);
	});

	it.each(["$'rm\\000ignored'", "$'\\u0072m'", "$'\\xc3\\xa9'", "$'\\c?'"])(
		"keeps ambiguous ANSI words nonliteral: %s",
		(word) => {
			expect(inspectShellScript(`${word} -rf ./build`).commands[0]?.words[0]).toBeUndefined();
		},
	);

	it("keeps dynamic words unknown while visiting their explicit substitutions", () => {
		const result = inspectShellScript(`"$command" "\${flags:-$(reboot)}"`);
		expect(result.commands.map((command) => command.words)).toEqual([["reboot"], [undefined, undefined]]);
		expect(result.unresolved).toBeUndefined();
	});

	it("distinguishes filename expansion from quoted wildcard data", () => {
		const result = inspectShellScript("r* -rf ./build; printf \"r*\" 'r?' [ab]");
		expect(result.unresolved).toBeUndefined();
		expect(result.commands.map((command) => command.words)).toEqual([
			[undefined, "-rf", "./build"],
			["printf", "r*", "r?", undefined],
		]);
	});

	it.each([
		["[", "["],
		["\\[", "["],
		["./safe[", "./safe["],
		["./r[]", "./r[]"],
		["./r[!]", "./r[!]"],
		["./r[^]", "./r[^]"],
		["./r\\*", "./r*"],
		["./r\\?", "./r?"],
		["./r\\[m]", "./r[m]"],
		["./r[m\\]", "./r[m]"],
		['./r[m"]"', "./r[m]"],
		["./r'['m]", "./r[m]"],
	])("retains literal command words without filename expansion: %s", (source, value) => {
		expect(inspectShellScript(`${source} -rf ./build`).commands[0]?.words[0]).toBe(value);
	});

	it.each(['r["m"]', "r[\\m]", "r[m\\\n]", "r[]]", "r[!m]", "r[[:alpha:]]", 'r["m"n]', "r\\**", '["!"]', '["^"]'])(
		"retains filename uncertainty across quoted and escaped parts: %s",
		(source) => {
			expect(inspectShellScript(`${source} -rf ./build`).commands[0]?.words[0]).toBeUndefined();
		},
	);

	it.each(["'2'", "'{fd}'"])("does not trust quoted %s as a descriptor", (descriptor) => {
		const result = inspectShellScript(`${descriptor}>/tmp/output rm -rf ./build`);
		expect(result.unresolved).toBeDefined();
		expect(result.commands).toEqual([]);
	});

	it.each(["2", "02", "{fd}"])("retains a command following raw %s descriptor syntax", (descriptor) => {
		const result = inspectShellScript(`${descriptor}>/tmp/output rm -rf ./build`);
		expect(result.unresolved).toBeUndefined();
		expect(result.commands.map((command) => command.words)).toEqual([["rm", "-rf", "./build"]]);
	});

	it("bounds input size and syntax nesting without throwing", () => {
		expect(inspectShellScript(" ".repeat(128_001)).unresolved).toBeDefined();
		expect(inspectShellScript(`${"(".repeat(200)}:${")".repeat(200)}`).unresolved).toBeDefined();
	});
});
