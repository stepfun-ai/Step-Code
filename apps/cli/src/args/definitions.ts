/**
 * CLI argument definitions.
 *
 * The parser and its `Args` shape are pi-owned (coding-agent/src/cli/args.ts).
 * The app shell consumes them through this single re-export so the rest of
 * apps/cli never reaches into the coding-agent barrel for argv concerns.
 */
export { type Args, parseArgs } from "@step-harness/coding-agent";
