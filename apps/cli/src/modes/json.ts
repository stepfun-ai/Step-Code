/**
 * --mode json: structured event output.
 *
 * The json app mode runs the same print-mode pipeline with a json output
 * channel; each emitted line is a JsonAgentSessionEvent (see contracts/wire for
 * the shared shape). Implementation lives in coding-agent/src/modes/json-event.ts.
 */
export type { JsonAgentSessionEvent } from "@step-harness/coding-agent";
