#!/usr/bin/env node

// S0-4 workspace registry check.
//
// Guards the "workspace 登记表" invariant so no package silently joins (or leaves) the
// build/test/dependency graph, and so new packages adopt the @step-harness/* scope.
//
//   1 (HARD) dual-track glob parity: the workspace globs in package.json "workspaces"
//     must exactly equal the globs in pnpm-workspace.yaml "packages:".
//   2 disk <-> registry parity: every on-disk package.json under the globs must have a
//     registry row (matched by package name), and every registry row must exist on disk.
//   3 scope rule: a member that is neither grandfathered (baseline @earendil-works/pi-*)
//     nor an example must use the @step-harness/* scope.
//
// Run:  node scripts/check-workspace-registry.mjs            (scan the real repo; exit 1 on violation)
//       node scripts/check-workspace-registry.mjs --self-test (synthetic inputs; exit 1 if the checker misbehaves)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const registryPath = join(scriptDirectory, "workspace-registry.json");
const skippedDirectories = new Set(["node_modules", "dist", ".git"]);

// --- pure helpers (fed synthetic data by --self-test) --------------------------------

function parseWorkspaceGlobs(packageJsonText) {
	const parsed = JSON.parse(packageJsonText);
	return Array.isArray(parsed.workspaces) ? parsed.workspaces.slice() : [];
}

// Minimal, dependency-free reader for the flat `packages:` list at the top of
// pnpm-workspace.yaml. Stops at the first line that is not a `  - "..."` list item.
function parsePnpmPackages(pnpmYamlText) {
	const globs = [];
	let inPackages = false;
	for (const rawLine of pnpmYamlText.split(/\r?\n/)) {
		if (/^packages:\s*$/.test(rawLine)) {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		const match = rawLine.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
		if (match) {
			globs.push(match[1]);
			continue;
		}
		if (rawLine.trim() === "") continue; // tolerate blank lines inside the list
		break; // a non-list, non-blank line (e.g. `allowBuilds:`) ends the section
	}
	return globs;
}

function diffSets(a, b) {
	const setB = new Set(b);
	const setA = new Set(a);
	return {
		onlyA: a.filter((x) => !setB.has(x)),
		onlyB: b.filter((x) => !setA.has(x)),
	};
}

function classifyMember(name, registry) {
	if (registry.baseline.includes(name)) return "baseline";
	const row = registry.members.find((m) => m.name === name);
	if (row && row.role === "example") return "example";
	if (name.startsWith(registry.requiredScope)) return "new-ok";
	return "bad-scope";
}

// Core validator. Inputs are plain data so the self-test can exercise every branch.
function validate({ workspaceGlobs, pnpmGlobs, diskMembers, registry }) {
	const violations = [];

	// 1 — dual-track glob parity (hard).
	const { onlyA, onlyB } = diffSets(workspaceGlobs, pnpmGlobs);
	for (const glob of onlyA) violations.push(`glob "${glob}" is in package.json workspaces but missing from pnpm-workspace.yaml`);
	for (const glob of onlyB) violations.push(`glob "${glob}" is in pnpm-workspace.yaml but missing from package.json workspaces`);

	// 2 — disk <-> registry parity (matched by package name).
	const registryNames = new Set(registry.members.map((m) => m.name));
	const diskNames = new Set(diskMembers.map((m) => m.name));
	for (const member of diskMembers) {
		if (!registryNames.has(member.name)) {
			violations.push(`workspace package "${member.name}" (${member.dir}) is on disk but not registered in workspace-registry.json`);
		}
	}
	for (const row of registry.members) {
		if (!diskNames.has(row.name)) {
			violations.push(`registry entry "${row.name}" (${row.dir}) has no matching package.json on disk`);
		}
	}

	// 3 — scope rule for members present on disk.
	for (const member of diskMembers) {
		if (classifyMember(member.name, registry) === "bad-scope") {
			violations.push(`package "${member.name}" (${member.dir}) must use the ${registry.requiredScope}* scope (only baseline @earendil-works/pi-* and examples are exempt)`);
		}
	}

	return violations;
}

// --- real filesystem scan ------------------------------------------------------------

function scanDiskMembers(globs) {
	const seen = new Set();
	const members = [];
	const addIfPackage = (relativeDir) => {
		const manifestPath = join(repoRoot, relativeDir, "package.json");
		if (seen.has(relativeDir) || !existsSync(manifestPath)) return;
		seen.add(relativeDir);
		const name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
		members.push({ name, dir: relativeDir });
	};

	for (const glob of globs) {
		if (glob.endsWith("/*")) {
			const parent = glob.slice(0, -2);
			const parentPath = join(repoRoot, parent);
			if (!existsSync(parentPath)) continue;
			for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
				if (entry.isDirectory() && !skippedDirectories.has(entry.name)) addIfPackage(join(parent, entry.name));
			}
		} else {
			addIfPackage(glob);
		}
	}
	return members;
}

function runReal() {
	const registry = JSON.parse(readFileSync(registryPath, "utf8"));
	const workspaceGlobs = parseWorkspaceGlobs(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const pnpmGlobs = parsePnpmPackages(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
	const diskMembers = scanDiskMembers([...new Set([...workspaceGlobs, ...pnpmGlobs])]);
	const violations = validate({ workspaceGlobs, pnpmGlobs, diskMembers, registry });

	if (violations.length > 0) {
		console.error("workspace registry check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log(`workspace registry check passed (${diskMembers.length} members).`);
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const registry = {
		grandfatheredScope: "@earendil-works/pi-",
		requiredScope: "@step-harness/",
		baseline: ["@step-harness/providers"],
		members: [
			{ name: "@step-harness/providers", dir: "packages/providers", role: "engine" },
			{ name: "@step-harness/cli", dir: "apps/cli", role: "app" },
			{ name: "pi-extension-sandbox", dir: "packages/coding-agent/examples/extensions/sandbox", role: "example" },
		],
	};
	const failures = [];
	const expect = (label, condition) => {
		if (!condition) failures.push(label);
	};

	// Clean baseline: parity + all registered + good scopes -> no violations.
	const clean = validate({
		workspaceGlobs: ["apps/*", "packages/*"],
		pnpmGlobs: ["apps/*", "packages/*"],
		diskMembers: [
			{ name: "@step-harness/providers", dir: "packages/providers" },
			{ name: "@step-harness/cli", dir: "apps/cli" },
			{ name: "pi-extension-sandbox", dir: "packages/coding-agent/examples/extensions/sandbox" },
		],
		registry,
	});
	expect("clean inputs should yield zero violations", clean.length === 0);

	// 1 — glob drift is caught in both directions.
	const drift = validate({ workspaceGlobs: ["apps/*", "packages/*"], pnpmGlobs: ["apps/*"], diskMembers: [], registry });
	expect("glob drift should be flagged", drift.some((v) => v.includes("pnpm-workspace.yaml")));

	// 2 — unregistered on-disk package, and registry row missing on disk.
	const unregistered = validate({
		workspaceGlobs: [], pnpmGlobs: [],
		diskMembers: [{ name: "@step-harness/ghost", dir: "packages/ghost" }],
		registry,
	});
	expect("unregistered disk package should be flagged", unregistered.some((v) => v.includes("@step-harness/ghost")));
	expect("registry-only entry should be flagged", unregistered.some((v) => v.includes("@step-harness/cli") && v.includes("no matching package.json")));

	// 3 — new package on the wrong scope.
	const badScope = validate({
		workspaceGlobs: [], pnpmGlobs: [],
		diskMembers: [{ name: "@acme/tools", dir: "packages/tools" }],
		registry: { ...registry, members: [...registry.members, { name: "@acme/tools", dir: "packages/tools", role: "engine" }] },
	});
	expect("wrong-scope new package should be flagged", badScope.some((v) => v.includes("@acme/tools") && v.includes("scope")));

	if (failures.length > 0) {
		console.error("workspace registry self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("workspace registry self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
