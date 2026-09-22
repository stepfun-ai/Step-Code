/**
 * -p / --print: non-interactive text output.
 *
 * Implementation lives in coding-agent/src/modes/print-mode.ts. pi's main()
 * dispatches to runPrintMode for the print and json app modes; stdout is taken
 * over before any output so the result channel stays byte-clean.
 */
export { type PrintModeOptions, runPrintMode } from "@step-harness/coding-agent";
