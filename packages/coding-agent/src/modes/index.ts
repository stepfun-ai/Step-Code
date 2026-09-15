/**
 * Run modes for the coding agent.
 *
 * The interactive mode UI has moved to the product shell (@step-harness/cli);
 * this barrel no longer re-exports InteractiveMode. The remaining modes
 * (print/rpc/json) stay in this package.
 */

export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
