import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

const handlers = vi.hoisted(() => ({
	nodeVersion: "v24.0.0",
	nodeCalls: [] as string[],
	commandInterpreterCalls: [] as string[],
	commandInterpreterCommands: [] as string[],
	commandInterpreterCwds: [] as Array<string | undefined>,
	curlCalls: [] as string[],
	onCurl: undefined as undefined | ((args: readonly string[]) => void),
	commandExists: (_command: string): boolean => false,
}));

// steppage-provision.ts promisifies execFile, so the mock must publish the same
// promisify.custom contract the real child_process.execFile exposes.
vi.mock("node:child_process", async () => {
	const path = await import("node:path");
	const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
	const execFile = vi.fn();
	const custom = vi.fn((file: string, args: readonly string[] = [], options: { cwd?: string } = {}) => {
		return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
			const notFound = (command: string) => {
				const error: NodeJS.ErrnoException = new Error(`spawn ${command} ENOENT`);
				error.code = "ENOENT";
				return error;
			};
			if ((file === "node" || file.endsWith("node.exe")) && args[0] === "--version") {
				handlers.nodeCalls.push(file);
				resolve({ stdout: `${handlers.nodeVersion}\n`, stderr: "" });
			} else if ((file === "cmd" || file.endsWith("cmd.exe")) && args[0] === "/d" && args[1] === "/c") {
				handlers.commandInterpreterCalls.push(file);
				const command = args[2] ?? "";
				handlers.commandInterpreterCommands.push(command);
				handlers.commandInterpreterCwds.push(options.cwd);
				const resolvedCommand =
					path.isAbsolute(command) || !options.cwd ? command : path.resolve(options.cwd, command);
				if (!handlers.commandExists(resolvedCommand) || !resolvedCommand.endsWith(".cmd"))
					reject(notFound(command));
				else resolve({ stdout: "1.0.0\n", stderr: "" });
			} else if (file === "curl" || file.endsWith("curl.exe")) {
				handlers.curlCalls.push(file);
				Promise.resolve()
					.then(() => handlers.onCurl?.(args))
					.then(
						() => resolve({ stdout: "", stderr: "" }),
						(error) => reject(error instanceof Error ? error : new Error(String(error))),
					);
			} else {
				reject(notFound(`${file} ${args.join(" ")}`));
			}
		});
	});
	(execFile as unknown as Record<symbol, unknown>)[promisifyCustom] = custom;
	const spawn = vi.fn(() => {
		throw new Error("spawn must not run on the Windows provisioning path");
	});
	return { execFile, spawn };
});

vi.mock("proper-lockfile", () => ({
	default: {
		lock: vi.fn(async () => async () => undefined),
	},
}));

const {
	ensureStepPageReady,
	redactStepPageSecrets,
	renderStepPageWrapper,
	resolveNodeExecutable,
	stepPageBundleUrl,
	stepPageCommandCandidates,
} = await import("../src/step/steppage-provision.ts");

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	handlers.nodeVersion = "v24.0.0";
	handlers.nodeCalls = [];
	handlers.commandInterpreterCalls = [];
	handlers.commandInterpreterCommands = [];
	handlers.commandInterpreterCwds = [];
	handlers.curlCalls = [];
	handlers.onCurl = undefined;
	handlers.commandExists = () => false;
});

async function fixture(subdirectory = "") {
	const container = await mkdtemp(join(tmpdir(), "steppage-windows-"));
	const root = join(container, subdirectory);
	roots.push(container);
	await mkdir(join(root, "latest"), { recursive: true });
	await writeFile(join(root, "latest", "steppage-mcp.mjs"), "// fixture bundle\n");
	await mkdir(join(root, "bin"), { recursive: true });
	await writeFile(join(root, "bin", "node.exe"), "");
	await writeFile(join(root, "bin", "cmd.exe"), "");
	await writeFile(join(root, "bin", "curl.exe"), "");
	const env: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		PATH: join(root, "bin"),
		STEPCODE_STEPPAGE_INSTALLER_URL: pathToFileURL(join(root, "installer.sh")).href,
	};
	return {
		root,
		env,
		node: join(root, "bin", "node.exe"),
		cmd: join(root, "bin", "cmd.exe"),
		curl: join(root, "bin", "curl.exe"),
	};
}

function managedWrapper(root: string): string {
	return join(root, ".local", "bin", "steppage-mcp.cmd");
}

function managedBundle(root: string): string {
	return join(root, ".steppage-mcp", "bin", "steppage-mcp.mjs");
}

test("bundle url derives from the installer url", () => {
	expect(stepPageBundleUrl({})).toBe("https://dl.stepfun.com/steppage-mcp/p/latest/steppage-mcp.mjs");
	expect(stepPageBundleUrl({ STEPCODE_STEPPAGE_INSTALLER_URL: "https://mirror.example/steppage/install.sh" })).toBe(
		"https://mirror.example/steppage/latest/steppage-mcp.mjs",
	);
});

test("bundle URL preserves mirror authentication, encoding, and fragment", () => {
	expect(
		stepPageBundleUrl({
			STEPCODE_STEPPAGE_INSTALLER_URL:
				"https://user:pass@mirror.example/a%20b/install.sh?token=abc%2F123&channel=preview#download",
		}),
	).toBe("https://user:pass@mirror.example/a%20b/latest/steppage-mcp.mjs?token=abc%2F123&channel=preview#download");
});

test("windows probes the cmd wrapper", () => {
	const managed = join("/home/u", ".local", "bin", "steppage-mcp");
	expect(stepPageCommandCandidates("win32", "/home/u")).toEqual([`${managed}.cmd`]);
	expect(stepPageCommandCandidates("linux", "/home/u")).toEqual(["steppage-mcp", managed]);
});

test("windows resolves PATH candidates to absolute files and never the working directory", () => {
	const managed = join("/home/u", ".local", "bin", "steppage-mcp");
	const tools = join("/opt", "tools");
	const present = new Set([join(tools, "steppage-mcp.cmd"), join("bin", "steppage-mcp.cmd")]);
	const candidates = stepPageCommandCandidates("win32", "/home/u", `.;bin;;"${tools}";/missing`, (path) =>
		present.has(path),
	);
	expect(candidates).toEqual([join(tools, "steppage-mcp.cmd"), `${managed}.cmd`]);
	for (const candidate of candidates) expect(isAbsolute(candidate)).toBe(true);
});

test("windows never probes a bare command that cmd could find in the working directory", async () => {
	const f = await fixture();
	const probed: string[] = [];
	handlers.commandExists = (command) => {
		probed.push(command);
		return false;
	};
	handlers.onCurl = () => {
		throw new Error("offline");
	};
	await ensureStepPageReady({ env: { ...f.env, PATH: `.;${join(f.root, "bin")}` }, platform: "win32" });
	expect(probed.length).toBeGreaterThan(0);
	for (const command of probed) expect(isAbsolute(command)).toBe(true);
});

test("wrapper runs the bundle through the absolute node path", () => {
	const node = join("C:", "Program Files", "nodejs", "node.exe");
	const bundle = join("C:", "Users", "u", ".steppage-mcp", "bin", "steppage-mcp.mjs");
	expect(renderStepPageWrapper(node, bundle)).toBe(`@echo off\r\n"${node}" "${bundle}" %*\r\n`);
	expect(renderStepPageWrapper(join("C:", "100%", "node.exe"), bundle)).toContain(
		`"${join("C:", "100%%", "node.exe")}"`,
	);
});

test("windows resolves node.exe from absolute PATH entries only", () => {
	const nodejs = join("/opt", "nodejs");
	const present = new Set([join(".", "node.exe"), join("tools", "node.exe"), join(nodejs, "node.exe")]);
	const exists = (path: string) => present.has(path);
	expect(resolveNodeExecutable("win32", `.;tools;;"${nodejs}"`, exists)).toBe(join(nodejs, "node.exe"));
	expect(resolveNodeExecutable("win32", ".;tools", exists)).toBeUndefined();
	expect(resolveNodeExecutable("win32", undefined, exists)).toBeUndefined();
	expect(resolveNodeExecutable("linux", "/usr/bin", exists)).toBe("node");
});

test("windows fails closed when node.exe is not on an absolute PATH entry", async () => {
	const f = await fixture();
	await mkdir(join(f.root, "project"), { recursive: true });
	await writeFile(join(f.root, "project", "node.cmd"), "@echo NODE_HIJACKED_FROM_CWD\r\n");
	handlers.onCurl = () => {
		throw new Error("curl must not run without a resolved node.exe");
	};
	const result = await ensureStepPageReady({ env: { ...f.env, PATH: ".;project" }, platform: "win32" });
	expect(result.installed).toBe(false);
	expect(result.error).toContain("node.exe was not found on PATH");
	expect(handlers.nodeCalls).toEqual([]);
	expect(existsSync(managedWrapper(f.root))).toBe(false);
});

test("windows installs the published bundle and a cmd wrapper", async () => {
	const f = await fixture("home&%PATH%");
	handlers.commandExists = (command) => command.endsWith(".cmd") && existsSync(command);
	handlers.onCurl = (args) => {
		const url = args.find((arg) => arg.startsWith("file://"));
		const output = args[args.indexOf("-o") + 1];
		if (!url || !output) throw new Error(`unexpected curl args: ${args.join(" ")}`);
		return copyFile(fileURLToPath(url), output);
	};
	expect(await ensureStepPageReady({ env: f.env, platform: "win32" })).toEqual({
		command: managedWrapper(f.root),
		installed: true,
	});
	expect(await readFile(managedBundle(f.root), "utf8")).toBe("// fixture bundle\n");
	expect(await readFile(managedWrapper(f.root), "utf8")).toBe(renderStepPageWrapper(f.node, managedBundle(f.root)));
	// Every Windows executable comes from an absolute PATH entry, not the working directory.
	expect(handlers.nodeCalls).toEqual([f.node]);
	expect(handlers.commandInterpreterCalls.length).toBeGreaterThan(0);
	for (const interpreter of handlers.commandInterpreterCalls) expect(interpreter).toBe(f.cmd);
	for (const command of handlers.commandInterpreterCommands) expect(command).toBe("steppage-mcp.cmd");
	for (const cwd of handlers.commandInterpreterCwds) expect(cwd).toBe(dirname(managedWrapper(f.root)));
	expect(handlers.curlCalls).toEqual([f.curl]);
});

test("windows reuses a healthy wrapper without downloading", async () => {
	const f = await fixture();
	await mkdir(dirname(managedWrapper(f.root)), { recursive: true });
	await writeFile(managedWrapper(f.root), renderStepPageWrapper(f.node, managedBundle(f.root)));
	handlers.commandExists = (command) => command.endsWith(".cmd") && existsSync(command);
	let curlCalls = 0;
	handlers.onCurl = () => {
		curlCalls += 1;
	};
	expect(await ensureStepPageReady({ env: f.env, platform: "win32" })).toEqual({
		command: managedWrapper(f.root),
		installed: false,
	});
	expect(curlCalls).toBe(0);
	expect(existsSync(managedBundle(f.root))).toBe(false);
});

test("windows requires Node.js >= 20", async () => {
	const f = await fixture();
	handlers.nodeVersion = "v18.20.0";
	handlers.onCurl = () => {
		throw new Error("curl must not run when the Node.js runtime is too old");
	};
	const result = await ensureStepPageReady({ env: f.env, platform: "win32" });
	expect(result.installed).toBe(false);
	expect(result.error).toContain("Node.js >= 20");
	expect(result.error).toContain("v18.20.0");
	expect(existsSync(managedWrapper(f.root))).toBe(false);
});

test("windows failure keeps Step usable and points at step mcp prepare", async () => {
	const f = await fixture();
	handlers.onCurl = () => {
		throw new Error("curl: (22) The requested URL returned error: 404");
	};
	const result = await ensureStepPageReady({ env: f.env, platform: "win32" });
	expect(result.installed).toBe(false);
	expect(result.error).toContain("StepPage is not ready");
	expect(result.error).toContain("step mcp prepare");
	expect(result.error).not.toContain("| sh");
});

test.each(["cmd.exe", "curl.exe"] as const)(
	"windows fails closed when %s is not on an absolute PATH entry",
	async (tool) => {
		const f = await fixture();
		await rm(tool === "cmd.exe" ? f.cmd : f.curl);
		handlers.commandExists = (command) => command.endsWith(".cmd") && existsSync(command);
		handlers.onCurl = (args) => {
			const url = args.find((arg) => arg.startsWith("file://"));
			const output = args[args.indexOf("-o") + 1];
			if (!url || !output) throw new Error(`unexpected curl args: ${args.join(" ")}`);
			return copyFile(fileURLToPath(url), output);
		};
		const result = await ensureStepPageReady({ env: f.env, platform: "win32" });
		expect(result.installed).toBe(false);
		expect(result.error).toContain(tool);
		expect(existsSync(managedWrapper(f.root))).toBe(false);
	},
);

test("redaction removes URL credentials and secret parameters but keeps the rest", () => {
	expect(
		redactStepPageSecrets(
			"curl failed for https://alice:hunter2@mirror.example/a%20b/install.sh?channel=preview&token=abc123&X-Amz-Signature=deadbeef#access_token=xyz",
			{},
		),
	).toBe(
		"curl failed for https://[redacted]@mirror.example/a%20b/install.sh?channel=preview&token=[redacted]&X-Amz-Signature=[redacted]#access_token=[redacted]",
	);
	expect(redactStepPageSecrets("see 'https://ghp_secretvalue@mirror.example/install.sh' | sh", {})).toBe(
		"see 'https://[redacted]@mirror.example/install.sh' | sh",
	);
	expect(redactStepPageSecrets("https://mirror.example/install.sh?api%5Fkey=k1&v=2", {})).toBe(
		"https://mirror.example/install.sh?api%5Fkey=[redacted]&v=2",
	);
	expect(redactStepPageSecrets("plain https://dl.stepfun.com/steppage-mcp/p/install.sh text", {})).toBe(
		"plain https://dl.stepfun.com/steppage-mcp/p/install.sh text",
	);
	expect(redactStepPageSecrets("value s3cr3t-value leaked", { MIRROR_TOKEN: "s3cr3t-value" })).toBe(
		"value [redacted] leaked",
	);
});

test("redaction covers quotes in raw and shell-escaped URLs", () => {
	const raw =
		"curl failed for https://alice:pa'hunter2@mirror.example/install.sh?token=abc'123&channel=preview#access_token=xyz'456";
	const shell =
		"curl -fsSL 'https://alice:pa'\\''hunter2@mirror.example/install.sh?token=abc'\\''123&channel=preview#access_token=xyz'\\''456' | sh";
	for (const text of [raw, shell]) {
		const result = redactStepPageSecrets(text, {});
		for (const secret of ["alice", "hunter2", "abc", "xyz"]) expect(result).not.toContain(secret);
		expect(result).toContain("[redacted]");
		expect(result).toContain("channel=preview");
	}
});

test.each(["win32", "linux"] as const)("%s failure text never contains mirror credentials", async (platform) => {
	const f = await fixture();
	const installer = "https://alice:hunter2@mirror.example/steppage/install.sh?token=abc123&channel=preview";
	const env = { ...f.env, STEPCODE_STEPPAGE_INSTALLER_URL: installer };
	handlers.onCurl = (args) => {
		const url = args.find((arg) => arg.startsWith("https://"));
		throw new Error(`Command failed: curl -fsSL --max-time 30 ${url}\ncurl: (22) ${url}: 403 Forbidden`);
	};
	const result = await ensureStepPageReady({ env, platform });
	expect(result.installed).toBe(false);
	expect(result.error).toContain("403 Forbidden");
	expect(result.error).toContain("https://[redacted]@mirror.example/steppage/");
	expect(result.error).toContain("channel=preview");
	for (const secret of ["alice", "hunter2", "abc123"]) expect(result.error).not.toContain(secret);
});
