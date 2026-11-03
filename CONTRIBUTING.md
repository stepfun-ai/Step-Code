# Contributing to StepCode

## Contribution access and required reviews

StepCode accepts pull requests from invited collaborators. Keep pull request
creation set to **Collaborators only**. Invited external developers receive
**Write** access to this repository and may work in a fork or a development
branch, then open a pull request targeting `main`. Claiming an issue does not
grant access; without an invitation, agree on a submission method with a
maintainer in the issue.

The four maintainers listed in [.github/CODEOWNERS](.github/CODEOWNERS) form the
fixed internal review pool for all repository paths. Each pull request requires
approval from **at least one member of that pool**, excluding the
pull request author. External collaborators' approvals do not count toward this
internal requirement. Maintainer-authored pull requests follow the same rule.

Before merging, the required CI checks must pass, review conversations must be
resolved, and approvals must cover the current changes. Code changes after an
approval require renewed review. An internal maintainer performs the merge;
contributors must not push directly to `main`.

`CODEOWNERS` requests reviews but does not enforce required owner approval or
restrict who can merge. These requirements must also be enabled in GitHub's
repository settings. See the [repository review configuration](docs/repository-review.md)
for setup and verification; adding these files alone does not activate those
settings.

## Philosophy

**StepCode's core is minimal.** Features that do not belong in the core should be extensions; PRs that bloat the core will likely be rejected. Even new extension hook points need discussion first, to avoid unmaintainable bloat and complex interactions.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

## Commit Attribution

Follow the [commit attribution policy](AGENTS.md#commit-attribution): AI tools may assist, but the author and committer remain the human contributor's verified GitHub identity, with no AI co-author trailers. The `Commit attribution` check rejects these trailers and identities on pull requests.

If you use an agent, run it from the repository root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Before You Start

- Read the issue and its discussion, then comment with your proposed approach and ask a maintainer to confirm the work is available and the direction is right. An open issue is not necessarily unclaimed.
- For problems reported outside GitHub, confirm the background, owner, and expected outcome with a maintainer, and whether an issue should be created first, to avoid duplicate implementations.
- Existing pull requests can help you reproduce or evaluate a problem, but they are not automatic merge candidates. Do not reuse another contributor's code without confirming that is appropriate.
- Discuss unclear requirements, broad changes, and public interface changes before implementation. Report security vulnerabilities according to [SECURITY.md](SECURITY.md).
- Start a working branch from the latest `main`. Keep each PR focused on one problem, without unrelated refactoring.

## Issues

Use one of the two GitHub issue templates, and keep the issue short, concrete, and worth reading:

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice (do not use an LLM to generate text; if you must, follow up with a clearly AI-labeled comment).
- State the bug or request clearly, and explain why it matters.
- If you want to implement the change yourself, say so.

Issues submitted Friday through Sunday are not guaranteed to be reviewed (see the [FAQ](#why-are-weekend-issues-lower-priority)). If something is urgent, say so at the top of the issue and explain the impact.

## Blocking

If you ignore this document twice, spam the tracker with agent-generated issues, or send a large volume of issues through automation, your GitHub account will be permanently blocked.

## Commit and PR Conventions

Write commit subjects and bodies, PR titles and descriptions, public issues, and review comments in English. Commit and PR titles follow Conventional Commits: `type(scope): summary`, with an optional scope. Use a concrete summary such as `fix(session): preserve queued input after cancellation`.

Keep each commit focused on one coherent responsibility. Separate independent changes so reviewers can inspect them; do not add empty or artificial commits to increase the count.

Follow the [development and collaboration guide](docs/development.md) for coding practices, concurrent ownership, error handling, and Git workflow. Use the [testing policy](docs/testing.md) to select behavior-level evidence while developing.

## PR Review Checklist

Use the [PR template](.github/pull_request_template.md) and replace its guidance with concrete evidence. Scale the description to the change, and explain any section that does not apply.

- State the problem and resulting behavior. For bugs, include a reproducible trigger and explain the root cause.
- Identify affected modules, public consumers, and changes to previously accepted inputs: configuration keys, environment variables, CLI arguments, provider responses, persisted sessions, RPC/SDK calls, and extension hooks.
- For a changed default, removed fallback, or narrowed branch, describe who used the old behavior and their migration or escape path. A refactor accounts for the old path's feature inventory rather than silently losing it.
- Treat system prompts, tool descriptions, reminders, and model-visible output as behavior. State who receives changed text, what it controls, and how the new behavior is verified.
- Review public interfaces at both producer and consumer sides. Check old session data and error / cancellation behavior where relevant; document intentional compatibility changes.
- Include exact validation commands and results, relevant platforms, and any skipped or unverified cases. Report pending CI as pending; a passing unit test alone does not prove a built CLI or protocol entry point works.
- Explain user-visible snapshot changes and verify actual files, persisted state, or protocol output rather than only an agent's success message.
- Confirm the diff contains only intended files, public examples use neutral data, and temporary handoff notes, private infrastructure, credentials, and AI attribution are absent.

Respond to each review concern and explain how you addressed it.

## Before Submitting a PR

Before submitting a PR:

```bash
pnpm run check
./test.sh
```

Both must pass.

These are repository-wide submission checks. During development, run focused checks for the changed behavior; do not repeat a passing check solely because a commit or push follows, unless files or relevant inputs changed. Inspect any modifications made by the formatter before staging or publishing. If environment constraints prevent validation, state exactly what failed or was not run in the PR.

If you are adding a new provider to `packages/providers`, see [packages/providers/AGENTS.md](packages/providers/AGENTS.md#validation-and-documentation) for required tests.

## FAQ

### Why are weekend issues lower priority?

We triage the tracker during working hours, so issues accumulate over the weekend. Anything submitted Friday through Sunday may be missed or given lower priority in the Monday review queue. If a problem is urgent, flag it in the issue and include the short version, a repro, and the relevant logs.

### Why do some issues get no reply?

A reply is maintenance work too. Low-signal issues, unclear reports, duplicates, and issues that do not follow this guide may be closed without discussion. This keeps time available for reproducible bugs, thoughtful requests, and contributors who have done the work to make their report actionable.

### Why not let AI triage everything?

AI can help group duplicates, summarize reports, and spot missing information. It is not trusted to make final maintainer decisions. Polished AI-generated issues can still be wrong, misleading, or expensive to investigate. Human review remains the final gate.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues are welcome. Thoughtful contributions are welcome. Automated slop, entitlement, and large volumes of low-effort reports are not.
