/**
 * Session output modes.
 *
 * Two wire protocols are preserved and covered independently:
 *  - --sdk-stdio : length-prefixed framing (./sdk-stdio.ts)
 *  - --mode rpc  : newline-delimited JSONL framing (./rpc.ts)
 * plus the plain print (./print.ts) and json (./json.ts) headless channels, and
 * the interactive TUI (./interactive.ts) the shell constructs directly.
 */

export { InteractiveMode, type InteractiveModeOptions } from "#modes/interactive";
export type { JsonAgentSessionEvent } from "#modes/json";
export { type PrintModeOptions, runPrintMode } from "#modes/print";
export { RpcClient, type RpcClientOptions, runRpcMode } from "#modes/rpc";
export { createSdkStdioMode, type SdkStdioModeOptions } from "#modes/sdk-stdio";
