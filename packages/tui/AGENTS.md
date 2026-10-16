# packages/tui

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/pi-tui`; it provides terminal input, layout, and rendering primitives with zero AI dependencies.

## Responsibilities and entry points

- `src/index.ts`, `tui.ts`: public component, focus, overlay, and rendering interfaces. `tui-main-screen.ts`, `tui-alt-screen.ts`: regular / fullscreen differential output.
- `src/terminal.ts`, `stdin-buffer.ts`, `keys.ts`, `keybindings.ts`: terminal lifecycle, input sequences, and key recognition.
- `src/layout.ts`, `layout-node.ts`, `components/`: layout, containers, editors, lists, text, and image components.
- `src/utils.ts`, `terminal-image.ts`, `terminal-colors.ts`: visible column width, ANSI handling, image protocols, and color detection.
- `native/`: macOS / Windows input helpers and platform prebuilds. `test/virtual-terminal.ts`: controlled terminal tests.

## Boundaries and invariants

- Do not import Agent, provider, session, coding-product, or application-host code. Callers inject product themes, approvals, and message semantics; do not infer them from business objects.
- Measure width in visible terminal columns, not string length. Measurement, wrapping, truncation, and cursor positioning must handle CJK, combining characters, ANSI sequences, and image lines consistently.
- Preserve component `render(width)` and `invalidate()` contracts. Invalidate caches on content, width, or theme changes; dirty-start optimizations must not lose visual changes.
- Preserve distinct scrollback, viewport, selection, and differential-output semantics for regular and fullscreen modes. Do not conceal rendering defects with unconditional full-screen repaints.
- Use existing overlay, focus, and IME cursor interfaces. Restore focus after closing overlays; do not split input sequences / bracketed paste or misclassify them as individual keys.
- Settle resources for terminal start / stop, resize, color detection, and platform helpers. Do not add product refresh loops or dependencies on private local configuration.
- Native changes check platform source, build scripts, and corresponding prebuilds together. Do not replace only a local binary while breaking other platforms.

## Validation and documentation

- Run root `pnpm run check:tui-no-ai`; run the full `pnpm run check` after code changes.
- Use Node tests here, for example `node --test test/tui-render.test.ts test/tui-alt-screen.test.ts test/truncate-to-width.test.ts`, plus relevant input / overlay / cache regressions.
- Rendering changes cover narrow terminals, resize, CJK, ANSI, images, and both screen modes. Prefer the virtual terminal over real logins or model services.
- Update the [package overview](README.md), [editor styling](docs/editor-styling.md), or [product rendering pipeline](../../docs/tui-rendering-pipeline.md), as applicable.
