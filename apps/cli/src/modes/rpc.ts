/**
 * --mode rpc: newline-delimited JSONL request/response framing.
 *
 * Implementation lives in coding-agent/src/modes/rpc/*. pi's main() dispatches
 * to runRpcMode when appMode === "rpc". This channel is covered independently of
 * --sdk-stdio (length-prefixed framing); the two protocols are separate.
 */
export { RpcClient, type RpcClientOptions, runRpcMode } from "@step-harness/coding-agent";
