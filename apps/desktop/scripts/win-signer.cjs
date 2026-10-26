// Authenticode signing for the Windows build, with the company's GlobalSign EV
// certificate on a USB token (the same identity catalyst/stepfun-desktop signs
// with; see its scripts/utils/win-signer.cjs).
//
// Runs only on the Windows packager (runner tags windows + bare-metal): the token
// sits in that machine, SafeNet Authentication Client is installed and Single
// Logon is enabled, so signtool takes the certificate by thumbprint and never
// receives a PIN or password. The token session does not survive a reboot; after
// one, someone has to sign once interactively on that machine (stepfun-desktop's
// `node scripts/unlock-win-token.cjs`) before CI can sign again.
//
// Used by apps/desktop/scripts/package.mjs (electron-builder's custom sign hook,
// and the server tree copied in afterPack) and scripts/pack-win.cjs (token probe
// before the build, signature check after it).

const { spawnSync } = require("node:child_process");
const { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");

/** GlobalSign EV code-signing certificate (SHA-1 thumbprint), overridable like falcon's token check. */
const DEFAULT_THUMBPRINT = "1ebc77b8fe31d069fe8015c75b8ffc714120e9c9";
/** RFC 3161 timestamp: the signature stays valid after the certificate expires. */
const TIMESTAMP_URL = "http://rfc3161timestamp.globalsign.com/advanced";
const SIGN_ATTEMPTS = 3;
/** The timestamp server is the slow part; a hung signtool must not hold the job. */
const SIGN_TIMEOUT_MS = 120_000;
/** A locked token makes signtool wait for a PIN dialog nobody will answer. */
const PROBE_TIMEOUT_MS = 20_000;
/** Extensions that may be PE images; each candidate is still checked for an MZ/PE header. */
const PE_EXTENSIONS = [".exe", ".dll", ".node"];

const UNLOCK_RUNBOOK = [
	"The EV token on the Windows packager is not ready to sign.",
	"On that machine: plug in the GlobalSign EV USB token, keep SafeNet Authentication Client running with Single Logon,",
	"then sign once interactively to unlock the session (stepfun-desktop: `node scripts/unlock-win-token.cjs`).",
	"The unlock does not survive a reboot. Another pipeline signing at the same time (stepfun-desktop shares the token)",
	"also makes this probe time out: retry once it has finished.",
].join("\n");

function signtoolPath() {
	const tool = path.join(repoRoot, "build", "tools", "win", "signing", "signtool.exe");
	if (!existsSync(tool)) throw new Error(`[win-sign] signtool.exe is missing at ${tool}`);
	return tool;
}

function thumbprint() {
	const value = (process.env.WIN_EV_THUMBPRINT ?? "").trim() || DEFAULT_THUMBPRINT;
	if (!/^[0-9a-f]{40}$/iu.test(value)) throw new Error(`[win-sign] WIN_EV_THUMBPRINT is not a SHA-1 thumbprint: ${value}`);
	return value.toUpperCase();
}

function signArgs(file) {
	return ["sign", "/fd", "sha256", "/sha1", thumbprint(), "/tr", TIMESTAMP_URL, "/td", "sha256", file];
}

function run(args, timeout) {
	const result = spawnSync(signtoolPath(), args, { encoding: "utf8", timeout, windowsHide: true });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { ok: result.status === 0 && !result.error, timedOut: result.error?.code === "ETIMEDOUT", status: result.status, output };
}

/** True when the file starts with an MZ header that points at a PE signature. */
function isPortableExecutable(file) {
	const header = Buffer.alloc(0x40);
	const fd = openSync(file, "r");
	try {
		if (readSync(fd, header, 0, header.length, 0) < header.length || header.toString("latin1", 0, 2) !== "MZ") return false;
		const pe = Buffer.alloc(4);
		return readSync(fd, pe, 0, 4, header.readUInt32LE(0x3c)) === 4 && pe.toString("latin1") === "PE\0\0";
	} finally {
		closeSync(fd);
	}
}

/** A valid signature that chains to a trusted root (ours or the vendor's). */
function isSigned(file) {
	return run(["verify", "/pa", "/q", file], SIGN_TIMEOUT_MS).ok;
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Sign one file; retries cover the timestamp server's hiccups, then the error names the file. */
function signFile(file) {
	let last;
	for (let attempt = 1; attempt <= SIGN_ATTEMPTS; attempt += 1) {
		last = run(signArgs(file), SIGN_TIMEOUT_MS);
		if (last.ok) return;
		console.warn(`[win-sign] attempt ${attempt}/${SIGN_ATTEMPTS} failed for ${file}${last.timedOut ? " (timed out)" : ""}`);
		if (attempt < SIGN_ATTEMPTS) sleep(5_000 * attempt);
	}
	throw new Error(`[win-sign] could not sign ${file} (exit ${last.status}):\n${last.output.slice(-800)}`);
}

/**
 * Sign every unsigned PE image under `dir`. Files a vendor already signed keep
 * their signature; non-PE files with a PE extension (other platforms' `.node`
 * prebuilds in the shared server tree) are skipped.
 */
function signTree(dir) {
	const signed = [];
	let kept = 0;
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && PE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
				if (!isPortableExecutable(full)) continue;
				if (isSigned(full)) kept += 1;
				else {
					signFile(full);
					signed.push(full);
				}
			}
		}
	};
	walk(dir);
	console.log(`[win-sign] ${path.basename(dir)}: signed ${signed.length} PE file(s), kept ${kept} vendor signature(s)`);
	return signed;
}

/** Throws unless the file carries a valid Authenticode signature; prints signtool's report. */
function verifySigned(file) {
	const result = run(["verify", "/pa", "/all", "/v", file], SIGN_TIMEOUT_MS);
	if (!result.ok) throw new Error(`[win-sign] signature check failed for ${file}:\n${result.output.slice(-1500)}`);
	const signer = result.output.match(/Issued to:\s*(.+)/u)?.[1]?.trim();
	console.log(`[win-sign] verified ${path.basename(file)}${signer ? ` (signed by ${signer})` : ""}`);
}

/**
 * Fail before a 10-minute build when the token cannot sign: sign a throwaway
 * copy of signtool.exe under a timeout, as falcon's windows_token_check.sh does.
 */
function probeToken() {
	if (process.platform !== "win32") throw new Error("[win-sign] Windows signing runs only on the Windows packager");
	const dir = mkdtempSync(path.join(tmpdir(), "stepcode-ev-probe-"));
	try {
		const probe = path.join(dir, "probe.exe");
		copyFileSync(signtoolPath(), probe);
		const result = run(["sign", "/q", "/fd", "sha256", "/sha1", thumbprint(), probe], PROBE_TIMEOUT_MS);
		if (!result.ok) {
			const reason = result.timedOut ? "timed out (token locked or busy)" : `failed (exit ${result.status})`;
			throw new Error(`[win-sign] EV token probe ${reason}.\n${UNLOCK_RUNBOOK}\n${result.output.slice(-600)}`);
		}
		console.log(`[win-sign] EV token ready (certificate ${thumbprint()})`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * electron-builder `win.signtoolOptions.sign` hook. Called per file and per hash;
 * only SHA-256 is configured. A file that already verifies is left alone, so a
 * second pass (installer + uninstaller) does not double-sign.
 */
function electronBuilderSign(configuration) {
	if (configuration.hash !== "sha256") return;
	if (!isPortableExecutable(configuration.path) || isSigned(configuration.path)) return;
	signFile(configuration.path);
}

module.exports = { TIMESTAMP_URL, electronBuilderSign, isPortableExecutable, probeToken, signTree, verifySigned };
