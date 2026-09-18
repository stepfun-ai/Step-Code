# Frontend visual loop, phase 1: MCP image passthrough + prompt guidance

Owner: youwang + Claude. Branch: `feat/frontend-visual-loop`.

## Problem

Frontend work quality lags because the screenshot half of the
build -> render -> look -> fix loop is broken in two places:

1. The Step MCP bridge keeps only text blocks from MCP tool results
   (`src/step/mcp.ts` createRemoteTool). The built-in playwright plugin's
   screenshot tools answer with MCP image blocks, so the capture is silently
   dropped; an image-only result degrades into `JSON.stringify(result)` — a
   base64 dump pasted as text.
2. Nothing in the system prompt tells the model to verify UI work visually.
   The validation vocabulary is tests/typecheck/lint/build only, and no
   guidance covers the save-screenshot-then-read_file pattern or that
   subagent reports are text-only.

## Steps

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Extract `convertMcpCallResult` from createRemoteTool; pass MCP image blocks through as ImageContent; image-only results get a "(see attached image)" note instead of a JSON/base64 dump | edit `src/step/mcp.ts` | new unit tests pass; text-only behavior unchanged | revert file |
| Extend Workflow validation bullet with visual verification for UI-facing changes (and the playwright plugin pointer) | edit `src/step/system-prompt.ts` | bullet mentions visual verify; existing prompt tests pass | revert file |
| Add a browser-tool-gated "# Frontend visual verification" section (render -> screenshot -> read_file -> iterate; subagents return file paths) | edit `src/step/system-prompt.ts` | section present only when a browser/screenshot tool is active | revert file |
| Tests + changelog | add `test/step-mcp-remote-tool.test.ts`, edit `test/step-system-prompt.test.ts`, `CHANGELOG.md` | targeted vitest green; `npm run check` green | revert files |

Deferred (follow-up MRs, feasibility already scouted): background process
support in run_command for dev servers; image passthrough from subagent /
workflow agent reports (contract change); bundling a frontend-verify skill.

No destructive or publishing side effects; code edits on a feature branch.
