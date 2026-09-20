# Command permissions

Explicit per-tool denial takes precedence over command approval. Otherwise,
a built-in rule match requires approval for that individual call in Ask, Bypass,
and Autopilot, including the low-level `auto` mode. Read-only (`strict`) mode
denies the call. A run without an approval channel denies it even if
`nonInteractiveApproval` or the tool override is `allow`.

The policy belongs to `packages/coding-agent/src/step/permissions.ts` and runs
through the existing `tool_call` hook for agent tools. The same check applies to foreground and
background command requests. Each approval applies once; rejecting or cancelling
the prompt does not execute the call. Clients render the existing confirmation
request and do not implement a separate command policy.
Manual `!` input and the RPC `bash` command use the separate `user_bash` event;
they are user-issued shell commands and are outside this agent-tool policy.

## Recursive forced removal

The `recursive-force-remove` rule matches an `rm` invocation that has both a
recursive option (`-r`, `-R`, `--recursive`) and a force option (`-f`, `--force`).
The target does not affect the decision. Short options can be combined or split;
`--` ends option parsing.

| Command | Rule match |
| --- | --- |
| `rm -rf ./build` | Yes |
| `rm -fr /tmp/cache` | Yes |
| `rm -R -f "$TARGET"` | Yes |
| `rm --recursive --force -- ./build` | Yes |
| `sudo -u root /bin/rm -rf ./build` | Yes |
| `cd project && rm -rf ./build` | Yes |
| `sh -c 'rm -rf ./build'` | Yes |
| `echo 'rm -rf ./build'` | No |
| `rm -r ./build` | No |
| `rm -- -rf` | No |

A non-match still goes through ordinary permission policy. The detector inspects
literal command names and arguments, common command wrappers, shell command
strings, redirections, compound commands, command/process substitutions, and
literal `find -exec` / `xargs` invocations. Quoting and comment context are retained
while inspecting substitutions. Heredoc input is treated as text, with command
substitutions inspected only for an unquoted delimiter. When a shell interpreter
appears on that input line, the body is conservatively inspected as a script too.
It is a static approval
guard, not a shell sandbox: it does not resolve aliases, expand variables into
commands or options, inspect script files, or evaluate arbitrary programs.

## Adding rules

`packages/coding-agent/src/step/command-policy.ts` contains the typed
`COMMAND_APPROVAL_RULES` registry. Each rule has a stable ID and one of two kinds:

- `shell`: a predicate over a normalized command name and its argument tokens.
  Use this for commands whose option combinations matter. Shell traversal and
  wrapper handling are shared across rules.
- `pattern`: a regular expression over the submitted command text. The existing
  filesystem, device, Git, and SQL patterns retain this conservative behavior.
  Use non-stateful expressions without the `g` or `y` flags.

To add a command, add a named rule and test both executable forms and similar
text that should not match in `test/step-command-policy.test.ts`. Keep permission
precedence in the controller; a new rule does not need branches for each preset.
The matched ID appears in the confirmation reason. Built-in rules have no user
configuration switch that can disable mandatory approval.
