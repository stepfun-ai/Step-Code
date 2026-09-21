import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentStepInvocation } from "../../src/features/subagent/helpers.ts";

// Exercise the production child invocation while the parent is running through
// the same tsx launcher as step-test.sh. The child runs the real CLI entry.
const args = process.argv.slice(2);
process.argv[1] = fileURLToPath(new URL("../../../../apps/cli/src/main.ts", import.meta.url));
const invocation = currentStepInvocation(args);
const child = spawnSync(invocation.command, invocation.args, {
	cwd: process.cwd(),
	env: process.env,
	encoding: "utf8",
	timeout: 20_000,
});
if (child.error) throw child.error;
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exitCode = child.status ?? 1;
