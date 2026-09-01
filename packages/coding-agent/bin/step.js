#!/usr/bin/env node

import { resolveStepEntrypoint, runResolvedEntrypoint } from "./runtime-entry.js";

try {
	const entrypoint = await resolveStepEntrypoint();
	await runResolvedEntrypoint(entrypoint);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`step launcher error: ${message}\n`);
	process.exitCode = 1;
}
