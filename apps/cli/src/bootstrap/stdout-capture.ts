/**
 * Stdout capture — bootstrap step 1 (always first).
 *
 * Two ordering invariants converge here:
 *  ① The length-prefixed SDK stdio protocol must write to the *original* stdout
 *     byte writer. Capture it before any mode can redirect process.stdout, so
 *     framed output never picks up a diagnostics-redirected stream.
 *  ② Non-interactive print/json modes take over stdout before anything prints
 *     (that takeover happens inside prepareMain() via takeOverStdout()).
 *
 * captureRawStdout() must run before loadAndMigrateConfig / initTelemetry /
 * checkAuth / registerExtensions and before prepareMain() is invoked.
 */

export type RawStdoutWrite = (chunk: Buffer) => boolean;

/**
 * Capture the original stdout byte writer for the length-prefixed SDK protocol
 * before prepareMain() redirects process.stdout for headless modes.
 */
export function captureRawStdout(): RawStdoutWrite {
	return process.stdout.write.bind(process.stdout) as RawStdoutWrite;
}

/** Whether the caller requested the framed SDK stdio host. */
export function sdkStdioRequested(argv: readonly string[] = process.argv): boolean {
	return argv.includes("--sdk-stdio");
}
