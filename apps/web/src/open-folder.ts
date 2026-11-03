import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

/**
 * Show a workspace folder in the system file manager: Finder on macOS, File
 * Explorer on Windows, the desktop's default handler elsewhere — and open a
 * configuration file in its associated application. The Host only
 * listens on loopback, so the person using the page sits at this machine.
 */

export interface FolderOpenCommand {
	readonly command: string;
	readonly args: readonly string[];
	/** Pass `args` to the process unquoted (Windows only; see below). */
	readonly verbatim: boolean;
}

/**
 * The launcher for `dir`, never through a shell.
 *
 * File Explorer splits its command line at commas itself, so a folder named
 * `a,b` would open the wrong place unless the whole path is one quoted
 * argument. Windows paths cannot contain `"`, which makes the quoting exact; a
 * trailing backslash (a drive root) would escape the closing quote, so it gets
 * a `.` instead.
 */
export function folderOpenCommand(platform: NodeJS.Platform, dir: string): FolderOpenCommand {
	if (platform === "darwin") return { command: "open", args: [dir], verbatim: false };
	if (platform === "win32") {
		const target = dir.endsWith("\\") ? `${dir}.` : dir;
		return { command: "explorer.exe", args: [`"${target}"`], verbatim: true };
	}
	return { command: "xdg-open", args: [dir], verbatim: false };
}

/** The process launcher, replaceable in tests. */
export type Spawn = typeof spawn;

/**
 * Open `dir` (an absolute path the caller already authorized) and resolve once
 * the launcher has started. Its exit status is not awaited: Explorer exits 1
 * even when it opened the window, and the file manager outlives the request.
 */
export async function openFolder(dir: string, platform: NodeJS.Platform = process.platform, run: Spawn = spawn) {
	if (!(await stat(dir)).isDirectory()) throw new Error("Path is not a folder");
	await launch(folderOpenCommand(platform, dir), run, "Could not open the folder");
}

/**
 * Open a file (an absolute path the caller already authorized) in the
 * application the system associates with it. On macOS a file type without an
 * associated application makes `open` fail, so it waits for that answer and
 * retries in the default text editor (`open -t`); the other launchers hand the
 * file to the desktop and are not awaited, as for folders.
 */
export async function openFileWithDefaultApp(
	file: string,
	platform: NodeJS.Platform = process.platform,
	run: Spawn = spawn,
): Promise<void> {
	if (!(await stat(file)).isFile()) throw new Error("Path is not a file");
	if (platform === "darwin") {
		const code = await exitCode({ command: "open", args: [file], verbatim: false }, run);
		if (code === 0) return;
		const fallback = await exitCode({ command: "open", args: ["-t", file], verbatim: false }, run);
		if (fallback !== 0) throw new Error(`Could not open the file (open exited with ${fallback})`);
		return;
	}
	await launch(folderOpenCommand(platform, file), run, "Could not open the file");
}

function launch({ command, args, verbatim }: FolderOpenCommand, run: Spawn, failure: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = run(command, [...args], {
			stdio: "ignore",
			detached: true,
			windowsHide: false,
			windowsVerbatimArguments: verbatim,
		});
		child.once("error", (error) => reject(new Error(`${failure}: ${error.message}`)));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** Run a short-lived launcher to completion; a spawn failure rejects. */
function exitCode({ command, args }: FolderOpenCommand, run: Spawn): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const child = run(command, [...args], { stdio: "ignore" });
		child.once("error", (error) => reject(new Error(`Could not open the file: ${error.message}`)));
		child.once("close", (code) => resolve(code ?? 1));
	});
}
