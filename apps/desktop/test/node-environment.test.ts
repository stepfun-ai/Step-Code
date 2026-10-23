import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { addBundledNodeToPath } from "../src/node-environment.ts";
import { launchWebServer } from "../src/server-host.ts";

const execFileAsync = promisify(execFile);
const posix = { skip: process.platform === "win32" };

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "stepcode-desktop-node-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "profile with 'quotes'", "node-bin");
	const bin = join(root, "node-free-bin");
	await mkdir(bin);
	const environment: NodeJS.ProcessEnv = { HOME: root, PATH: bin };
	const node = { command: process.execPath, electron: true };
	return { root, directory, bin, environment, node };
}

test("the private node works with a restricted MCP child environment", posix, async (t) => {
	const f = await fixture(t);
	await assert.rejects(execFileAsync("node", ["--version"], { env: f.environment, timeout: 5_000 }), {
		code: "ENOENT",
	});
	const environment = await addBundledNodeToPath(f);
	assert.equal(f.environment.PATH, f.bin);
	assert.equal(environment.PATH, `${f.bin}${delimiter}${f.directory}`);
	assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
	assert.equal((await stat(join(f.directory, "node"))).mode & 0o777, 0o700);

	const probe = join(f.root, "probe with 'quotes'.mjs");
	await writeFile(
		probe,
		'console.log(JSON.stringify({ version: process.version, mode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }));',
	);
	const args = ["two words", "'quoted'", "$HOME", "--flag"];
	const result = await execFileAsync("node", [probe, ...args], { env: environment, timeout: 5_000 });
	assert.deepEqual(JSON.parse(result.stdout), { version: process.version, mode: "1", args });
	// The MCP resolver need not expose Electron's flag; the wrapper owns it.
	assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
});

test("a system node retains precedence over the bundled fallback", posix, async (t) => {
	const f = await fixture(t);
	const system = join(f.root, "system-bin");
	await mkdir(system);
	await writeFile(join(system, "node"), '#!/bin/sh\nprintf "system-node\\n"\n');
	await chmod(join(system, "node"), 0o700);
	f.environment.PATH = `${system}${delimiter}${f.bin}`;
	const environment = await addBundledNodeToPath(f);
	const result = await execFileAsync("node", ["--version"], { env: environment, timeout: 5_000 });
	assert.equal(result.stdout.trim(), "system-node");
});

test("restart refreshes a moved Electron path without duplicating PATH entries", posix, async (t) => {
	const f = await fixture(t);
	const first = await addBundledNodeToPath({
		...f,
		node: { command: "/missing/old-electron", electron: true },
	});
	const moved = join(f.root, "moved app with 'quotes'", "Electron");
	await mkdir(join(f.root, "moved app with 'quotes'"));
	await writeFile(moved, `#!/bin/sh\nexec '${process.execPath.replace(/'/gu, "'\\''")}' "$@"\n`);
	await chmod(moved, 0o700);
	const second = await addBundledNodeToPath({
		...f,
		environment: first,
		node: { command: moved, electron: true },
	});
	assert.equal(first.PATH, second.PATH);
	const result = await execFileAsync("node", ["--version"], { env: second, timeout: 5_000 });
	assert.equal(result.stdout.trim(), process.version);
	assert.ok((await readFile(join(f.directory, "node"), "utf8")).includes("moved app"));
});

test("explicit Node overrides and Windows keep the inherited environment", async (t) => {
	const f = await fixture(t);
	assert.equal(await addBundledNodeToPath({ ...f, node: { ...f.node, electron: false } }), f.environment);
	assert.equal(await addBundledNodeToPath({ ...f, platform: "win32" }), f.environment);
	await assert.rejects(stat(f.directory), { code: "ENOENT" });
});

test("a failed wrapper write leaves the inherited environment unchanged", posix, async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "not-a-directory"), "keep");
	await assert.rejects(
		addBundledNodeToPath({ ...f, directory: join(f.root, "not-a-directory", "node-bin") }),
	);
	assert.deepEqual(f.environment, { HOME: f.root, PATH: f.bin });
});

test("the hosted server can spawn node even when the GUI PATH has none", posix, async (t) => {
	const f = await fixture(t);
	const environment = await addBundledNodeToPath(f);
	const entry = join(f.root, "server.mjs");
	await writeFile(
		entry,
		`import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const env = { HOME: process.env.HOME, PATH: process.env.PATH };
const result = execFileSync("node", ["--version"], { env, encoding: "utf8" });
writeFileSync(process.env.HOME + "/child-version", result.trim());
console.log("Local: http://127.0.0.1:" + process.env.STEPCODE_WEB_PORT + "/#token=fixture");
setInterval(() => {}, 1000);
`,
	);
	const server = await launchWebServer({
		entry,
		node: f.node,
		workspace: f.root,
		environment,
		logPath: join(f.root, "server.log"),
	});
	t.after(() => server.stop());
	assert.equal(await readFile(join(f.root, "child-version"), "utf8"), process.version);
	await server.stop();
	assert.equal((await server.exited).requested, true);
	assert.ok(!(await readFile(join(f.root, "server.log"), "utf8")).includes("#token=fixture"));
});
