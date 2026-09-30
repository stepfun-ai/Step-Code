import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, directory, outputMode] = process.argv.slice(2);

function identity(pid) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return { pid, startTime: fields[19] };
}

if (mode === "signal") {
	process.stdout.write("test-runner-started\n", () => process.kill(process.pid, outputMode));
} else if (mode === "child") {
	process.stdout.on("error", () => {});
	const interval = setInterval(() => {
		appendFileSync(join(directory, "heartbeat"), "tick\n");
		if (outputMode === "stream") process.stdout.write("descendant-diagnostic\n");
	}, 20);
	// Independent self-exit bound survives an interrupted or failing test runner.
	setTimeout(() => {
		clearInterval(interval);
		process.exit(0);
	}, 8_000);
} else {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", directory, outputMode], {
		detached: true,
		stdio: outputMode === "stream" ? ["ignore", "inherit", "ignore"] : "ignore",
	});
	child.once("spawn", () => {
		writeFileSync(join(directory, "owned-pids.json"), JSON.stringify({ parent: identity(process.pid), child: identity(child.pid) }));
		process.stdout.write("owned-child-ready\n");
	});
	setTimeout(() => {
		child.kill("SIGKILL");
		process.exit(0);
	}, 8_500);
}
