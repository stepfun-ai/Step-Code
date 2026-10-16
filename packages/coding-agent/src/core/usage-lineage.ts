import { randomUUID } from "node:crypto";
import type { CustomEntry, SessionEntry, SessionHeader } from "./session-manager.ts";

/** Preserve Step's local statistics origin when the source file later disappears. */
export function createUsageLineage(
	source: SessionHeader | null,
	full: readonly SessionEntry[],
	copied: readonly SessionEntry[],
	owner: string,
	timestamp: string,
	parentId: string | null,
): CustomEntry[] {
	if (!source || !full.some((e) => e.type === "custom" && e.customType === "step.activity_capabilities")) return [];
	const inherited = new Map<string, { sessionId: string; cwd: string; role: "user" | "subagent" }>();
	for (const e of full)
		if (e.type === "custom" && e.customType === "step.usage_lineage") {
			const d = e.data as {
				version?: number;
				sessionId?: string;
				origins?: Record<string, { sessionId: string; cwd: string; role: "user" | "subagent" }>;
			};
			if (d?.version === 1 && d.sessionId === source.id && d.origins)
				for (const [id, origin] of Object.entries(d.origins))
					if (
						origin &&
						typeof origin.sessionId === "string" &&
						typeof origin.cwd === "string" &&
						["user", "subagent"].includes(origin.role)
					)
						inherited.set(id, origin);
		}
	const cap = full.find(
		(e) =>
			e.type === "custom" &&
			e.customType === "step.activity_capabilities" &&
			(e.data as { sessionId?: string })?.sessionId === source.id,
	) as CustomEntry<{ sessionRole?: string; parentCwd?: string }> | undefined;
	const role =
		cap?.data?.sessionRole === "subagent" || source.id.startsWith("subagent-") || source.id.startsWith("workflow-")
			? "subagent"
			: "user";
	const origin = { sessionId: source.id, cwd: cap?.data?.parentCwd ?? source.cwd, role } as const;
	const copiedIds = new Set(copied.map((entry) => entry.id));
	const supplemental: CustomEntry[] = [];
	for (const entry of full) {
		if (entry.type !== "custom" || copiedIds.has(entry.id)) continue;
		const data = entry.data as { usageEntryId?: string; sessionId?: string } | undefined;
		if (
			(entry.customType === "step.usage_provenance" &&
				typeof data?.usageEntryId === "string" &&
				copiedIds.has(data.usageEntryId)) ||
			(entry.customType === "step.activity_capabilities" && data?.sessionId === source.id)
		) {
			supplemental.push({ ...entry, parentId });
			parentId = entry.id;
		}
	}
	const entries: CustomEntry[] = [...supplemental];
	let origins: Record<string, typeof origin> = {},
		bytes = 0;
	const flush = (): void => {
		if (!Object.keys(origins).length) return;
		const id = randomUUID();
		entries.push({
			type: "custom",
			customType: "step.usage_lineage",
			id,
			parentId,
			timestamp,
			data: { version: 1, sessionId: owner, origins },
		});
		parentId = id;
		origins = {};
		bytes = 0;
	};
	for (const entry of [...copied, ...supplemental]) {
		if (entry.type === "custom" && entry.customType === "step.usage_lineage") continue;
		const value = inherited.get(entry.id) ?? origin;
		const size = Buffer.byteLength(JSON.stringify([entry.id, value]));
		if (size > 8192) continue;
		if (bytes + size > 96 * 1024) flush();
		origins[entry.id] = value;
		bytes += size;
	}
	flush();
	return entries;
}
