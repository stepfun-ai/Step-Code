# Testing policy

Select evidence for the behavior being changed, using existing suites and fixtures. [CONTRIBUTING.md](../CONTRIBUTING.md#before-submitting-a-pr) owns the repository-wide pre-submission requirements; local module rules list more focused entry points.

## Selecting checks

Run root `pnpm run check` for code changes. It includes formatting fixes, types, imports, dependency and layer checks, frozen entry points, public boundaries, and a browser bundle smoke; it does not run tests.

| Changed behavior | Focused evidence and starting points |
| --- | --- |
| Documentation and agent instructions | Verify links, source paths, command names, and stated behavior; run `git diff --check` and root `pnpm run check:public-boundary` after staging new files. |
| Guards and build scripts | Run root `pnpm run test:scripts`, the affected real guard, and its `--self-test` where supported. Cover both valid and rejected inputs. |
| Agent Loop, session, or compaction | Select agent-core tests and its `vitest.harness.config.ts` suite. Product session changes use the [coding-agent suite harness](../packages/coding-agent/test/suite/README.md), including cancellation, event order, queues, recovery, and replacement. |
| Permissions and command execution | From `packages/coding-agent`, start with `pnpm exec vitest --run test/step-permissions.test.ts test/step-command-policy-uncertainty.test.ts test/step-run-command-timeout.test.ts`; add affected command and persistence regressions. |
| Providers and model access | From `packages/providers`, select mock / faux and protocol conformance tests, such as `pnpm exec vitest --run test/dialect-provider-registry.test.ts test/faux-provider.test.ts`, with no real credentials. |
| CLI startup and protocol modes | From `apps/cli`, select `test/package-command-paths.test.ts` and affected startup tests. From `packages/coding-agent`, select `test/rpc-jsonl.test.ts`, `test/rpc-prompt-response-semantics.test.ts`, and SDK tests for affected consumers. |
| UI, keyboard input, or terminal rendering | From `apps/cli`, run `pnpm exec vitest --run test/tui-acceptance-snapshot.test.ts` and affected components. From `packages/tui`, use `node --test test/<name>.test.ts`, covering narrow screens, resize, focus, overlays, CJK, ANSI, and both screen modes as applicable. |
| Public exports, package entry points, or release artifacts | Inspect manifests and guards, build affected outputs from current source, and test the actual artifact under its intended launcher. For release bundle logic, run root `node --test scripts/release-bundle.test.mjs`. |

During development, run the focused checks that cover the changed behavior. Before submitting or updating a PR, follow the existing repository-wide `npm run check` and `./test.sh` requirements; do not repeat unchanged passing evidence solely to create another commit or push.

Documentation-only work does not introduce dependency changes, provider-data refreshes, or real model calls. Build only when the selected validation consumes artifacts; `./test.sh` may perform its offline build when outputs are missing.

## Fixtures, source execution, and artifacts

- Prefer existing owning test files over one new file per assertion. Add a regression that fails the old defective behavior and passes the fix; assert behavior at the meaningful caller, not a duplicate of implementation branches.
- For coding sessions, use `test/suite/harness.ts` and the faux provider as specified by the [suite rules](../packages/coding-agent/test/suite/README.md). Mock nondeterministic boundaries such as model streams, networks, clocks, or child processes while retaining the real runtime and consumer path being tested.
- Some workspace tests import package entry points that resolve to ignored `dist/` files. The root [test wrapper](../test.sh) builds offline when required outputs are absent, but presence alone does not prove freshness. Refresh outputs affected by a code change before treating artifact-based tests as current evidence.
- Keep source-launch tests explicit about their subject and launcher. Source tests can verify development resolution; they do not substitute for a built entry-point smoke. Conversely, do not force a test of source resolution through an artifact.
- Test the actual CLI, RPC, SDK, or tool consumer when the change crosses that entry point. A helper-only mock cannot demonstrate correct startup, framing, exit status, or consumer interpretation.
- Default tests use fake accounts, fixtures, temporary resources, and keyless providers. Real-API tests require an explicit task scope and separate evidence; never enable them accidentally through inherited credentials.

## Assertions and expected output

- Assert observable effects: reread files, persisted session entries, actual protocol output, registered tools, and cleanup results. An agent's claim of success is not sufficient evidence.
- Verify unaffected resources remain unchanged when the operation is scoped. Test failure paths for partial writes, uncertain execution, cancellation, retries, and replay as applicable.
- Prompt, tool-description, schema, and model-visible output changes affect agent behavior. Name the receiving modes and users, and use the existing faux-session or snapshot facilities to verify the intended request / response behavior.
- Update UI snapshots only for an intentional visible change and review the full diff. Do not regenerate baselines merely to hide a regression; normalize only genuinely variable data, never fields that carry behavior.
- A guard regression must demonstrate that the invalid input is rejected. Green scans over valid source alone do not establish that a new rule catches violations.
- Do not assert private helper structure or timing accidents when the public behavior is the requirement. Keep clocks and ordering controlled instead of adding arbitrary sleeps.

## Concurrent resources and teardown

- Each test owns the ports, directories, external namespaces, timers, listeners, and child processes it acquires. Use isolated fixtures and unique temporary paths rather than shared predictable names or fixed ports.
- Settle resources in teardown even after assertion failure, timeout, or retry. Abort or kill owned work, wait for exit, remove listeners and timers, release locks, and clean only verified owned paths.
- Keep IPC paths within platform limits and distinguish host sandbox restrictions from product failures. A host limitation requires recorded evidence; it is not a reason to remove an assertion or bypass a product permission check.
- Tests must work in the suite's supported parallel execution. A case passing alone but failing alongside others needs investigation into shared state, resource ownership, synchronization, and timeout budgets.
- Results apply to the platforms actually tested. macOS or Linux success does not demonstrate Windows behavior for shells, path handling, native helpers, or installers.

## Handling failures and reporting evidence

Record the exact command, selected test count, failure, and environment before changing anything. Classify the failure as changed behavior, an existing defect, stale artifacts, shared-state nondeterminism, a missing platform capability, or a host restriction using evidence from the failing path.

Run a focused reproduction when it resolves an uncertainty. A successful isolated retry does not by itself establish why the suite failed; retain the failure evidence and repeat the affected combined path after fixing or confirming the cause. Do not weaken checks, enlarge timeouts without a justified budget, or relabel an unexplained failure as infrastructure.

Report commands actually run, outcomes, relevant platforms, intentional skips, and remaining failures. The root CI [workflow](../.github/workflows/ci.yml) currently builds, checks, and tests on Linux with Node 22; do not claim a broader local or CI matrix than exists. Report queued or running CI as pending.
