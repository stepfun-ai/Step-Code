/**
 * PII redaction for feedback diagnostics excerpts.
 *
 * `redactSecretString` (secret-redaction.ts) deliberately targets only
 * credentials and leaves ordinary URLs and paths intact, because a feedback
 * comment or transcript still needs them to be useful. Diagnostics excerpts are
 * different: they are copied verbatim into a report that leaves the machine, so
 * the identifying shapes credential redaction skips — absolute paths (which
 * carry the OS username), bare emails, and URLs — are collapsed here.
 *
 * Credential-shaped values (JWT, provider tokens, API keys) are intentionally
 * NOT handled here: the caller runs `redactSecretString` over the same text
 * first, so duplicating those patterns would be redundant. This mirrors the
 * shapes the legacy Step telemetry client redacted, minus the credential set.
 */

const REDACTED_PATH = "<redacted:path>";
const NODE_MODULES_MARKER = "node_modules/";

// Unicode-aware path grammar (mirrors the legacy client): an ASCII-only
// expression leaked CJK home directories such as /Users/张三/....
const PATH_SEGMENT = String.raw`[^\s/\\:*?"'\x60<>|,;()\[\]{}]`;
const PATH_START = String.raw`(?:(?<![^\s"'\x60=(\[{,;:])|(?<=:\/\/))`;
const POSIX_PATH_SOURCE = `${PATH_START}(?:/(?:${PATH_SEGMENT}+(?: ${PATH_SEGMENT}+)*(?=/)|${PATH_SEGMENT}+)){2,}/?`;
const WINDOWS_PATH_SEGMENT = String.raw`[^\s\\/:*?"<>|]`;
const WINDOWS_PATH_SOURCE = String.raw`(?<!\w)[A-Za-z]:\\(?:(?:${WINDOWS_PATH_SEGMENT}+(?: ${WINDOWS_PATH_SEGMENT}+)*(?=\\)|${WINDOWS_PATH_SEGMENT}+)\\?){2,}`;
const ABSOLUTE_PATH = new RegExp(`${WINDOWS_PATH_SOURCE}|${POSIX_PATH_SOURCE}`, "gu");

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const URL = /https?:\/\/[^\s"'<>]+/giu;

/** Keep the tail from `node_modules/` onward (still useful) but drop the user-identifying prefix. */
function collapseAbsolutePath(match: string): string {
	const index = match.indexOf(NODE_MODULES_MARKER);
	return index === -1 ? REDACTED_PATH : match.slice(index);
}

/**
 * Redact absolute paths, bare emails, and URLs from a diagnostics line. Run
 * after `redactSecretString` so credential shapes are already gone.
 */
export function redactDiagnosticPii(value: string): string {
	let output = value.replace(ABSOLUTE_PATH, collapseAbsolutePath);
	output = output.replace(EMAIL, "<redacted:email>");
	output = output.replace(URL, "<redacted:url>");
	return output;
}
