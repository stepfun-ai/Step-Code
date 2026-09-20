# Command approval runtime verification

Follow-up to the published `codex/rm-rf-mandatory-approval` branch, based on
`github-opensource`. The user requested functional tests and a runnable build.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Add execution-level regressions | Existing suite harness, faux provider, real Step command tool, temporary marker directories | Pending/rejected approval never deletes the marker; each approved call executes; unattended/strict/deny policies block | Remove only these test additions if the fixture is invalid |
| Compile and smoke-test artifacts | Authorized `npm run build:offline`; isolated compiled CLI and compiled policy/tool checks | CLI help/version start successfully; built command policy protects actual temporary files | Leave generated ignored artifacts; no production changes without a reproduced defect |
| Verify and publish tests | Focused tests, `npm run check`, full offline suite, explicit-path commit and ordinary push | Regression evidence is reproducible; feature branch remains the only published target | No force push or merge; record failures honestly |

No real provider APIs, credentials or paid tokens are used. Any executed removal
is limited to a marker directory created specifically by the test. Existing
user files and the original checkout are not touched. Existing build and
feature-branch publication authorization remains applicable.

## Runtime evidence

- Added `test/suite/step-command-approval.test.ts` using the required suite harness
  and faux provider, the actual Step extension, actual agent/session hooks, and
  the actual `run_command` implementation. No shell executor is mocked.
- Ten cases cover ask, bypass, low-level auto, autopilot, unattended `allow`,
  strict mode and explicit tool denial. Approval is held pending while the marker
  is checked; approval removes it, denial preserves it, and a second call asks
  again after the first was approved. Tool results are also checked.
- The fixture shuts down extensions before disposing the harness, matching the
  normal runtime lifecycle and awaiting cancellation of detached MCP discovery.
  The initial fixture lacked that shutdown and reported stale-context errors;
  the corrected ten-case suite passes without unhandled errors.
- Rebuilt with `npm run build:offline`. An isolated temporary smoke script imports
  only compiled product/provider modules, constructs a real SDK session and tool
  with faux responses, and denies network fetches. For all four modes, rejection
  preserves the marker and acceptance executes the command. Markers remain
  present while the confirmation callback waits. All eight SDK scenarios pass.
- The packaged `dist/bundle/step.js` starts with `--help` and `--version` in an
  isolated home/workspace; both return successfully with expected output.
- `npm run check` passed with full output and no warnings (1,099 files checked).
  No production runtime code or dependency changes were required.
- Final `./test.sh` completed successfully with credential-free isolation:
  coding-agent passed 268 files / 2,991 tests (existing 7 files / 66 tests skipped),
  CLI passed 74 files / 566 tests, and all other workspace/script runners passed.
  No test selection, assertions, or timeouts were weakened.
- The follow-up publishes only this record and the ten execution-level tests
  onto the existing feature branch. The merge target remains `github-opensource`.
