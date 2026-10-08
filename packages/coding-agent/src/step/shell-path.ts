import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { resolveStepAgentDir, resolveStepHomeDir } from "./environment.ts";
import { resolveStepExecutablePath } from "./local-update.ts";

/** Idempotent migration for standalone users whose old updater bypassed install.sh. */
export async function ensureStepShellPath(
	input: { env?: NodeJS.ProcessEnv; executablePath?: string; platform?: NodeJS.Platform } = {},
): Promise<string[]> {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const executable = input.executablePath ?? resolveStepExecutablePath(env);
	if (!executable || platform === "win32" || env.STEP_NO_MODIFY_PATH) return [];
	const installDir = dirname(executable);
	const managedBin = join(resolveStepAgentDir(env), "bin");
	const home = resolveStepHomeDir(env);
	const shell = basename(env.SHELL ?? "");
	if ([installDir, managedBin].some((value) => /["`$\\\r\n]/u.test(value)))
		return ["Could not persist Step PATH safely; add the installation directory to your shell profile manually."];
	if (shell === "csh" || shell === "tcsh")
		return [`Add ${installDir} and ${managedBin} to your ${shell} PATH manually.`];
	const profiles =
		shell === "zsh"
			? [join(env.ZDOTDIR || home, ".zshrc")]
			: shell === "fish"
				? [join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "config.fish")]
				: shell === "bash"
					? [join(home, ".bashrc"), ...(platform === "darwin" ? [join(home, ".bash_profile")] : [])]
					: [join(home, ".profile")];
	const body =
		shell === "fish"
			? `fish_add_path "${installDir}" "${managedBin}"\n`
			: [installDir, managedBin]
					.map(
						(directory) =>
							`case ":$PATH:" in\n  *":${directory}:"*) ;;\n  *) export PATH="${directory}:$PATH" ;;\nesac\n`,
					)
					.join("");
	const block = `# stepcode\n${body}# stepcode end\n`;
	const warnings: string[] = [];
	for (const profile of profiles) {
		let release: (() => Promise<void>) | undefined;
		try {
			await mkdir(dirname(profile), { recursive: true });
			release = await lockfile.lock(profile, { realpath: false });
			let previous = "";
			try {
				previous = await readFile(profile, "utf8");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			if (previous.includes(block)) continue;
			let inBlock = false;
			for (const marker of previous.match(/^# stepcode(?: end)?\r?$/gmu) ?? []) {
				const opening = marker.trimEnd() === "# stepcode";
				if (opening === inBlock) throw new Error("an incomplete or nested Step PATH block was left unchanged");
				inBlock = opening;
			}
			if (inBlock) throw new Error("an incomplete Step PATH block was left unchanged");
			const preserved = previous.replace(/^# stepcode\r?\n[\s\S]*?^# stepcode end\r?\n?/gmu, "");
			await writeFile(profile, `${preserved}${preserved.endsWith("\n") || !preserved ? "" : "\n"}\n${block}`, {
				encoding: "utf8",
				mode: 0o600,
			});
		} catch (error) {
			warnings.push(
				`Could not persist Step PATH in ${profile}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			await release?.().catch(() => undefined);
		}
	}
	return warnings;
}
