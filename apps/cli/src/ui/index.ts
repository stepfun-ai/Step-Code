/**
 * The single entry the shell (main/args/bootstrap/modes) uses to reach the
 * interactive UI. check-layer-direction rule 1 requires shell/shared code to
 * import the UI only through `#ui` / `#ui/index`, never a deep `#ui/...` path.
 *
 * The interactive UI, the `--resume` session picker, the `config` selector and
 * the startup selectors moved here from coding-agent in S4-0 (verbatim, no
 * runtime/view split). The shell threads the startup selectors back into
 * coding-agent's `prepareMain` as injected `uiHooks` so coding-agent never
 * imports this shell (which would be a reverse dependency).
 */

// The InteractiveMode options type is described by coding-agent (so MainOptions
// can carry a Pick of it without a reverse dependency); re-export it here so the
// shell's dispatch construction can reference it through the door.
export type { InteractiveModeOptions } from "@step-harness/coding-agent";
export { selectConfig } from "./config-selector.ts";
export { InteractiveMode } from "./interactive-mode.ts";
export { selectSession } from "./session-picker.ts";
export {
	createStartupTui,
	type StartupTuiPathOptions,
	showFirstTimeSetup,
	showStartupInput,
	showStartupSelector,
	startStartupTui,
} from "./startup-ui.ts";
