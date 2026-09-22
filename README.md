# Step Code

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

![test\.jpg](images-and-attachments/test.jpg)

<h3><strong>Swift execution, long-horizon reliability, and high token efficiency.</strong></h3>

---

Step Code runs in your terminal and handles the full task loop—reading code, making changes, and running tests\. It works with the Step provider and discovers the available Step models after sign\-in\. MCP servers, Agent Skills, plugins, and multi\-agent orchestration work out of the box; you can delegate long\-running tasks to `/goal` and let Step Code drive them forward autonomously\.

![test\.jpg](images-and-attachments/test%201.jpg)

## Why Step Code

- **Token efficiency** — tuned alongside Step models to consume fewer tokens for the same task; Long\-horizon tasks are split across parallel subagents, each with its own isolated context, so redundant content never enters the main conversation\.

- **Static site publishing** — the built\-in steppage plugin publishes a local directory to a shareable static URL in one command, with version management and rollback\.

- **Long\-running task delegation** — `/goal` hands an objective to Step Code, which works toward it autonomously, and `/cron` runs on a schedule; the status line shows a live timer for the active task\.

- **Step provider access** — sign in with a Step Plan account or use a Step Platform API key; switch among the models returned by Step in `/model`\.

- **Ecosystem compatibility** — MCP servers and Agent Skills work out of the box, and most Claude Code plugins are directly compatible\.

## Installation

Pick the official installer for your platform\. It downloads the latest release, verifies the checksum, installs step to `~/.stepcode/bin`, and updates your PATH; reopen your terminal and you are done\.

**macOS / Linux / WSL**

```bash
curl -fsSL https://static-openapi.stepfun.com/stepcode/install.sh | bash
```

**Windows \(PowerShell\)**

```powershell
irm https://static-openapi.stepfun.com/stepcode/install.ps1 | iex
```

- Windows PowerShell support is currently in beta; on Windows, we recommend installing in WSL

- Installer flags: `--version <vX.Y.Z|latest>` installs a specific version; `--install-dir <path>` overrides the install directory

- Verify the installation in a fresh terminal:

```bash
step --version
step --help
```

Upgrade later with `step update`\.

## Sign in to the Step provider

The default Step Code entrypoint exposes one built-in model provider: **Step (StepFun)**. The profiles below select the Step service region and billing method; they are not separate providers.

|Profile|Credential|Billing|
|---|---|---|
|Step Plan (CN, [platform.stepfun.com](https://platform.stepfun.com/step-plan))|Browser OAuth; credentials refresh automatically|Usage included with Mini / Plus / Pro / Max plans|
|Step Plan Oversea ([platform.stepfun.ai](https://platform.stepfun.ai/step-plan))|Browser OAuth; credentials refresh automatically|Usage included with Mini / Plus / Pro / Max plans|
|Step Platform (CN)|API key from [platform.stepfun.com/interface-key](https://platform.stepfun.com/interface-key)|Pay per request|
|Step Platform Oversea|API key from [platform.stepfun.ai/interface-key](https://platform.stepfun.ai/interface-key)|Pay per request|

Inside the TUI, `/login` opens the Step sign-in flow; from a shell, run `step login`. For API-key access, set `STEP_API_KEY=<your_step_api_key>` or enter the key in `/login`; headless runs can also pass `--api-key <your_step_api_key>`.

`/status` shows the current session and model status. Use `step login status` (or `step login status --json`) to check the Step credential and its validity. Stored credentials live in `~/.stepcode/auth.json` with mode `0600`; `/logout` clears the Step credential. After sign-in, `/model` lists the models discovered from the active Step endpoint.

## Getting started

Change into your project directory:

```bash
cd /path/to/your/project
step
```

Describe the task in the TUI, or submit one at launch:

```bash
step -p "What is the tech stack of this project? What is each directory responsible for? How do I run it locally?"
```

Run `/init` to generate an `AGENTS.md` project guide; an existing `CLAUDE.md` is used as\-is\.

|Entry|Command|Use case|
|---|---|---|
|Interactive TUI|`step`|Exploring code, ongoing conversations, reviewing changes|
|Headless|`step -p "..."`|Scripts, CI, batch jobs|

### Examples

Start the TUI in any project and enter:

```text
What is the tech stack of this project? What is each directory responsible for? How do I run it locally? Don't modify any files yet.
```

Then one that makes changes:

```text
Create a reference table for the error codes in src/api/errors.ts (code, meaning, trigger scenario) and save it to docs/errors.md
```

### Resume a session

```bash
step -c   # Continue the most recent session
step -r   # Browse session history and pick one to resume
```

Inside the TUI, `/resume` finds past sessions and `/hotkeys` lists all shortcuts\.

### Common shortcuts

|Key|Action|
|---|---|
|`Enter`|Send message|
|`Shift+Enter` / `Ctrl+J` / `Alt+Enter`|Newline|
|`Enter`|Queue a message while streaming \(delivered after the current tool call finishes\)|
|`@`|Reference a project file|
|`!command`|Run a shell command and hand the output to the model|
|`Shift+Tab`|Cycle permission mode|
|`Ctrl+O`|Toggle tool output|
|`Esc`|Interrupt the running task|

## Migrate from other agents

- **MCP config**: Claude Code / Codex MCP configuration is imported automatically on first launch; source files are never modified, the import is idempotent, and secrets are never inlined\.

- **Plugins**: most Claude Code plugins work as\-is, managed via `/plugin`\.

- **Project guides**: an existing `CLAUDE.md` is used as\-is; `/init` generates the equivalent `AGENTS.md`\.

## Build from source

Developing Step Code or running from this repository requires Git, Node\.js, and pnpm:

```bash
git clone https://github.com/stepfun-ai/Step-Code.git
cd Step-Code
pnpm install --ignore-scripts
pnpm run build
pnpm step
```

When running from the source tree, replace `step` with `pnpm step`\.

## Security

- Four permission modes \(Ask / Read Only / Bypass / Autopilot\), cycled with `Shift+Tab`; dangerous commands require a separate confirmation dialog in every mode\.

## Uninstall

Make sure no step sessions are running before you uninstall\.

**Remove the binary**: delete the step executable from the install directory \(default `~/.stepcode/bin`\)\. The installer appends a PATH block marked `# stepcode` to your shell config; removing that block completes the uninstall \(zsh: `~/.zshrc`, bash: `~/.bashrc`, fish: the `fish_add_path` config\)\.

**Remove user data \(optional\)**: everything lives under `~/.stepcode` \(config, credentials, sessions, logs\); delete the directory to remove all Step Code data:

```bash
rm -rf ~/.stepcode
```

## Docs \& community

- Quick start · Interaction \& input · Platforms \& models · All docs \(links finalized at release\)

- Contributing · \[Report a bug / request a feature\]\(issues link added at release\) · Report a security issue

- When filing an issue, include `step --version`, reproduction steps, and how you run Step Code; strip credentials and private project content first\.

## License

Released under the MIT license; see LICENSE\.
