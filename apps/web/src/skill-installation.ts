import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Display provenance only: never a permission or safety decision. */
export interface SkillInstallation {
	readonly source: "skillhub";
	readonly registryId: string;
	readonly sourceUrl: string;
	readonly version: string;
	readonly skillSha256: string;
}

const MAX_RECEIPT = 8192;
const MAX_SKILL = 512 * 1024;

export async function readSkillInstallation(file: string, name: string): Promise<SkillInstallation | undefined> {
	if (basename(file) !== "SKILL.md") return undefined;
	try {
		const receipt = join(dirname(file), "stepcode.skill-install.json");
		const [receiptStat, skillStat] = await Promise.all([lstat(receipt), lstat(file)]);
		if (!receiptStat.isFile() || receiptStat.size > MAX_RECEIPT || !skillStat.isFile() || skillStat.size > MAX_SKILL)
			return undefined;
		const [json, skill] = await Promise.all([readFile(receipt), readFile(file)]);
		if (json.length > MAX_RECEIPT || skill.length > MAX_SKILL) return undefined;
		const value: unknown = JSON.parse(json.toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const data = value as Record<string, unknown>;
		if (
			data.schemaVersion !== 1 ||
			data.source !== "skillhub" ||
			data.skillName !== name ||
			typeof data.registryId !== "string" ||
			!/^@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(data.registryId) ||
			data.registryId.length > 200 ||
			typeof data.sourceUrl !== "string" ||
			data.sourceUrl.length > 400 ||
			typeof data.version !== "string" ||
			data.version.length > 64 ||
			!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.version) ||
			typeof data.skillSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(data.skillSha256)
		)
			return undefined;
		const url = new URL(data.sourceUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "skillhub.cn" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== `/skills/${data.registryId.slice(1)}`
		)
			return undefined;
		if (createHash("sha256").update(skill).digest("hex") !== data.skillSha256) return undefined;
		return {
			source: "skillhub",
			registryId: data.registryId,
			sourceUrl: data.sourceUrl,
			version: data.version,
			skillSha256: data.skillSha256,
		};
	} catch {
		return undefined;
	}
}
