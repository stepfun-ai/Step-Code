import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { spawnProcess } from "../utils/child-process.ts";
import { resolveStepAgentDir } from "./environment.ts";

export type DependencyReason =
	| "unsupported"
	| "missing"
	| "platform"
	| "npm_missing"
	| "install_failed"
	| "timeout"
	| "unsafe_installer"
	| "verification_failed"
	| "conflict";
export interface PluginDependencyState {
	readonly command: string;
	readonly status: "ready" | "installed" | "setup_required";
	readonly reason?: DependencyReason;
	readonly setupCommand?: string;
	readonly firstUseConfiguration: boolean;
}
interface Recipe {
	readonly package?: string;
	readonly installer?: string;
	readonly setupCommand?: string;
}
const recipes = new Map<string, Recipe>([
	["dws", { package: "dingtalk-workspace-cli@1.0.66", installer: "install.js", setupCommand: "dws auth login" }],
	[
		"lark-cli",
		{ package: "@larksuite/cli@1.0.98", installer: "scripts/install.js", setupCommand: "lark-cli auth login" },
	],
	["wecom-cli", { package: "@wecom/cli@1.3.4", setupCommand: "wecom-cli auth init" }],
	["gh", { setupCommand: "gh auth login" }],
	["glab", { setupCommand: "glab auth login" }],
	["qgraphflow", {}],
]);
export interface CliExecution {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
}
export type CliExecute = (request: CliExecution) => Promise<"ok" | "failed" | "timeout">;

/** Installer subprocesses never receive model/API credentials or the user's npm configuration. */
function installerEnvironment(source: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"HOME",
		"USERPROFILE",
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"APPDATA",
		"LOCALAPPDATA",
		"TMP",
		"TEMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
	])
		if (source[key]) env[key] = source[key];
	const key = Object.keys(source).find((key) => key.toLowerCase() === "path") ?? "PATH";
	env.PATH = [join(agentDir, "bin"), source[key]].filter(Boolean).join(delimiter);
	env.ELECTRON_RUN_AS_NODE = "1";
	env.DWS_NO_SKILLS = "1";
	env.DO_NOT_TRACK = "1";
	return env;
}
async function findCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
		for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
			const path = join(directory, `${command}${suffix}`);
			if (
				(await stat(path).then(
					(info) => info.isFile(),
					() => false,
				)) &&
				(await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(
					() => true,
					() => false,
				))
			)
				return path;
		}
	}
	return undefined;
}
const executeCli: CliExecute = (request) =>
	new Promise((resolveResult) => {
		const child = spawnProcess(request.command, [...request.args], {
			cwd: request.cwd,
			env: request.env,
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {}
		}, request.timeoutMs);
		const killTimer = setTimeout(() => {
			if (!timedOut) return;
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		}, request.timeoutMs + 1500);
		child.once("error", () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			resolveResult("failed");
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			resolveResult(timedOut ? "timeout" : code === 0 ? "ok" : "failed");
		});
	});

async function exposeManagedCli(root: string, bin: string, destination: string, command: string): Promise<boolean> {
	const link = join(bin, command),
		executable = join(destination, "node_modules", ".bin", command);
	const old = await lstat(link).catch(() => undefined);
	if (!old) {
		await symlink(executable, link);
		return true;
	}
	if (!old.isSymbolicLink()) return false;
	const rel = relative(root, resolve(bin, await readlink(link)));
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	const temporary = join(bin, `.cli-link-${randomUUID()}`);
	try {
		await symlink(executable, temporary);
		await rename(temporary, link);
		return true;
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export async function inspectPluginDependency(command: string, env = process.env): Promise<PluginDependencyState> {
	const recipe = recipes.get(command);
	const present = recipe && (await findCommand(command, installerEnvironment(env, resolveStepAgentDir(env))));
	return {
		command,
		status: present ? "ready" : "setup_required",
		reason: present ? undefined : recipe?.package ? "missing" : "unsupported",
		setupCommand: recipe?.setupCommand,
		firstUseConfiguration: Boolean(recipe?.setupCommand),
	};
}

export async function ensurePluginDependency(
	command: string,
	options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execute?: CliExecute } = {},
): Promise<PluginDependencyState> {
	const recipe = recipes.get(command);
	const state = (status: PluginDependencyState["status"], reason?: DependencyReason): PluginDependencyState => ({
		command,
		status,
		reason,
		setupCommand: recipe?.setupCommand,
		firstUseConfiguration: Boolean(recipe?.setupCommand),
	});
	if (!recipe) return state("setup_required", "unsupported");
	const source = options.env ?? process.env,
		agentDir = resolveStepAgentDir(source),
		env = installerEnvironment(source, agentDir);
	const run = options.execute ?? executeCli;
	const existing = await findCommand(command, env);
	if (
		existing &&
		(await run({
			command: existing,
			args: ["--version"],
			cwd: source.HOME ?? source.USERPROFILE ?? process.cwd(),
			env,
			timeoutMs: 8000,
		}).catch(() => "failed")) === "ok"
	)
		return state("ready");
	if (!recipe.package) return state("setup_required", "unsupported");
	if (!["darwin", "linux"].includes(options.platform ?? process.platform)) return state("setup_required", "platform");
	const npm = await findCommand("npm", env);
	const root = join(agentDir, "tools", "plugin-cli"),
		bin = join(agentDir, "bin");
	const packageSplit = recipe.package.lastIndexOf("@"),
		packageName = recipe.package.slice(0, packageSplit),
		packageVersion = recipe.package.slice(packageSplit + 1);
	const destination = join(root, `${command}-${packageVersion}`);
	const writable = await Promise.all([
		mkdir(root, { recursive: true, mode: 0o700 }),
		mkdir(bin, { recursive: true, mode: 0o700 }),
	]).then(
		() => true,
		() => false,
	);
	if (!writable) return state("setup_required", "install_failed");
	let release: (() => Promise<void>) | undefined,
		stage: string | undefined,
		compromised = false;
	try {
		release = await lockfile.lock(root, {
			realpath: false,
			lockfilePath: join(root, `.${command}.lock`),
			stale: 180000,
			update: 10000,
			onCompromised: () => {
				compromised = true;
			},
		});
		if (
			await lstat(destination).then(
				() => true,
				() => false,
			)
		) {
			const receipt = join(destination, "stepcode-cli-install.json"),
				info = await lstat(receipt).catch(() => undefined);
			if (!info?.isFile() || info.size > 8192) return state("setup_required", "conflict");
			const installed = JSON.parse(await readFile(receipt, "utf8")) as { package: string };
			if (installed.package !== recipe.package) return state("setup_required", "conflict");
			const metadata = JSON.parse(
				await readFile(join(destination, "node_modules", packageName, "package.json"), "utf8"),
			) as { name: string; version: string };
			if (metadata.name !== packageName || metadata.version !== packageVersion)
				return state("setup_required", "unsafe_installer");
			if (
				(await run({
					command: join(destination, "node_modules", ".bin", command),
					args: ["--version"],
					cwd: destination,
					env,
					timeoutMs: 10000,
				})) !== "ok"
			)
				return state("setup_required", "verification_failed");
			if (compromised || !(await exposeManagedCli(root, bin, destination, command)))
				return state("setup_required", "conflict");
			return state("ready");
		}
		if (!npm) return state("setup_required", "npm_missing");
		stage = await mkdtemp(join(root, `.${command}-`));
		const config = join(stage, "npmrc"),
			globalConfig = join(stage, "global-npmrc"),
			prefix = join(stage, "prefix");
		await writeFile(config, "", { mode: 0o600 });
		await writeFile(globalConfig, "", { mode: 0o600 });
		await mkdir(prefix);
		const installEnv = {
			...env,
			NPM_CONFIG_USERCONFIG: config,
			NPM_CONFIG_GLOBALCONFIG: globalConfig,
			NPM_CONFIG_CACHE: join(stage, "cache"),
		};
		const installed = await run({
			command: npm,
			args: [
				"install",
				"--prefix",
				prefix,
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--include=optional",
				"--registry=https://registry.npmjs.org",
				recipe.package,
			],
			cwd: prefix,
			env: installEnv,
			timeoutMs: 120000,
		});
		if (installed !== "ok") return state("setup_required", installed === "timeout" ? "timeout" : "install_failed");
		const split = recipe.package.lastIndexOf("@"),
			name = recipe.package.slice(0, split),
			version = recipe.package.slice(split + 1);
		const packageRoot = join(prefix, "node_modules", name);
		const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
			name: string;
			version: string;
		};
		if (metadata.name !== name || metadata.version !== version) return state("setup_required", "unsafe_installer");
		if (recipe.installer) {
			const script = join(packageRoot, recipe.installer),
				info = await lstat(script);
			if (!info.isFile() || info.size > 1024 * 1024) return state("setup_required", "unsafe_installer");
			if (
				command === "dws" &&
				!/if\s*\(\s*process\.env\.DWS_NO_SKILLS\s*===\s*["']1["']\s*\)\s*\{[^}]*return;/su.test(
					await readFile(script, "utf8"),
				)
			)
				return state("setup_required", "unsafe_installer");
			const prepared = await run({
				command: process.execPath,
				args: [script],
				cwd: packageRoot,
				env: installEnv,
				timeoutMs: 120000,
			});
			if (prepared !== "ok") return state("setup_required", prepared === "timeout" ? "timeout" : "install_failed");
		}
		const executable = join(prefix, "node_modules", ".bin", command);
		if (
			(await run({ command: executable, args: ["--version"], cwd: prefix, env: installEnv, timeoutMs: 10000 })) !==
			"ok"
		)
			return state("setup_required", "verification_failed");
		if (compromised) return state("setup_required", "conflict");
		await writeFile(join(prefix, "stepcode-cli-install.json"), JSON.stringify({ package: recipe.package }), {
			mode: 0o600,
		});
		await rename(prefix, destination);
		if (!(await exposeManagedCli(root, bin, destination, command))) return state("setup_required", "conflict");
		return state("installed");
	} catch {
		return state("setup_required", "install_failed");
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
		await release?.().catch(() => undefined);
	}
}
