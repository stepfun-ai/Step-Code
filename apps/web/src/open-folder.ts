import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

/**
 * Show a workspace folder in the system file manager: Finder on macOS, File
 * Explorer on Windows, the desktop's default handler elsewhere. The Host only
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
	const { command, args, verbatim } = folderOpenCommand(platform, dir);
	await new Promise<void>((resolve, reject) => {
		const child = run(command, [...args], {
			stdio: "ignore",
			detached: true,
			windowsHide: false,
			windowsVerbatimArguments: verbatim,
		});
		child.once("error", (error) => reject(new Error(`Could not open the folder: ${error.message}`)));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
