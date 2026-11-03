import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test.each([false, true])("passes the typed live-frame option (%s) to the child argv", async (includeLiveEvents) => {
		const client = new RpcClient({
			includeLiveEvents,
			cliPath: writeChildScript(`
import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true,
    data: { commands: process.argv.slice(2).map((name) => ({ name })) } }) + "\\n");
});
`),
		});
		try {
			await client.start();
			const commands = await client.getCommands();
			expect(commands.some((command) => command.name === "--include-live-events")).toBe(includeLiveEvents);
		} finally {
			await client.stop();
		}
	});

	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});
