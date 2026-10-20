# Contributing to Step Code

Help improve Step Code by fixing bugs, improving existing behavior, or proposing focused features. Coordinate with a maintainer before starting work, validate your changes, and submit them for internal review and merge.

This guide covers the contribution workflow across the project. [CONTRIBUTING.md](CONTRIBUTING.md) remains authoritative for contribution and review requirements.

## Project resources

- [Repository](https://github.com/stepfun-ai/Step-Code)
- [GitHub Issues](https://github.com/stepfun-ai/Step-Code/issues)
- [Contribution requirements](CONTRIBUTING.md)
- [Development guide](docs/development.md)
- [Pull request template](.github/pull_request_template.md)

## Contribution workflow

**Find an issue → confirm ownership and approach → implement and test → open a pull request → internal review and merge.**

GitHub calls a code review request a pull request (PR); other platforms may call it a merge request (MR).

## Find and claim an issue

Read the issue description and discussion before taking on an existing GitHub issue. Comment with your proposed approach and ask a maintainer to confirm that the work is available and the direction is appropriate. Do not assume an issue is unclaimed just because it is open.

For problems reported elsewhere in the community, contact a maintainer to confirm the background, owner, expected outcome, and whether a GitHub issue already exists. Agree on whether to create an issue before starting work, and avoid duplicate implementations.

Existing pull requests can help you understand a problem, reproduce it, or evaluate possible approaches. They are not automatic candidates for merge. Verify the solution, implementation, tests, and code provenance against the current repository and requirements; do not copy another contributor's code without confirming that reuse is appropriate. Contact a maintainer if you find overlapping work.

Discuss unclear requirements, broad changes, and public interface changes before implementation. Report security vulnerabilities according to [SECURITY.md](SECURITY.md), without posting credentials or sensitive details publicly.

## Prepare your changes

1. Read [CONTRIBUTING.md](CONTRIBUTING.md), the root [AGENTS.md](AGENTS.md), and any `AGENTS.md` files in the affected directories and their ancestors.
2. Agree on the problem, acceptance criteria, and scope. Start a working branch from the latest `main`; do not work directly on `main`. Follow the [development guide](docs/development.md) for environment setup and dependency installation.
3. Keep each pull request focused on one problem. Avoid unrelated refactoring. Consider whether a new feature belongs in an extension rather than the core.
4. You may use AI assistance, but you remain responsible for understanding and explaining what changed, why it changed, and how it was verified.

## Commit and validate

- Write commit messages and pull request titles and descriptions in English. Use Conventional Commits for commit and PR titles, for example `fix(session): preserve queued input after cancellation`. Split independent changes into coherent commits, not empty or artificial fragments.
- Keep the Git author and committer as your own verified GitHub identity. Do not add AI tools as co-authors or include AI-generated attribution footers.
- Add relevant tests and documentation when behavior changes. Check compatibility with existing configuration, CLI arguments, persisted sessions, and extension interfaces. Do not commit secrets, private project content, or internal material to the public repository.
- During development, run focused tests for the behavior you change, following the [testing policy](docs/testing.md).
- Before submitting or updating a pull request, run both required repository-wide checks from the repository root:

  ```bash
  npm run check
  ./test.sh
  ```

  Both must pass. The check command may apply formatting fixes; inspect the diff before committing. If environment constraints prevent validation, state exactly what failed or was not run in the PR rather than claiming it passed.

## Submit a pull request

The contribution policy requires PR creation to be set to **Collaborators only**; maintainers must verify the actual repository settings. Claiming an issue does not grant submission or merge access. A maintainer must invite you and grant collaborator access. If you do not have access, contact a maintainer through the issue to agree on a submission method. Do not assume an uninvited fork can open a PR against the repository.

Once you have access, work in a development branch or fork and open a PR targeting `main`. Follow the [PR template](.github/pull_request_template.md) and include:

- The related GitHub issue, or a clear problem description if there is no issue.
- Reproduction steps and root cause for a bug, and the resulting user-visible behavior.
- The affected areas, compatibility implications, known risks, and any migration requirements.
- Exact validation commands and results, including anything skipped and why.

Respond to review feedback, make the agreed changes, and explain how you addressed each concern. Revalidate when code or relevant inputs change; earlier passing results do not establish that a revised implementation passes.

## Review and merge

Every PR requires approval from at least one internal maintainer in [.github/CODEOWNERS](.github/CODEOWNERS), excluding the PR author. External collaborator approvals do not replace internal review. Maintainer-authored PRs follow the same rule.

Required CI checks must pass, review conversations must be resolved, and approval must cover the current changes. Code changes after approval require renewed review. An internal maintainer performs the merge; contributors must not push directly to `main`.

External issues and pull requests are welcome as references, and contributions are welcome through this workflow. Existing external PRs must not bypass internal review. Follow maintainers' current guidance and the repository's actual settings if access or submission arrangements change. See [repository review configuration](docs/repository-review.md) for the permission and review setup.
