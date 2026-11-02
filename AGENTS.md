# Agent instructions

## Commit attribution

- Keep the Git author and committer as the human contributor's verified GitHub identity.
- AI tools may assist with implementation, but they must not be added as commit co-authors.
- Do not add `Co-authored-by` or `Co-Authored-By` trailers for Claude, Claude Code, Codex, ChatGPT, OpenAI, Anthropic, or another AI client.
- Do not mention the client used to create a change in the commit message solely for attribution.
- Before creating or amending a commit, inspect its metadata and remove any AI-client attribution trailer.

This policy applies to commit metadata. Documentation may mention AI products when that is relevant to the product or feature being documented.

## 1. Scope and reading order

This file defines repository-wide rules for Step-Code. Before changing a directory, also read the `AGENTS.md` files in that directory and its ancestors. Local rules add module constraints; they cannot override this file's commit attribution policy, dependency direction, or public-source boundary.

- `CLAUDE.md` continues to reference this file; do not maintain a second set of repository rules.
- Organize architecture guidance around layers, responsibilities, and ownership. Verify paths, dependencies, commands, and defaults against current source, `package.json`, check scripts, and the relevant documentation.
- Check implementation status before borrowing designs from other repositories. Do not copy obsolete paths, unimplemented plans, or private branch and release procedures.

## 2. Project structure and dependency layers

The current source layout is:

```text
apps/
  cli/                         Process entry points and interactive host
    src/args/                  Arguments and mode selection
    src/bootstrap/             Startup composition
    src/commands/              Top-level commands
    src/modes/                 Mode routing
    src/bun/                   Standalone binary entry
    src/ui/                    UI host, runtime, and views
packages/
  agent-core/                  Generic Agent runtime
    src/harness/               Sessions, context, compaction, and generic tools
    src/search/                Generic search
  coding-agent/                Coding product and SDK
    src/core/                  Product session mechanisms, tools, and extensions
    src/features/              Plan, task, subagent, workflow, goal, and cron
    src/step/                  Step configuration, permissions, MCP, and integrations
    src/modes/                 Non-interactive execution
    src/server/                Host service adapters
    src/theme/                 Product themes
    src/render/                Rendering helpers
    src/components/            Reusable product components
    docs/                      Package APIs and usage
    examples/                  SDK and extension examples
    test/                      Product and session regressions
  config/                      Product-neutral startup migrations
  contracts/                   Independent host interfaces and wire frames
  lark-adapter/                External Feishu/Lark protocol and SDK boundary
  providers/                   Model access, adapters, catalogs, and credentials
  telemetry/                   Telemetry contracts and reference implementations
  tui/                         Terminal input, layout, and rendering
docs/                          Repository-wide guides and runtime contracts
scripts/                       Checks, generators, builds, and development tools
infra/release/                 Local packaging and installer templates
plugins/                       Built-in marketplace and plugin declarations
.github/                       Public CI workflows and contribution templates
.husky/                        Git hook definitions
```

Package manifests and `scripts/workspace-registry.json` define workspace membership; build outputs and installed dependencies are not source modules. Read the [development and collaboration guide](docs/development.md) for implementation practices and [testing policy](docs/testing.md) to select validation.

Dependencies flow from product entry points toward foundational capabilities. Foundational packages must not depend on products or applications. The table defines allowed internal dependencies, not a requirement to depend on every listed package.

| Layer | Module and local rules | Responsibility | Allowed internal dependencies |
| --- | --- | --- | --- |
| Foundation | [telemetry](packages/telemetry/AGENTS.md) | Telemetry contracts, typed schemas, no-op and in-memory reference implementations | None |
| Foundation | [tui](packages/tui/AGENTS.md) | Terminal input, layout, differential rendering, and generic components | None |
| Foundation | [contracts](packages/contracts/AGENTS.md) | In-process host/Agent interfaces, wire events, and framing | None; runtime dependencies must remain empty |
| Foundation | [config](packages/config/AGENTS.md) | Product-neutral configuration migrations | None |
| Adapter | [lark-adapter](packages/lark-adapter/AGENTS.md) | External Feishu/Lark protocol and SDK connection; used only by apps/cli | None |
| Model runtime | [providers](packages/providers/AGENTS.md) | Providers, API dialects, model catalogs, credentials, and vendor adapters | telemetry |
| Agent runtime | [agent-core](packages/agent-core/AGENTS.md) | The single Agent Loop, generic harness, session and context semantics | providers, telemetry |
| Coding product | [coding-agent](packages/coding-agent/AGENTS.md) | Coding sessions, tool policies, extensions, orchestration, Step integrations, and themes | agent-core, providers, config, tui |
| Application host | [apps/cli](apps/cli/AGENTS.md) | argv, startup composition, mode routing, process lifecycle, and interactive UI | coding-agent, agent-core, providers, config, tui, lark-adapter |

- Register new workspaces in `pnpm-workspace.yaml`, root `package.json`, and `scripts/workspace-registry.json`. Use the `@step-harness/*` scope for new internal packages.
- Use public package entry points for cross-package calls. Do not depend on another package's `dist/` layout or bypass boundaries with deep source imports.
- `packages/**` must not import `apps/**`. `packages/tui` must not depend on Agent, provider, session, or product code.
- Put new model-vendor SDKs behind adapters in `packages/providers`; other external protocol SDKs go in their own isolated adapter package, such as `packages/lark-adapter`. Coding-product integrations such as MCP and plugins belong in `packages/coding-agent`, not the generic Agent Loop or rendering library.

## 3. Ownership of core concepts

| Concept | Semantic owner | Product and host usage |
| --- | --- | --- |
| Agent Loop | `packages/agent-core/src/agent-loop.ts` | coding-agent composes it; TUI, print, JSON, RPC, and SDK reuse it. Do not create another loop. |
| Session / transcript | Generic session contracts in agent-core; coding-agent's `AgentSession` / `SessionManager` own coding-session execution and persistence | UI holds input, connection, selection, and presentation state; it must not become the authority for persistent sessions. |
| Context / compaction | Generic harness in agent-core; message conversion, skill retention, and recovery adapters in coding-agent | Presentation code must not assemble a second model context. Request projection must not rewrite the original transcript. |
| Provider / model | Registration, catalogs, dialects, and adapters in providers | Products select and configure models. Dispatch by API dialect, never by provider name or display metadata. |
| Tool / permission | Generic tool primitives in agent-core; coding tools, registration, permissions, and output retention in coding-agent | Clients present approval requests rather than duplicate permission decisions. Providers do not orchestrate tools. |
| Subagent / workflow / goal / cron / plan / task | `packages/coding-agent/src/features/` | Compose through extensions and the same session lifecycle. Do not infer state from UI text or model replies. |
| Configuration and resources | Neutral migrations in config; settings, trust, and resource resolution in coding-agent's core / step | CLI injects paths, defaults, and UI hooks. Step settings use `config.toml`; credentials, models, and sessions retain their own storage contracts. |
| Theme / TUI | Product themes in coding-agent's `src/theme/`; rendering primitives in tui; interactive composition in `apps/cli/src/ui/` | Components consume the active theme. Do not add another theme registry or rendering loop. |
| Host protocols | Independent in-process and wire contracts in contracts; concrete RPC / stdio protocols in existing mode entry points | Do not assume every mode already uses contracts. Adapt and validate new connections at host boundaries; keep concrete host objects out of contracts. |

## 4. Choosing directories and implementing changes

- Generic context, session, and tool primitives: `packages/agent-core/src/harness/`. Coding-product adapters: `packages/coding-agent/src/core/`.
- Built-in product features and orchestration: `packages/coding-agent/src/features/`. Extension loading, registration, and hooks: `packages/coding-agent/src/core/extensions/`.
- Step login, unified configuration, MCP, plugins, permissions, and feedback: `packages/coding-agent/src/step/`. Plugin manifests: `plugins/`.
- CLI commands and startup: `apps/cli/src/commands/`, `args/`, `bootstrap/`, and `modes/`. Product UI: `apps/cli/src/ui/`.
- Shell / bootstrap / modes enter UI only through `#ui` or `#ui/index`, never deep `#ui/...` imports. UI must not import the shell.
- UI dependencies flow host → runtime → view. Runtime receives host capabilities through its own `RuntimeContext`; view must not import runtime. If used, `ui/state/` is a leaf and must not depend on host, runtime, or view.
- Use existing actions and keybinding tables. Do not hardcode key matching in product logic.
- Provide complete TypeScript types for public interfaces. Prefer `unknown` with validation over unnecessary `any`; verify external APIs against installed dependency types.
- Relative TypeScript imports use `.ts` extensions and follow `check:ts-imports`. Source checked by the root configuration uses erasable syntax; do not add `enum`, parameter properties, or syntax requiring JavaScript emit.
- Do not hand-edit `packages/providers/src/models.generated.ts` or provider data snapshots. Change generator scripts or inputs, then run the corresponding generation commands.
- Preserve existing features and explicit user requirements. Do not delete functionality, weaken checks, or introduce unrelated refactors to make type or boundary checks pass.
- Keep functions at one abstraction level; introduce helpers only when they own a meaningful operation, policy, or reusable behavior.
- Validate external JSON, configuration, persisted data, and protocol inputs at their entry points. Narrow `unknown`; justify unavoidable `any` and type assertions rather than weaken checks or duplicate validation at every typed internal call.
- Comments and JSDoc explain non-obvious behavior, failure, cancellation, and resource ownership; do not restate code or record an implementation conversation.
- Handle failures at an explicit owner. Do not silently ignore invalid configuration, uncertain outcomes, or partially completed mutations. Best-effort catches must explain why ignoring the error is safe.
- Cancellation and teardown must settle owned work, release resources, and prevent late callbacks from publishing into replaced sessions; requesting an abort alone does not prove cleanup completed.

## 5. Development and validation

- Use Node.js `>=22.19.0` and the pnpm version in the root manifest. Install with `pnpm install --ignore-scripts`; reproduce the locked environment with `pnpm install --frozen-lockfile --ignore-scripts`.
- Pin direct external dependencies to exact versions. Update the lockfile with dependency changes; do not update dependencies for documentation tasks or bypass lockfile commit checks.
- Run source through root `pnpm step` or `./step-test.sh`. `./step-test.sh --no-env` removes listed provider environment credentials, but local user resources still require care.
- After code changes, run root `pnpm run check`, inspect the full output, and fix errors. It includes Biome autofixes, type checks, and boundary checks; it does not run tests.
- Select tests for changed behavior using the [testing policy](docs/testing.md). Run Vitest from the owning package with `pnpm exec vitest --run <test-path>`; tui uses `node --test test/<name>.test.ts`.
- Use `./test.sh` for repository tests and follow the pre-submission requirements in [CONTRIBUTING.md](CONTRIBUTING.md). It isolates user resources and credentials and builds offline if outputs are missing. Do not run a full Vitest suite that may activate real providers directly.
- Unit and regression tests use faux providers, fixtures, mocks, and temporary directories. They must not read real accounts or consume paid model requests.
- For documentation-only changes, verify relative links, directories, and commands and run `git diff --check`; follow the repository-wide pre-submission checks in `CONTRIBUTING.md`. Build only when a selected check needs artifacts; do not introduce real model calls for documentation validation.
- When changing Agent Loop, sessions, tool permissions, providers, themes, or cross-process contracts, update the relevant `docs/`, package documentation, and affected `AGENTS.md` files.

## 6. Task execution and Git collaboration

- Before editing, read affected files, local rules, and relevant documentation. For complex or high-risk work, explain steps, tools, acceptance criteria, and rollback. Continue reversible work already authorized by the user.
- For concurrent work, name module and file owners, agree shared interfaces first, and assign one integration owner. Coordinate edits to public types, exports, manifests, and the lockfile; hand off changed behavior, validation results, and remaining issues using the [collaboration workflow](docs/development.md#collaboration-workflow).
- Prefer existing tools in `scripts/`. Keep temporary validation scripts in temporary directories, outside product source.
- Do not commit or push unless requested. Stage only explicit paths belonging to the task; do not use `git add .` or `git add -A`.
- If the working directory contains another task's changes, use a separate worktree or touch only your files. Do not stash, clean, or revert other contributors' changes.
- Do not use `git reset --hard`, `git checkout .`, `git clean -fd`, skip hooks, or raw `--force`. Rewrite a published task branch only when explicitly requested; record its live remote OID, use an exact `--force-with-lease`, and abort on remote movement. If a Git operation conflicts with unrelated files, stop that operation and explain the conflict.
- Write commit subjects and bodies, PR/MR titles and descriptions, public issues, and review comments in English. Commit and PR/MR titles follow Conventional Commits; split commits by coherent responsibility, not to inflate the history.
- PR descriptions, issues, and comments follow the same [commit attribution](#commit-attribution) policy: no AI-client attribution or generated-by footers.
- Report the changes, validation evidence, and anything still unverified. Keep delivery notes concise and specific.

## 7. Public source and support directories

- Public source includes code, public tests, local builds, and CI checks. Private telemetry exporters, internal endpoints, release credentials, protected-tag operations, and upload/publication workflows stay in a separate release environment.
- Do not copy internal execution records, private CI configuration, or infrastructure addresses into this repository. Follow the [public-source boundary](docs/open-source-status.md) and `check:public-boundary`.
- Documentation: follow [docs/AGENTS.md](docs/AGENTS.md).
- Check and build scripts: follow [scripts/AGENTS.md](scripts/AGENTS.md).
- Local release packaging and installer templates: follow [infra/release/AGENTS.md](infra/release/AGENTS.md).
- Built-in plugin manifests: follow [plugins/AGENTS.md](plugins/AGENTS.md).
