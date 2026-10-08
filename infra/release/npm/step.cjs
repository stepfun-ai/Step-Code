#!/usr/bin/env node
"use strict";

// npm launcher for StepCode. The real program is the standalone `step` binary
// shipped in the platform package that npm selected through optionalDependencies
// (os/cpu filters). This file only locates that binary and runs it.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_PACKAGE = "@stepfun/stepcode";
const PLATFORM_PACKAGES = {
	"darwin-arm64": "@stepfun/stepcode-darwin-arm64",
	"darwin-x64": "@stepfun/stepcode-darwin-x64",
	"linux-arm64": "@stepfun/stepcode-linux-arm64",
	"linux-x64": "@stepfun/stepcode-linux-x64",
	"win32-arm64": "@stepfun/stepcode-win32-arm64",
	"win32-x64": "@stepfun/stepcode-win32-x64",
};
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function fail(message) {
	process.stderr.write(`step: ${message}\n`);
	process.exit(1);
}

function resolveBinary() {
	const target = `${process.platform}-${process.arch}`;
	const packageName = PLATFORM_PACKAGES[target];
	if (!packageName) {
		fail(
			`no prebuilt binary for ${target}. Supported: ${Object.keys(PLATFORM_PACKAGES).join(", ")}.\n` +
				"Use the standalone installer instead: https://static-openapi.stepfun.com/stepcode/install.sh",
		);
	}
	let manifestPath;
	try {
		manifestPath = require.resolve(`${packageName}/package.json`);
	} catch {
		fail(
			`the platform package ${packageName} is not installed.\n` +
				"It is an optional dependency; reinstall without --omit=optional / --no-optional:\n" +
				`  npm install -g ${MAIN_PACKAGE}`,
		);
	}
	const binary = path.join(path.dirname(manifestPath), "vendor", process.platform === "win32" ? "step.exe" : "step");
	if (!fs.existsSync(binary)) fail(`${packageName} is incomplete: ${binary} is missing. Reinstall ${MAIN_PACKAGE}.`);
	if (process.platform !== "win32") {
		try {
			fs.accessSync(binary, fs.constants.X_OK);
		} catch {
			// Some package managers drop the executable bit when extracting tarballs.
			try {
				fs.chmodSync(binary, 0o755);
			} catch {
				fail(`${binary} is not executable. Run: chmod +x "${binary}"`);
			}
		}
	}
	return binary;
}

const binary = resolveBinary();
const child = spawn(binary, process.argv.slice(2), {
	stdio: "inherit",
	env: { ...process.env, STEPCODE_INSTALL_METHOD: "npm" },
	windowsHide: false,
});

const forwarders = new Map();
for (const signal of FORWARDED_SIGNALS) {
	const forward = () => {
		if (!child.killed) child.kill(signal);
	};
	forwarders.set(signal, forward);
	process.on(signal, forward);
}

child.on("error", (error) => fail(`failed to start ${binary}: ${error.message}`));
child.on("exit", (code, signal) => {
	for (const [name, forward] of forwarders) process.off(name, forward);
	if (signal) {
		// Re-raise so the parent shell observes the same termination signal.
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
