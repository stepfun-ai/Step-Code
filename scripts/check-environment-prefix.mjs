import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const retiredPrefix = /\bPI_[A-Z0-9_*]+/;

if (process.argv.includes("--self-test")) {
	const cases = [
		['process.env.PI_CODING_AGENT_DIR', true],
		['env["PI_CACHE_RETENTION"]', true],
		['process.env.STEP_API_KEY', false],
		['process.env.STEP_CODING_AGENT_DIR', false],
	];
	for (const [source, expected] of cases) {
		if (retiredPrefix.test(source) !== expected) throw new Error(`Unexpected prefix classification: ${source}`);
	}
	console.log("environment-prefix self-test passed.");
} else {
	const failures = [];
	function scan(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) scan(path);
			else if (entry.isFile() && /\.(?:ts|md)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
				const lines = readFileSync(path, "utf8").split("\n");
				for (let index = 0; index < lines.length; index++) {
					if (retiredPrefix.test(lines[index])) failures.push(`${path}:${index + 1}`);
				}
			}
		}
	}
	for (const entry of readdirSync("packages", { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packagePath = join("packages", entry.name);
		if (readdirSync(packagePath).includes("src")) scan(join(packagePath, "src"));
	}
	scan("apps/cli/src");
	scan("packages/coding-agent/docs");
	if (failures.length > 0) {
		console.error(`Retired environment prefixes in product source or documentation:\n${failures.join("\n")}`);
		process.exitCode = 1;
	} else {
		console.log("environment-prefix check passed.");
	}
}
