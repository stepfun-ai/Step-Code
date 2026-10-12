# Windows Setup

Step uses Git Bash by default on Windows. Checked locations (in order):

1. Explicit `shellPath` (including an explicitly selected WSL launcher)
2. Git Bash in Program Files, Program Files (x86), or `%LOCALAPPDATA%\Programs\Git`
3. Git Bash located relative to each `git.exe` on PATH, including custom and portable installations
4. Native `bash.exe` on PATH (for example Cygwin or MSYS2)

PATH discovery does not invoke `where.exe`. It checks all absolute PATH entries,
resolves executable symlinks, and continues past Git shims with no adjacent Bash.
A wrapper that hides a Git installation entirely requires an explicit `shellPath`.

The Windows WSL `bash.exe` launcher is **not selected automatically**. It runs
Linux commands with a different filesystem and toolchain. If only WSL is found,
Step reports how to install/configure native Bash or run Step inside WSL.
An explicit `shellPath` to the WSL launcher remains supported.

For Git Bash, Step adds that installation's `bin` and `usr/bin` to the child
process PATH so standard tools work alongside Windows Node/npm. It does not
change the system PATH or source user login scripts. Bash commands are not
silently run through PowerShell; use the separate PowerShell tool for that dialect.

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## PowerShell Tool

The optional `powershell` tool runs commands through `pwsh.exe` when available, otherwise Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

Use `defaultTools` to replace the model-facing `bash` tool:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Or enable both while comparing behavior:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

The `!` and `!!` editor commands still use Bash.

## Custom Bash Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
