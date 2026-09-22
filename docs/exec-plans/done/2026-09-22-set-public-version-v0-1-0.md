# Set public Step version to v0.1.0

## Step

Update the public Step product version source to `0.1.0` while preserving the
independent internal workspace package versions. Verify development and release
version resolution from the latest `github-opensource` commit.

## Tool

1. Inspect the CLI version alias and release scripts to identify every public
   Step version source.
2. Edit only the public product version source and any directly required
   generated or lock metadata.
3. Run `npm run check`, the CLI version smoke command, and focused release
   version tests; inspect the final diff and worktree.

## Expectation

- `pnpm step --version` reports `0.1.0`.
- Release/version scripts resolve the root public version as `0.1.0`.
- Internal workspace packages retain their existing versions.
- Checks pass with no unrelated changes.

## Rollback

Restore the edited public version source and remove this execution plan if the
checks fail or the version resolution is not limited to the public Step
product.
