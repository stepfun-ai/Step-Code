import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderInstallTemplate } from "../infra/release/release-bundle.mjs";

const ps1Path = fileURLToPath(new URL("../infra/release/install.ps1", import.meta.url));
const shPath = fileURLToPath(new URL("../infra/release/install.sh", import.meta.url));

// A base URL that is obviously not the placeholder. Kept off any real host so an
// accidental network attempt during the execution tests below fails fast.
const BASE_URL = "https://releases.example.test/stepcode";

// Assembled from two literals so this test file cannot itself be rewritten by the
// same token replacement it is guarding against.
const PLACEHOLDER = "__STEP_RELEASE" + "_BASE_URL__";

function commandAvailable(command, ...args) {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return !result.error;
}

// The execution tests below run the *shipped, unrendered* templates to prove the
// not-configured guard trips. Any `STEP_*` override in the ambient environment
// (CI sets STEP_RELEASE_BASE_URL globally) would supply a real base URL and skip
// the guard, so strip those overrides to reproduce a clean end-user install.
function unconfiguredEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("STEP_")) {
			delete env[key];
		}
	}
	return env;
}

test("install templates embed the base-URL placeholder exactly once (the definition)", async () => {
	for (const scriptPath of [ps1Path, shPath]) {
		const source = await readFile(scriptPath, "utf8");
		const occurrences = source.split(PLACEHOLDER).length - 1;
		assert.equal(
			occurrences,
			1,
			`${scriptPath}: the raw placeholder must appear exactly once (the BASE_URL definition). ` +
				"A second occurrence means a guard or comment was written with the literal token and " +
				"would be clobbered by renderInstallTemplate.",
		);
	}
});

test("renderInstallTemplate substitutes the definition without leaving a raw placeholder", async () => {
	for (const scriptPath of [ps1Path, shPath]) {
		const rendered = renderInstallTemplate(await readFile(scriptPath, "utf8"), BASE_URL);
		assert.ok(rendered.includes(BASE_URL), `${scriptPath}: BASE_URL definition should be substituted`);
		assert.ok(!rendered.includes(PLACEHOLDER), `${scriptPath}: no raw placeholder should survive rendering`);
	}
});

test("rendering does not clobber the not-configured guard (ps1)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// The sentinel must survive as a split literal so the renderer cannot rewrite it.
	assert.ok(
		rendered.includes("'__STEP_RELEASE' + '_BASE_URL__'"),
		"ps1 guard must keep its split-literal sentinel intact after rendering",
	);
	// The guard must never end up comparing the base URL against itself (the original bug).
	assert.ok(
		!rendered.includes(`-eq '${BASE_URL}'`) && !rendered.includes(`-match '${BASE_URL}'`),
		"ps1 guard must not be rewritten to compare against the real base URL",
	);
});

test("rendering does not clobber the not-configured guard (sh)", async () => {
	const rendered = renderInstallTemplate(await readFile(shPath, "utf8"), BASE_URL);
	assert.ok(
		rendered.includes("'__STEP_RELEASE''_BASE_URL__'"),
		"sh guard must keep its split-literal sentinel intact after rendering",
	);
	assert.ok(
		!rendered.includes(`unconfigured_base_url='${BASE_URL}'`),
		"sh guard must not be rewritten to compare against the real base URL",
	);
});

test(
	"unrendered install.sh fails fast with the not-configured error",
	{ skip: commandAvailable("bash", "--version") ? false : "bash unavailable" },
	() => {
		// Running the shipped (unsubstituted) template must trip the guard before any
		// network access, exiting non-zero with the documented message.
		const result = spawnSync("bash", [shPath], { encoding: "utf8", env: unconfiguredEnv() });
		assert.notEqual(result.status, 0, "unrendered install.sh should exit non-zero");
		assert.match(result.stderr, /release base URL was not configured/);
	},
);

test(
	"unrendered install.ps1 fails fast with the not-configured error",
	{ skip: commandAvailable("powershell", "-Help") || commandAvailable("pwsh", "--version") ? false : "powershell unavailable" },
	() => {
		const shell = commandAvailable("powershell", "-Help") ? "powershell" : "pwsh";
		const result = spawnSync(
			shell,
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
			{ encoding: "utf8", env: unconfiguredEnv() },
		);
		assert.notEqual(result.status, 0, "unrendered install.ps1 should exit non-zero");
		assert.match(`${result.stdout}${result.stderr}`, /release base URL was not configured/);
	},
);

// ---------------------------------------------------------------------------
// PATH-persistence coverage (2026-09-09-installer-path-persistence.md).
//
// These target the release scripts directly. step-local-update.test.ts mocks
// installUpdate, so the real installer never runs there — the persistence logic
// added to install.ps1 / install.sh has no other coverage.
//
// CI runs on Linux and cannot execute PowerShell, so the install.ps1 checks are
// STATIC assertions on the rendered script's structure (addendum 7). Anything
// that actually executes a shell is gated behind commandAvailable(), mirroring
// the base-URL execution tests above.
// ---------------------------------------------------------------------------

// Drop whole-line PowerShell comments so "does not call X" assertions cannot be
// fooled by X merely being named in an explanatory comment (the install.ps1
// block documents *why* it avoids setx / SetEnvironmentVariable).
function stripPowerShellLineComments(source) {
	return source
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

test("install.ps1 persists PATH via HKCU\\Environment with DoNotExpandEnvironmentNames + ExpandString (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	assert.ok(
		rendered.includes("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)"),
		"must open HKCU\\Environment writable",
	);
	assert.ok(
		rendered.includes("CreateSubKey('Environment')"),
		"must create the Environment subkey when a pristine profile lacks it",
	);
	assert.ok(
		rendered.includes("GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)"),
		"must read Path un-expanded (DoNotExpandEnvironmentNames)",
	);
	assert.ok(
		rendered.includes("[Microsoft.Win32.RegistryValueKind]::ExpandString"),
		"must write Path back as ExpandString so %VAR% entries survive",
	);
});

test("install.ps1 does not persist PATH via setx or SetEnvironmentVariable (static)", async () => {
	const code = stripPowerShellLineComments(renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL));
	assert.ok(
		!/\bSetEnvironmentVariable\b/.test(code),
		"must not call SetEnvironmentVariable (flattens REG_EXPAND_SZ %VAR% entries to REG_SZ)",
	);
	assert.ok(!/\bsetx\b/.test(code), "must not call setx (truncates PATH at 1024 chars)");
});

test("install.ps1 updates the session PATH and broadcasts WM_SETTINGCHANGE (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// Session update appends (addendum 8) so a pre-existing system `step` is not shadowed.
	assert.ok(
		rendered.includes("$env:PATH = ($env:PATH.TrimEnd(';') + ';' + ($missing -join ';'))"),
		"must append the missing dirs to the current session $env:PATH",
	);
	assert.ok(rendered.includes("Send-EnvironmentChangeBroadcast"), "must invoke the broadcast helper");
	assert.ok(rendered.includes("SendMessageTimeout"), "broadcast must use SendMessageTimeout P/Invoke");
	assert.ok(rendered.includes("WM_SETTINGCHANGE") && rendered.includes("0x001A"), "broadcast must send WM_SETTINGCHANGE");
	assert.ok(rendered.includes("HWND_BROADCAST"), "broadcast must target HWND_BROADCAST");
});

test("install.ps1 guards the registry write and session update on missing entries (idempotency, static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// Missing dirs computed by the extracted helper; both the write and the
	// session update sit inside a single `if ($missing.Count -gt 0)` so a re-run
	// with nothing missing appends nothing (addendum 2).
	assert.ok(
		rendered.includes("Get-MissingPathEntries -PathValue $currentPath -Candidates $candidates"),
		"must compute missing entries via the testable helper",
	);
	assert.ok(rendered.includes("if ($missing.Count -gt 0)"), "must guard persistence on missing being non-empty");
	// The helper compares EXPANDED paths, case-insensitively, trailing-\ trimmed
	// (addendum 1) so a literal candidate matches an existing %VAR% entry.
	assert.match(
		rendered,
		/\[Environment\]::ExpandEnvironmentVariables\(\$entry\)\.TrimEnd\('\\'\)\.ToLowerInvariant\(\)/,
		"existing entries must be expanded + normalized for comparison only",
	);
	assert.match(
		rendered,
		/\[Environment\]::ExpandEnvironmentVariables\(\$candidate\)\.TrimEnd\('\\'\)\.ToLowerInvariant\(\)/,
		"candidates must be expanded + normalized the same way",
	);
});

test("install.ps1 preserves %VAR% entries un-expanded across the round-trip (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// Read un-expanded, and write back a value derived from the un-expanded
	// $currentPath so an existing %SOMEVAR%\bin survives as-is.
	assert.ok(rendered.includes("DoNotExpandEnvironmentNames"), "read must be un-expanded");
	assert.ok(
		rendered.includes("$trimmed = $currentPath.TrimEnd(';')") &&
			rendered.includes("$key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)"),
		"write must be the original un-expanded PATH plus new dirs, as ExpandString",
	);
	// The helper returns original (un-expanded) candidate strings, never the expanded form.
	assert.ok(rendered.includes("$missing += $candidate"), "helper must append the original candidate string");
});

test("install.ps1 avoids ';;' and leading ';' for malformed User PATH (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// null coalesced before any string method (StrictMode), trailing ';' trimmed,
	// and an empty base skips the separator entirely.
	assert.ok(rendered.includes("if ($null -eq $PathValue) { $PathValue = '' }"), "helper must null-coalesce PathValue");
	assert.ok(
		rendered.includes("$newPath = if ($trimmed) { $trimmed + ';' + ($missing -join ';') } else { $missing -join ';' }"),
		"join must skip the ';' separator when the existing PATH is empty (no leading ';')",
	);
});

test("install.ps1 persists the resolved $InstallDir/$AgentDir, honoring STEP_INSTALL_DIR (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(ps1Path, "utf8"), BASE_URL);
	// $InstallDir resolves from STEP_INSTALL_DIR when set; persistence uses that
	// variable (and $AgentDir\bin), never a hardcoded default (addendum 5).
	assert.ok(rendered.includes("$env:STEP_INSTALL_DIR"), "InstallDir must be resolvable from STEP_INSTALL_DIR");
	assert.ok(rendered.includes("$managedBin = Join-Path $AgentDir 'bin'"), "managed bin derives from $AgentDir");
	assert.ok(
		rendered.includes("$candidates = @($InstallDir, $managedBin)"),
		"PATH candidates must be the resolved variables, not hardcoded paths",
	);
});

test("install.sh persists PATH via a guarded, env-var-honoring # stepcode block (static)", async () => {
	const rendered = renderInstallTemplate(await readFile(shPath, "utf8"), BASE_URL);
	assert.ok(rendered.includes("# stepcode"), "must use the # stepcode marker block");
	assert.ok(rendered.includes("# stepcode end"), "marker block must be terminated");
	assert.ok(
		rendered.includes("grep -qxF '# stepcode'"),
		"must grep for the marker before rewriting the block (idempotent)",
	);
	assert.ok(
		rendered.includes('case ":$PATH:" in'),
		"written block must self-guard so sourcing it twice does not double-prepend",
	);
	assert.ok(
		rendered.includes('export PATH="%s:%s/bin:$PATH"'),
		"export must use the resolved INSTALL_DIR/AGENT_DIR (honors STEP_INSTALL_DIR/STEP_CODING_AGENT_DIR)",
	);
	assert.ok(rendered.includes('fish_add_path "%s" "%s/bin"'), "fish must be configured via fish_add_path");
	assert.ok(rendered.includes("STEP_NO_MODIFY_PATH"), "must honor the STEP_NO_MODIFY_PATH opt-out");
	assert.ok(rendered.includes("configure_shell_path"), "main must call configure_shell_path");
});

const powershellShell = commandAvailable("pwsh", "--version")
	? "pwsh"
	: commandAvailable("powershell", "-Help")
		? "powershell"
		: null;

test(
	"Get-MissingPathEntries is idempotent, null-safe, and normalizes case/trailing-backslash (pwsh)",
	{ skip: powershellShell ? false : "powershell/pwsh unavailable" },
	async () => {
		const source = await readFile(ps1Path, "utf8");
		const match = source.match(/function Get-MissingPathEntries \{[\s\S]*?\n\}/);
		assert.ok(match, "must be able to extract the Get-MissingPathEntries helper from install.ps1");

		// Exercises the helper's own comparison logic across the four plan scenarios.
		// The result is captured into a variable first (the correct way to consume a
		// `return ,$array`) so this isolates the comparison math from the caller's
		// array handling.
		// A: an existing %VAR% entry must match its expanded literal candidate → nothing missing.
		// B: a $null PATH must not throw and yields every candidate.
		// C: case + trailing-backslash differences must still match.
		// D: a partial match returns exactly the genuinely-missing dir.
		const harness = String.raw`
function CountAndJoin($pathValue, $cands) {
  $r = Get-MissingPathEntries -PathValue $pathValue -Candidates $cands
  $arr = @($r)
  return ('' + $arr.Count + '#' + ($arr -join '|'))
}
$var = [Environment]::ExpandEnvironmentVariables('%USERPROFILE%\.stepcode\bin')
$out = [ordered]@{
  a = (CountAndJoin '%USERPROFILE%\.stepcode\bin' @($var))
  b = (CountAndJoin $null @('C:\x\bin','C:\y\bin'))
  c = (CountAndJoin 'C:\FOO\BIN\' @('c:\foo\bin'))
  d = (CountAndJoin 'C:\other;C:\keep\bin' @('C:\keep\bin','C:\new\bin'))
}
$out | ConvertTo-Json -Compress
`;
		const dir = await mkdtemp(join(tmpdir(), "step-ps1-helper-"));
		const scriptPath = join(dir, "helper-test.ps1");
		try {
			await writeFile(scriptPath, `${match[0]}\n${harness}`, "utf8");
			const result = spawnSync(
				powershellShell,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 0, `helper harness should exit 0: ${result.stderr}`);
			const json = JSON.parse(result.stdout.trim().match(/\{.*\}/s)[0]);
			assert.equal(json.a, "0#", "A: %VAR% entry matching its expanded candidate must not be re-appended");
			assert.equal(json.b, "2#C:\\x\\bin|C:\\y\\bin", "B: a null PATH is null-safe and returns every candidate");
			assert.equal(json.c, "0#", "C: case + trailing-backslash differences must still match");
			assert.equal(json.d, "1#C:\\new\\bin", "D: only the genuinely-missing dir is returned");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"install.ps1 Write-Result joins missing dirs onto PATH without array-nesting corruption (pwsh)",
	{ skip: powershellShell ? false : "powershell/pwsh unavailable" },
	async () => {
		const source = await readFile(ps1Path, "utf8");
		const match = source.match(/function Get-MissingPathEntries \{[\s\S]*?\n\}/);
		assert.ok(match, "must be able to extract the Get-MissingPathEntries helper from install.ps1");

		// Reproduces Write-Result's EXACT consumption of the helper (the `$missing =
		// @(Get-MissingPathEntries ...)` assignment and the `$newPath` join, copied
		// verbatim from install.ps1) for a fresh install where PATH has neither dir.
		// The resolved PATH must end with the two literal dirs — never the string
		// 'System.Object[]' that results if the helper's return value is nested.
		const harness = String.raw`
$currentPath = 'C:\Windows;C:\Windows\System32'
$candidates = @('C:\Users\me\.stepcode\bin', 'C:\Users\me\.stepcode\agent\bin')
$missing = @(Get-MissingPathEntries -PathValue $currentPath -Candidates $candidates)
$trimmed = $currentPath.TrimEnd(';')
$newPath = if ($trimmed) { $trimmed + ';' + ($missing -join ';') } else { $missing -join ';' }
$newPath
`;
		const dir = await mkdtemp(join(tmpdir(), "step-ps1-writeresult-"));
		const scriptPath = join(dir, "writeresult-test.ps1");
		try {
			await writeFile(scriptPath, `${match[0]}\n${harness}`, "utf8");
			const result = spawnSync(
				powershellShell,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 0, `write-result harness should exit 0: ${result.stderr}`);
			const newPath = result.stdout.trim();
			assert.ok(
				!newPath.includes("System.Object[]"),
				`resolved PATH must not contain a stringified nested array (got: ${newPath})`,
			);
			assert.equal(
				newPath,
				"C:\\Windows;C:\\Windows\\System32;C:\\Users\\me\\.stepcode\\bin;C:\\Users\\me\\.stepcode\\agent\\bin",
				"fresh-install PATH must append both literal dirs",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"strip_step_block is idempotent and never truncates on an unterminated marker (bash)",
	{ skip: commandAvailable("bash", "--version") ? false : "bash unavailable" },
	async () => {
		const source = await readFile(shPath, "utf8");
		const match = source.match(/strip_step_block\(\) \{[\s\S]*?\n\}/);
		assert.ok(match, "must be able to extract strip_step_block from install.sh");

		const dir = await mkdtemp(join(tmpdir(), "step-sh-helper-"));
		const rcWell = join(dir, "rc-well").replace(/\\/g, "/");
		const rcUnterm = join(dir, "rc-unterm").replace(/\\/g, "/");
		const scriptPath = join(dir, "helper-test.sh");
		try {
			// A well-formed "# stepcode ... # stepcode end" block (and the blank line
			// above it) must be removed while surrounding lines survive; a LONE start
			// marker with no end must be preserved verbatim rather than truncating the
			// rest of the rc to EOF (the reviewed data-loss guard).
			const harness = String.raw`
set -euo pipefail
${match[0]}
printf 'keep1\n\n# stepcode\nexport PATH=x\n# stepcode end\nkeep2\n' > "$1"
strip_step_block "$1"
printf '# stepcode\nexport IMPORTANT=keepme\nalias a=b\n' > "$2"
strip_step_block "$2"
printf 'WELL:%s\n' "$(tr '\n' '|' < "$1")"
printf 'UNTERM_KEEP:%s\n' "$(grep -c 'IMPORTANT=keepme' "$2")"
`;
			await writeFile(scriptPath, harness, "utf8");
			const result = spawnSync("bash", [scriptPath, rcWell, rcUnterm], { encoding: "utf8" });
			assert.equal(result.status, 0, `strip_step_block harness should exit 0: ${result.stderr}`);
			assert.match(
				result.stdout,
				/WELL:keep1\|keep2\|/,
				"well-formed block and its preceding blank must be stripped, surrounding lines intact",
			);
			assert.match(
				result.stdout,
				/UNTERM_KEEP:1/,
				"an unterminated # stepcode marker must not truncate user content below it",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
