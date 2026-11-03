#!/usr/bin/env node

// Standalone Step binary entry (Bun). Keep the Bun-specific runtime hooks in
// lockstep with the Node entry; the product entrypoint itself (#main) owns Step
// environment/provider defaults. This wrapper only installs Bun runtime hooks
// before importing the shared app entry.
//
// The Step entry signal is set first (before the coding-agent barrel is pulled
// through #main) so config.ts resolves the Step storage namespace even when the
// launcher filename is not detected by isStepEntrypoint().
import "#bootstrap/environment";
import { restoreSandboxEnv } from "#bun/restore-sandbox-env";

process.emitWarning = (() => {}) as typeof process.emitWarning;

restoreSandboxEnv();

await import("#main");
