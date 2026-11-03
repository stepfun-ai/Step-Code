import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { type ChildProcess, spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";
import { isStepStorageContext, resolveStepAgentDir } from "../step/environment.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/** Identify Windows' WSL launcher, including non-default Windows directories. */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	const windows = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	return ["System32", "Sysnative", "SysWOW64"].some(
		(directory) => normalized === win32.join(windows, directory, "bash.exe").toLowerCase(),
	);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveExecutable(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Search every absolute PATH entry lazily, without starting where.exe or searching cwd. */
function* findWindowsExecutables(executable: string): Generator<string> {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
	const seen = new Set<string>();
	for (const entry of (pathKey ? (process.env[pathKey] ?? "") : "").split(";")) {
		const directory = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!win32.isAbsolute(directory)) continue;
		const candidate = win32.join(directory, executable);
		if (!isFile(candidate)) continue;
		const resolved = resolveExecutable(candidate);
		const key = resolved.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			yield resolved;
		}
	}
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") return findWindowsExecutables(executable).next().value ?? null;
	// Unix: preserve which behavior for Termux and special filesystems.
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) return result.stdout.trim().split(/\r?\n/)[0] || null;
	} catch {
		/* Ignore errors. */
	}
	return null;
}

function gitRootFromExecutable(executable: string): string {
	let root = win32.dirname(win32.dirname(executable));
	if (/^mingw(?:32|64)$/i.test(win32.basename(root))) root = win32.dirname(root);
	return root;
}

/**
 * Yield Windows Bash candidates in priority order. Lazy so the common case (Git in a
 * known location) returns after a few stats instead of scanning PATH on every command.
 */
function* windowsBashCandidates(): Generator<string> {
	for (const directory of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
		if (directory) yield win32.join(directory, "Git", "bin", "bash.exe");
	}
	if (process.env.LOCALAPPDATA) yield win32.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe");
	for (const git of findWindowsExecutables("git.exe")) {
		yield win32.join(gitRootFromExecutable(git), "bin", "bash.exe");
	}
	yield* findWindowsExecutables("bash.exe");
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: known Git locations, Git installations on PATH, then native Bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			// Preserve explicitly selected legacy WSL launchers before canonicalization.
			// Their stdin transport is part of the existing shellPath contract.
			if (isLegacyWslBashPath(customShellPath)) return getBashShellConfig(customShellPath);
			return getBashShellConfig(process.platform === "win32" ? resolveExecutable(customShellPath) : customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		for (const candidate of windowsBashCandidates()) {
			if (!isFile(candidate)) continue;
			const resolved = resolveExecutable(candidate);
			if (!isLegacyWslBashPath(resolved)) return getBashShellConfig(resolved);
		}
		throw new Error(
			"No native Bash shell found on Windows. Install Git for Windows, add Git or a native Bash to PATH, " +
				"or set shellPath to your Bash executable. WSL bash.exe is not selected automatically: " +
				"it runs Linux commands with a different toolchain. To use WSL, start Step inside WSL " +
				"or explicitly configure shellPath to the WSL bash.exe launcher.",
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(agentDir?: string): NodeJS.ProcessEnv {
	const resolvedAgentDir = agentDir?.trim() || (isStepStorageContext() ? resolveStepAgentDir() : undefined);
	const binDir = resolvedAgentDir ? join(resolvedAgentDir, "bin") : getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/** Add Git's own tools for non-login Bash without loading user startup scripts. */
export function withGitBashPath(shell: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (process.platform !== "win32" || win32.basename(shell).toLowerCase() !== "bash.exe") return env;
	let root = win32.dirname(win32.dirname(shell));
	if (win32.basename(root).toLowerCase() === "usr") root = win32.dirname(root);
	const usrBin = win32.join(root, "usr", "bin");
	if (!isFile(win32.join(root, "cmd", "git.exe")) || !isFile(win32.join(usrBin, "bash.exe"))) return env;
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const entries = [win32.join(root, "bin"), usrBin, ...(env[pathKey] ?? "").split(";")];
	const seen = new Set<string>();
	return {
		...env,
		[pathKey]: entries
			.filter((entry) => {
				const key = win32.normalize(entry).toLowerCase();
				if (!entry || seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.join(";"),
	};
}

/**
 * Spawn a shell child from a resolved ShellConfig, centralizing the command
 * transport (argv vs stdin) so call sites do not re-derive it. Callers own the
 * lifecycle (pid tracking, timeout, streaming, unref); the stdout/stderr targets
 * are "pipe" to stream, or an open fd number to redirect (e.g. a background log).
 */
export function spawnShellChild(
	shellConfig: ShellConfig,
	command: string,
	options: { cwd: string; env: NodeJS.ProcessEnv; stdout: "pipe" | number; stderr: "pipe" | number },
): ChildProcess {
	const commandFromStdin = shellConfig.commandTransport === "stdin";
	const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: withGitBashPath(shellConfig.shell, options.env),
		stdio: [commandFromStdin ? "pipe" : "ignore", options.stdout, options.stderr],
		windowsHide: true,
	});
	if (commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	}
	return child;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

type LinuxProcessIdentity = { pid: number; ppid: number; startTime: string };

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTime = fields[19];
		return startTime ? { pid, ppid: Number(fields[1]), startTime } : undefined;
	} catch {
		return undefined;
	}
}

/** Snapshot descendants before killing their parent makes them untraceable. */
function getLinuxDescendants(pid: number): LinuxProcessIdentity[] {
	const children = new Map<number, LinuxProcessIdentity[]>();
	try {
		// /proc/<pid>/task/<tid>/children is absent on some Linux kernels.
		// The stat parent field is available without that optional interface.
		for (const entry of readdirSync("/proc")) {
			const childPid = Number(entry);
			if (!Number.isSafeInteger(childPid) || childPid <= 0) continue;
			const child = readLinuxProcessIdentity(childPid);
			if (!child) continue;
			const siblings = children.get(child.ppid) ?? [];
			siblings.push(child);
			children.set(child.ppid, siblings);
		}
	} catch {
		return [];
	}
	const descendants: LinuxProcessIdentity[] = [];
	const pending = [pid];
	const visited = new Set(pending);
	for (let index = 0; index < pending.length; index++) {
		for (const child of children.get(pending[index]) ?? []) {
			if (visited.has(child.pid)) continue;
			visited.add(child.pid);
			descendants.push(child);
			pending.push(child.pid);
		}
	}
	return descendants;
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		const descendants = process.platform === "linux" ? getLinuxDescendants(pid) : [];
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
		// A detached child can have a different group/session. Target only the
		// identities observed in this command's subtree, never all host processes.
		for (const descendant of descendants.reverse()) {
			if (readLinuxProcessIdentity(descendant.pid)?.startTime !== descendant.startTime) continue;
			try {
				process.kill(descendant.pid, "SIGKILL");
			} catch {
				// The descendant already exited or was killed with the parent group.
			}
		}
	}
}
