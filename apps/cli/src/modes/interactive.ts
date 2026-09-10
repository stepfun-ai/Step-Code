/**
 * interactive: the full-screen TUI session mode.
 *
 * Implementation lives in coding-agent/src/modes/interactive/*. Unlike the
 * headless channels, the shell constructs InteractiveMode itself (in its
 * dispatch switch) so it can thread the product's interactiveModeOptions in;
 * this door keeps that construction from reaching into the coding-agent barrel
 * directly. stdout is NOT taken over for this mode (the TUI owns the terminal).
 */
export { InteractiveMode, type InteractiveModeOptions } from "@earendil-works/pi-coding-agent";
