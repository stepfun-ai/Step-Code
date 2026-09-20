#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const LOCKFILE = "pnpm-lock.yaml";

const allowValue = process.env.STEP_ALLOW_LOCKFILE_CHANGE;
const allowed = allowValue === "1" || allowValue === "true" || allowValue === "yes";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

if (!stagedFiles.includes(LOCKFILE)) {
	process.exit(0);
}

if (allowed) {
	console.error(`${LOCKFILE} is staged; STEP_ALLOW_LOCKFILE_CHANGE is set, allowing commit.`);
	process.exit(0);
}

console.error(`${LOCKFILE} is staged.`);
console.error("");
console.error("Review lockfile changes before committing:");
console.error("  - confirm every new/updated package is intentional");
console.error("  - confirm npm age gates were active for resolution");
console.error("  - review any new lifecycle scripts in the dependency tree");
console.error("  - regenerate the lockfile with `pnpm install --lockfile-only` if only metadata drifted");
console.error("");
console.error("If this lockfile change is intentional, commit with:");
console.error("  STEP_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
