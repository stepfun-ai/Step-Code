import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderInstallTemplate } from "../infra/release/release-bundle.mjs";

const ps1Path = fileURLToPath(new URL("../infra/release/install.ps1", import.meta.url));
const shPath = fileURLToPath(new URL("../infra/release/install.sh", import.meta.url));

// A base URL that is obviously not the placeholder. Kept off any real host so an
// accidental network attempt during the execution tests below fails fast.
const BASE_URL = "https://releases.example.test/step-cli";

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
