/**
 * Startup assembly for the app shell.
 *
 * Fixed order (violating it fails silently — a partner receives dirty bytes, or
 * pi resolves the wrong storage namespace):
 *   1. installStdoutCapture   — capture the raw stdout byte writer (always first)
 *   2. loadAndMigrateConfig    — migrate legacy config before any file is created
 *   3. initTelemetry           — construct the telemetry runtime
 *   4. checkAuth               — credential migration / uid resolution
 *   5. registerExtensions      — the single, static extension registration point
 *   6. createShutdownRegistrar — terminal lifecycle + telemetry flush
 *
 * The Step entry signal (bootstrap/environment.ts) is imported even earlier, by
 * the entry module, before the coding-agent barrel is evaluated. main.ts drives
 * this order directly; these re-exports are the shared building blocks.
 */

export {
	loadStepStartupConfig,
	type StepStartupConfig,
	showDeprecationWarnings,
} from "#bootstrap/config";
export {
	createStepExtensionFactories,
	type StepExtensionFactoryDeps,
} from "#bootstrap/extensions";
export { captureRawStdout, type RawStdoutWrite, sdkStdioRequested } from "#bootstrap/stdout-capture";
