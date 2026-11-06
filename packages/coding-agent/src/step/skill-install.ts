import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { type PluginFile, PluginInstallError, safePluginPath } from "./plugin-archive.ts";
import type { PluginInstallPreview } from "./plugin-install.ts";

export const SKILL_ARCHIVE_LIMITS = { files: 16000, bytes: 128 * 1024 * 1024 };
export interface SkillPackage {
	readonly files: readonly PluginFile[];
	readonly preview: PluginInstallPreview;
}
export function prepareSkillPackage(input: readonly PluginFile[]): SkillPackage {
	if (!input.length || input.length > SKILL_ARCHIVE_LIMITS.files)
		throw new PluginInstallError("Skill package is empty or too large");
	const entries = input.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
	const root = entries.find((entry) => {
		const prefix = entry.path.slice(0, -"SKILL.md".length);
		return input.every((file) => file.path.startsWith(prefix));
	});
	if (!root || root.data.length > 512 * 1024)
		throw new PluginInstallError("A single root SKILL.md is required (maximum 512 KiB)");
	const prefix = root.path.slice(0, -"SKILL.md".length);
	const files = input.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
	const seen = new Set<string>();
	let bytes = 0;
	for (const file of files) {
		const key = file.path.normalize("NFC").toLowerCase();
		if (!safePluginPath(file.path) || seen.has(key))
			throw new PluginInstallError("Unsafe or duplicate skill resource path");
		seen.add(key);
		bytes += file.data.length;
		if (bytes > SKILL_ARCHIVE_LIMITS.bytes) throw new PluginInstallError("Skill expands beyond 128 MiB");
	}
	let metadata: Record<string, unknown>;
	try {
		metadata = parseFrontmatter<Record<string, unknown>>(root.data.toString("utf8")).frontmatter;
	} catch {
		throw new PluginInstallError("Invalid YAML frontmatter in SKILL.md");
	}
	const name = typeof metadata.name === "string" ? metadata.name : "";
	if (!safePluginPath(name) || name.includes("/") || /\s/u.test(name) || name.length > 200)
		throw new PluginInstallError("SKILL.md requires a portable name without spaces or path separators");
	if (typeof metadata.description !== "string" || !metadata.description.trim())
		throw new PluginInstallError("SKILL.md requires a description");
	const hash = createHash("sha256");
	for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		hash.update(`${file.path}\0${file.data.length}\0${Boolean(file.executable)}\0`);
		hash.update(file.data);
	}
	return {
		files,
		preview: {
			id: name,
			name,
			fingerprint: hash.digest("hex"),
			skills: [name],
			commands: [],
			mcpServers: [],
			requiresEnv: [],
			warnings: [
				"Skill instructions/scripts may access files and external services; new or reloaded sessions load this skill.",
			],
		},
	};
}
export async function installPreparedSkill(
	pkg: SkillPackage,
	root = join(resolveStepAgentDir(), "skills"),
): Promise<PluginInstallPreview> {
	await mkdir(root, { recursive: true, mode: 0o700 });
	let compromised = false;
	const release = await lockfile
		.lock(root, {
			realpath: false,
			lockfilePath: join(root, `.install-${pkg.preview.id.normalize("NFC").toLowerCase()}.lock`),
			stale: 60000,
			update: 10000,
			onCompromised: () => {
				compromised = true;
			},
		})
		.catch(() => {
			throw new PluginInstallError("Skill installation is in progress", 409);
		});
	let stage: string | undefined;
	try {
		const target = join(root, pkg.preview.id);
		if (
			(await readdir(root)).some(
				(name) => name.normalize("NFC").toLowerCase() === pkg.preview.id.normalize("NFC").toLowerCase(),
			) ||
			(await lstat(target).then(
				() => true,
				() => false,
			))
		)
			throw new PluginInstallError("Skill is already installed; remove it first", 409);
		stage = await mkdtemp(join(root, ".install-stage-"));
		for (const file of pkg.files) {
			const path = join(stage, file.path);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, file.data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
		}
		if (compromised) throw new PluginInstallError("Skill installation lock was lost", 409);
		await rename(stage, target);
		stage = undefined;
		return pkg.preview;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
		await release();
	}
}
