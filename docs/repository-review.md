# Repository access and review configuration

This guide describes the GitHub settings needed to enforce the
[contribution review policy](../CONTRIBUTING.md#contribution-access-and-required-reviews):
at least one approval from the fixed internal review pool, passing CI, and merging
by an internal maintainer. Repository files do not activate these settings.

## Contribution access and reviewer membership

1. In **Settings > General > Features > Pull requests**, keep **Creation allowed
   by: Collaborators only**.
2. Grant invited external developers **Write**, without Maintain, Admin, or any
   ruleset bypass role. Read and Triage do not qualify for this PR creation policy
   in an organization-owned repository. Write is repository write access, so the
   branch restrictions below are also required.
3. Use the four individual maintainers in [CODEOWNERS](../.github/CODEOWNERS) as
   the review pool for every repository path. Each owner must retain Write access
   or higher. Organization membership and an organization team are not required.
4. Keep `CODEOWNERS` and the four-account merge allowlist synchronized when the
   maintainer roster changes. Maintain or Admin access alone does not place a
   person in the fixed review or merge pool.

External Write collaborators can submit reviews, including Approve. Their
approvals do not satisfy the required Code Owner review. The PR author cannot
approve their own PR, including when the author is one of the four maintainers.

## Required reviews and checks

Merge `CODEOWNERS` into `main` first, then activate the review ruleset below.
Until it exists on the base branch, requiring a Code Owner review cannot enforce
the fixed reviewer roster. Prepare the ruleset as **Disabled** while this
prerequisite is pending; do not describe the one-internal-approval gate as active.

In **Settings > Rulesets**, configure a branch ruleset named
`main-review-requirements` targeting `main`. Keep any existing protections enabled.

| Setting | Required configuration |
| --- | --- |
| Enforcement status | Active only after `CODEOWNERS` is present on `main` and its owners are valid. |
| Bypass list | Empty; internal maintainers must also satisfy reviews and CI. |
| Require a pull request before merging | Enabled. |
| Required approvals | 1. |
| Require review from Code Owners | Enabled for every path through the catch-all `CODEOWNERS` rule. |
| Dismiss stale approvals | Enabled when new commits change the PR diff. |
| Require approval of the most recent reviewable push | Enabled. |
| Require conversation resolution | Enabled. |
| Require status checks to pass | Require the build/check/test job and the commit attribution check. |
| Restrict deletions / Block force pushes | Enabled. |

Select the actual check names emitted by [CI](../.github/workflows/ci.yml) and
[Commit attribution](../.github/workflows/commit-attribution.yml), normally
`build-check-test` and `Check commit attribution`. Pin each required check to its
GitHub Actions source where available. Do not require the scheduled `npm audit`
job, which does not run on pull requests.

The owner-review requirement is essential: one generic approval can come from an
external Write collaborator. A `CODEOWNERS` line naming four people requires any
one eligible owner to approve, not all four. This setup does not enforce two
internal approvals; that would require a team-specific rule or a separate trusted
approval gate.

## Restrict who can merge

Use a separate **Active** branch ruleset named `main-internal-merges`, also
targeting `main`:

- Enable **Restrict updates**, **Restrict deletions**, and **Block force pushes**.
- Add only the four individual accounts listed in `CODEOWNERS` to this ruleset's
  bypass list, each using **For pull requests only**.
- Do not add the Write, Maintain, or Admin role, other collaborators, or a broad team.

This bypass permits the four maintainers to update `main` through a PR under this
rule only. It must not be added to `main-review-requirements`: the separate review
ruleset still requires owner approval, resolved conversations, and passing CI.
External Write collaborators can propose changes but cannot merge them into `main`.
After all requirements pass, the owner who approved the PR may also merge it.

Apply equivalent protections to any other maintained branch before accepting
external contributions to that branch.

## Verification before onboarding

Inspect the effective rules for `main`, including organization-level rules and
bypasses, then verify the following on a test PR without merging it:

| Scenario | Expected result |
| --- | --- |
| No internal owner approval, even with external approvals | Merge blocked. |
| Approval only from the PR author | Does not satisfy review requirements. |
| One eligible internal approval, failed or pending required CI | Merge blocked. |
| New code pushed after approval | Renewed review required. |
| One eligible internal approval, passing CI, resolved conversations | One of the four maintainers can merge; other collaborators cannot. |

Check review routing and required owner approval for a root file, a nested source
file, and a `.github/` file. Confirm direct pushes to `main` are denied, including
for the four maintainers. Local changes and a PR's head copy of `CODEOWNERS` do
not configure the base branch.

## GitHub references

- [PR creation permissions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/disabling-pull-requests)
- [CODEOWNERS behavior](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [Ruleset review and update rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Ruleset targets and bypass permissions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)
