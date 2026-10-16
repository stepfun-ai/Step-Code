# CLI interactive UI

Inherits the [CLI rules](../../AGENTS.md). This directory presents session events and handles user input; it does not own Agent or persistent-session semantics.

## Responsibilities and entry points

- `index.ts`: the shell's single UI facade. `interactive-mode.ts`: interactive host and component composition.
- `startup-ui.ts` and selectors: startup login, trust, configuration, and session selection.
- `runtime/context.ts`: host injection interfaces. `runtime/session-events.ts`: events to views. `runtime/input-dispatch.ts`: input and actions. `runtime/redraw.ts`: redraw facade.
- `view/chrome/`, `view/dialogs/`, `view/editor/`, `view/transcript/`: presentation components.

## Boundaries and invariants

- Dependencies flow UI host → runtime → view. Runtime uses its own `RuntimeContext` and must not import the UI host or shell; view must not import runtime. The check script also reserves leaf-layer constraints for `ui/state/`; new state modules must not depend on higher UI layers.
- UI may cache rendering, queue presentation, selection, and input state. Read authoritative messages, tasks, goals, and session state from product sessions and events; do not reconstruct them from text.
- Use `@step-harness/pi-tui` for differential rendering, layout, focus, and input sequences. Do not copy the renderer or add an independent refresh loop.
- Request redraws through `runtime/redraw.ts`. Use the existing scheduler for streaming updates; force redraws only for established invalidation scenarios such as recovery, resizing, or theme changes.
- Use coding-agent's active theme and configurable keybindings. Measure, wrap, and truncate by visible terminal column width, covering CJK, ANSI, images, and narrow screens.
- Restore focus after closing dialogs. Async callbacks must not update closed or replaced sessions. Approval UI only presents and returns product-policy requests.
- The first frame and editor must not wait for slow MCP connections. While startup selectors own the screen, do not render the main UI first and cover it afterward.

## Validation and documentation

- Run root `pnpm run check:ui-layer`; run `pnpm exec vitest --run test/tui-acceptance-snapshot.test.ts` from `apps/cli`, then select relevant component tests.
- Validate layout or input changes in a controlled terminal, covering narrow screens, resize, paste, overlays, and regular / fullscreen modes. Explain visible behavior changes when updating snapshots.
- See the [rendering pipeline](../../../../docs/tui-rendering-pipeline.md) and [goal UI](../../../../docs/step-goal-ui.md).
