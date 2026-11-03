import { existsSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(), realpathSync: vi.fn(), statSync: vi.fn() }));
vi.mock("child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("../src/config.ts", () => ({ getBinDir: () => "/agent/bin" }));
vi.mock("../src/step/environment.ts", () => ({
	isStepStorageContext: () => false,
	resolveStepAgentDir: () => "/agent",
}));

import { getPowerShellConfig, getShellConfig, spawnShellChild } from "../src/utils/shell.ts";

const normalize = (path: unknown) => String(path).replaceAll("\\", "/").toLowerCase();
const wsl = "C:/Windows/System32/bash.exe";
let files: Set<string>;
let links: Map<string, string>;
function add(...paths: string[]) {
	for (const path of paths) files.add(normalize(path));
}
function path(value: string) {
	vi.stubEnv("PATH", value);
}
function expectShell(expected: string) {
	expect(normalize(getShellConfig().shell)).toBe(normalize(expected));
}

describe("Windows shell discovery", () => {
	beforeEach(() => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.stubEnv("ProgramFiles", "C:/Program Files");
		vi.stubEnv("ProgramFiles(x86)", "C:/Program Files (x86)");
		vi.stubEnv("LOCALAPPDATA", "C:/Users/test/AppData/Local");
		vi.stubEnv("SystemRoot", "C:/Windows");
		files = new Set();
		links = new Map();
		path("C:/Windows/System32");
		add(wsl);
		vi.mocked(existsSync).mockImplementation((p) => files.has(normalize(p)));
		vi.mocked(statSync).mockImplementation((p) => {
			if (!files.has(normalize(p))) throw new Error("ENOENT");
			return { isFile: () => true } as ReturnType<typeof statSync>;
		});
		vi.mocked(realpathSync).mockImplementation((p) => links.get(normalize(p)) ?? String(p));
		vi.mocked(spawnSync).mockImplementation(() => {
			throw new Error("Executable lookup must not spawn where");
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each([
		["D:/Developer Tools/Git", "cmd"],
		["E:/Portable Git", "bin"],
		["F:/Git", "mingw64/bin"],
		["G:/Git32", "mingw32/bin"],
	])("finds custom Git at %s through %s", (root, directory) => {
		add(`${root}/${directory}/git.exe`, `${root}/bin/bash.exe`);
		path(`C:/Windows/System32;${root}/${directory}`);
		expectShell(`${root}/bin/bash.exe`);
		expect(spawnSync).not.toHaveBeenCalled();
	});
	it("preserves explicit WSL selection", () => {
		expect(getShellConfig(wsl)).toEqual({ shell: wsl, args: ["-s"], commandTransport: "stdin" });
	});
	it("preserves explicit native shell priority", () => {
		add("Z:/custom/bash.exe", "C:/Program Files/Git/bin/bash.exe");
		expect(getShellConfig("Z:/custom/bash.exe").shell).toBe("Z:/custom/bash.exe");
	});
	it("rejects a missing explicit path without silently falling back", () => {
		add("C:/Program Files/Git/bin/bash.exe");
		expect(() => getShellConfig("Z:/missing/bash.exe")).toThrow("Custom shell path not found");
	});
	it.each(["C:/Program Files/Git", "C:/Program Files (x86)/Git", "C:/Users/test/AppData/Local/Programs/Git"])(
		"finds known installation %s without PATH",
		(root) => {
			path("");
			add(`${root}/bin/bash.exe`);
			expectShell(`${root}/bin/bash.exe`);
		},
	);
	it("returns a known installation without scanning PATH", () => {
		path("C:/Windows/System32;D:/slow-share/tools;E:/more/tools");
		add("C:/Program Files/Git/bin/bash.exe");
		vi.mocked(statSync).mockClear();
		expectShell("C:/Program Files/Git/bin/bash.exe");
		const probed = vi.mocked(statSync).mock.calls.map(([p]) => normalize(p));
		expect(probed).toEqual(["c:/program files/git/bin/bash.exe"]);
	});
	it("stops scanning PATH once a Git installation with Bash is found", () => {
		path("D:/Git/cmd;E:/later/tools;F:/even/later");
		add("D:/Git/cmd/git.exe", "D:/Git/bin/bash.exe");
		vi.mocked(statSync).mockClear();
		expectShell("D:/Git/bin/bash.exe");
		const probed = vi.mocked(statSync).mock.calls.map(([p]) => normalize(p));
		expect(probed.some((p) => p.startsWith("e:/") || p.startsWith("f:/"))).toBe(false);
	});
	it("continues past a Git shim with no adjacent Bash", () => {
		path("C:/shims;E:/real Git/cmd;C:/Windows/System32");
		add("C:/shims/git.exe", "E:/real Git/cmd/git.exe", "E:/real Git/bin/bash.exe");
		expectShell("E:/real Git/bin/bash.exe");
	});
	it("resolves a symlinked Git executable", () => {
		path("C:/links");
		add("C:/links/git.exe", "E:/Git/bin/bash.exe");
		links.set(normalize("C:/links/git.exe"), "E:/Git/cmd/git.exe");
		expectShell("E:/Git/bin/bash.exe");
	});
	it("skips WSL and finds native Bash later in quoted PATH", () => {
		path('C:/Windows/System32;"E:/MSYS tools/usr/bin"');
		add("E:/MSYS tools/usr/bin/bash.exe");
		expectShell("E:/MSYS tools/usr/bin/bash.exe");
	});
	it("does not select a symlink to the WSL launcher", () => {
		path("C:/links");
		add("C:/links/bash.exe");
		links.set(normalize("C:/links/bash.exe"), wsl);
		expect(() => getShellConfig()).toThrow("WSL bash.exe is not selected automatically");
	});
	it.each(["System32", "Sysnative", "SysWOW64"])(
		"rejects automatic WSL from %s with a custom Windows root",
		(directory) => {
			vi.stubEnv("SystemRoot", "D:/WINNT");
			path(`D:/WINNT/${directory}`);
			add(`D:/WINNT/${directory}/bash.exe`);
			expect(() => getShellConfig()).toThrow("No native Bash");
		},
	);
	it("ignores empty and relative PATH entries", () => {
		path(";.;relative");
		add("bash.exe", "relative/bash.exe");
		expect(() => getShellConfig()).toThrow("No native Bash");
	});
	it("ignores directories named bash.exe", () => {
		path("E:/tools");
		add("E:/tools/bash.exe");
		vi.mocked(statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof statSync>);
		expect(() => getShellConfig()).toThrow("No native Bash");
	});
	it("finds PowerShell without where.exe", () => {
		path("C:/Windows/System32;E:/PowerShell");
		add("E:/PowerShell/pwsh.exe");
		expect(normalize(getPowerShellConfig().shell)).toBe("e:/powershell/pwsh.exe");
	});
	it("initializes Git tools only in the child environment", () => {
		const root = "E:/Portable Git";
		add(`${root}/cmd/git.exe`, `${root}/usr/bin/bash.exe`);
		vi.mocked(spawn).mockReturnValue({} as ReturnType<typeof spawn>);
		const env = { Path: "C:/node;C:/Windows/System32", KEEP: "yes" };
		spawnShellChild({ shell: `${root}/bin/bash.exe`, args: ["-c"] }, "ls", {
			cwd: "E:/project",
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
		expect(normalize(options?.env?.Path)).toBe(
			"e:/portable git/bin;e:/portable git/usr/bin;c:/node;c:/windows/system32",
		);
		expect(env.Path).toBe("C:/node;C:/Windows/System32");
		expect(options?.env?.KEEP).toBe("yes");
	});
	it("leaves non-Git shell environments unchanged", () => {
		vi.mocked(spawn).mockReturnValue({} as ReturnType<typeof spawn>);
		const env = { PATH: "E:/tools" };
		spawnShellChild({ shell: "E:/msys/bash.exe", args: ["-c"] }, "echo ok", {
			cwd: "E:/project",
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env).toBe(env);
	});
	it("preserves Unix Bash selection", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		add("/bin/bash");
		expect(getShellConfig()).toEqual({ shell: "/bin/bash", args: ["-c"] });
	});
	it("preserves Unix PATH lookup when /bin/bash is absent", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		vi.mocked(spawnSync).mockReturnValue({
			status: 0,
			stdout: "/opt/tools/bash\n",
			stderr: "",
			pid: 1,
			output: [],
			signal: null,
		});
		expect(getShellConfig()).toEqual({ shell: "/opt/tools/bash", args: ["-c"] });
		expect(spawnSync).toHaveBeenCalledWith("which", ["bash"], expect.objectContaining({ timeout: 5000 }));
	});
	it("preserves Unix sh fallback when Bash lookup fails", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "", pid: 1, output: [], signal: null });
		expect(getShellConfig()).toEqual({ shell: "sh", args: ["-c"] });
	});
	it("preserves Unix sh fallback when executable lookup throws", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		expect(getShellConfig()).toEqual({ shell: "sh", args: ["-c"] });
	});
});
