#!/usr/bin/env node

// Keep the standalone Step binary's Bun setup in lockstep with the Pi binary.
// The product entrypoint itself owns Step environment/provider defaults; this
// wrapper only installs Bun-specific runtime hooks before importing it.
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();
restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("../step-cli.ts");
