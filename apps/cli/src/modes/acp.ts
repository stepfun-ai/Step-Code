/**
 * --mode acp: Agent Client Protocol v1 over newline-delimited JSON-RPC stdio.
 *
 * Implementation lives in coding-agent/src/modes/acp/*. The product shell
 * dispatches to runAcpMode when appMode === "acp".
 */
export { runAcpMode } from "@step-harness/coding-agent";
