/**
 * Application-mode resolution for the shell's own dispatch.
 *
 * The rules (sdk-stdio/rpc → rpc, --mode json → json, non-TTY/-p → print, else
 * interactive) and the print-channel projection are pi-owned
 * (coding-agent/src/main.ts). The shell re-exports them through this single door
 * so its dispatch switch and any test can name the same `AppMode` union pi's
 * `prepareMain()` returns, without reaching into the coding-agent barrel for
 * argv/mode concerns from scattered call sites.
 *
 * Note: the shell reads the *final* mode from `prepareMain().appMode` (which has
 * already flipped interactive → print for piped stdin). `resolveAppMode` is
 * re-exported for tests and completeness; the dispatch switch must not re-run it.
 */
export { type AppMode, resolveAppMode, toPrintOutputMode } from "@step-harness/coding-agent";
