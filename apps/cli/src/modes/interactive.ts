/**
 * interactive: the full-screen TUI session mode.
 *
 * Implementation lives in apps/cli/src/ui/* (moved from coding-agent in S4-0).
 * Unlike the headless channels, the shell constructs InteractiveMode itself (in
 * its dispatch switch) so it can thread the product's interactiveModeOptions in;
 * this door reaches the UI only through the `#ui` door barrel (never a deep
 * `#ui/interactive-mode` path), per check-layer-direction rule 1. stdout is NOT
 * taken over for this mode (the TUI owns the terminal).
 */

export type { InteractiveModeOptions } from "#ui/index";
export { InteractiveMode } from "#ui/index";
