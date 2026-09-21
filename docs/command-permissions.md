# Command permissions

Explicit per-tool denial takes precedence. Otherwise, shared command analysis
returns one of three outcomes:

| Analysis | Ask / Bypass / Autopilot | Read-only | Without an approval channel |
| --- | --- | --- | --- |
| A built-in dangerous rule matched | Confirm each call | Deny | Deny |
| Syntax or executable input could not be fully analyzed | Confirm each call, explaining the uncertainty | Deny | Deny |
| Analysis completed without a rule match | Ordinary preset/tool policy | Ordinary read-only policy | Ordinary unattended policy |

Unresolved analysis is not reported as a detected dangerous command.
`StepToolDecision.analysisIncomplete` distinguishes it from `hazardous`.
Neither outcome can use an automatic tool override or unattended `allow`.
Explicit user approval applies only to that call.

The product policy in `packages/coding-agent/src/step/permissions.ts` runs through
the existing `tool_call` hook, before foreground/background execution. Clients
render the existing confirmation request; they do not implement another policy.
The Step extension supplies the command tool's shell path and command prefix
from the same settings manager. Analysis uses the shared shell resolver; a custom
non-Bash shell cannot inherit a Bash-only ordinary verdict. Foreground prefixes
are analyzed with the submitted command; background execution currently omits
that prefix, matching the existing tool implementation. Embedders with custom
command execution must supply the corresponding `shellContext` to the controller.
Manual `!` input and RPC `bash` use the separate `user_bash` event and are outside
this agent-tool policy.

## Syntax, command semantics, and rules

`shell-analysis.ts` uses the pinned `unbash` parser and explicitly traverses its
typed AST. Simple commands and executable substitutions are retained; array
elements, arithmetic identifiers, conditional operands, case patterns, parameter
values, and quoted words remain data. Function/compound bodies are conservatively
inspected without evaluating control flow. Nested scripts and lazy word parts
are visited explicitly, including their parse errors and source ownership.

The adapter retains input redirections and pipeline relationships.
`command-policy.ts` separately interprets common wrapper options, Bourne-shell
`-c` arguments, literal interpreter stdin, `find -exec`, `xargs`, and literal
`eval` / `trap` scripts and `let` arithmetic. `builtin` wrappers use the same
dispatch. It never reparses ordinary arguments as command lists.
For example:

| Command | Interpretation |
| --- | --- |
| `bash -ec -- 'rm -rf ./build'` | Inspect the actual command string after shell options |
| `bash script.sh -c 'rm -rf ./build'` | Script filename and positional arguments; file contents are not read |
| `args=(rm -rf ./build); printf '%s\n' "${args[@]}"` | Array data and printing |
| `declare -a args=("$(rm -rf ./build)")` | The substitution is executable |
| `printf '%s\n' "$((rm -rf))"` | Arithmetic data, not an rm invocation |
| `sh <<< 'rm -rf ./build'` | Literal stdin consumed as a shell script |
| `cat <<< 'rm -rf ./build'` | Literal stdin consumed as data |

Quoted heredoc bodies remain data unless they feed a known shell consumer.
Unquoted bodies are inspected for substitutions. Backticks and nested compound
syntax are located by the parser, not by a second bracket/comment scanner.
Wrapper options have explicit operand arity; an unsupported option does not
cause the following words to be guessed as a command.
The supported wrappers include `timeout`, `nice`, `setsid`, and `stdbuf`.
`timeout` consumes its duration before locating the executable; `nice` accepts
`-n`/`--adjustment`, while legacy numeric options require review.
Input-appended or replaced `xargs` operands remain unknown values in argv. They
cannot be treated as literal placeholders or omitted when deciding executable
names, option combinations, or shell command strings. Ordinary data-only
consumers such as `xargs echo` still follow ordinary policy.

## Incomplete analysis

A parser is not an execution oracle. Parse errors, missing nested syntax,
unverified heredoc boundaries, unsupported parser representations, and inspection
budget exhaustion produce an explicit unresolved result. There is no fallback
to the previous handwritten lexer and no parse-error-to-allow path.

The pinned parser has known limitations. The adapter conservatively rejects
confidence in escaped ANSI-C heredoc delimiters, continued heredoc lines, certain
continued expansion openers, truncated substitution nodes, and quoted file
descriptors whose syntax provenance was lost. Ambiguous ANSI word values and
unquoted filename expansions remain nonliteral. If such a value determines the
executable, wrapper layout, dangerous-command options, or interpreter script,
approval is required. Ordinary dynamic data arguments, such as `echo "$VALUE"`,
do not require approval solely for being dynamic.
Filename expansion is checked across the complete word, retaining quote and
escape information. A literal `[` command is not a bracket glob.

An unreliable syntax tree produces unresolved analysis rather than a rule match
from its partial tree. When syntax is reliable, a definite dangerous invocation
can still be reported even if another command's runtime arguments are unknown.

Bash syntax is the supported grammar. Other shell dialects do not receive an
automatic safe verdict from a successful Bash parse. Known rule matches remain
conservative; otherwise PowerShell, fish, zsh, and ksh command strings require
review, as do `sh` and `dash`: their heredoc semantics can differ from Bash.
Integer, nameref, and inherited-attribute declarations require review because their attributes can
make later assignments execute arithmetic expressions. Variable-target builtins
(`unset`, `read`, `printf -v`, declarations, and related APIs) accept ordinary
names and literal numeric subscripts; other target expressions require review.
Scalar declarations retain their known assignment target even when the value is
dynamic. Quoted scalar values remain data; unquoted expansion and quoted `$@`
or array `[@]` require a direct, syntactically recognized declaration assignment
to rule out extra operands. Wrappers do not inherit that assignment context.
Array names established by shell syntax or variable-target builtins are retained
across inspected contexts. A declaration assigning an unknown value to a possible
array requires review, since Bash can parse that value again as a compound array
assignment. Known compound values are inspected as array syntax. This is
conservative across branches, loops, and function scopes; it does not infer the
variable's actual runtime type or erase an array possibility after `unset`.
Callbacks passed to `mapfile`/`readarray` also require review. Data arguments such
as a `read` prompt or plain `printf` output are not promoted to executable input.
Parser limits and unsupported constructs are documented boundaries,
not claims that those programs are necessarily dangerous.

This remains static approval inspection, not a sandbox or full shell evaluation.
It does not resolve aliases, track arbitrary runtime values, read script files,
or inspect programs invoked by a command. All branches and function bodies may
be inspected even when a particular execution would not reach them.

## Rules and extension points

The `recursive-force-remove` rule requires both a recursive flag
(`-r`, `-R`, `--recursive`) and a force flag (`-f`, `--force`) on an actual `rm`
invocation. Its target does not affect the result. Combined/split short options
and long options are supported; `--` ends option parsing. Executable names are
matched without case on Windows and conservatively on macOS, whose filesystems
can resolve case variants to the same program. Other POSIX hosts preserve command
name case. Arguments retain their original case on every platform.

`COMMAND_APPROVAL_RULES` contains typed, named rules:

- `shell` predicates consume analyzed command names and argument values.
- `pattern` rules retain the existing conservative raw-text matching for
  filesystem/device, Git, and SQL hazards.

A rule ID identifies a known match. The Boolean `isDangerousCommand()` helper is
a detection query, not an authorization API: callers making permission decisions
must handle `analyzeCommandPolicy()`'s unresolved result as well.
In particular, incomplete syntax can make this Boolean return `false` even when
a preceding fragment contains a dangerous command. It does not mean permission
was granted; the permission controller still requires approval or denies the call.

Changes must test executable forms, data-only controls, and incomplete analysis.
`step-command-policy-shell-semantics.test.ts` compares policy with harmless
real-shell execution in an isolated environment. `step-shell-analysis.test.ts`
covers grammar roles and parser boundaries; `step-command-policy-uncertainty.test.ts`
covers confirmation and unattended denial. Tests must not equate an unexecuted
branch with inert data or silently accept unresolved results as successful parsing.
