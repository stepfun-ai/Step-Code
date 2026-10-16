import { createHash, randomUUID } from "node:crypto";
import { constants, type Dir } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { entryUsage, normalizeUsage } from "../../core/usage-totals.ts";
import { projectUsageJson, UsageProjectionLimit } from "./json-projection.ts";
import type { UsageOverview } from "./types.ts";

type Row = Record<string, unknown>;
interface FileIndex {
	path: string;
	aliases?: string[];
	ino: string;
	dev: string;
	size: number;
	mtime: string;
	parsedBytes: number;
	digest?: string;
	header?: Row;
	entries: Row[];
	limited: string[];
}
export interface ActivityScanOptions {
	roots: string[];
	cwd: string;
	scope: "all" | "project";
	dates: string[];
	timezone: string;
	cachePath: string;
	key: string;
}
const MAX_ENTRIES = 25000,
	MAX_FILES = 10000,
	MAX_LINE = 16 * 1024 * 1024;

async function inventory(
	roots: string[],
	signal?: AbortSignal,
): Promise<Map<string, FileIndex> & { limited?: boolean }> {
	const result: Map<string, FileIndex> & { limited?: boolean } = new Map<string, FileIndex>();
	const seen = new Set<string>();
	const visit = async (path: string, depth: number, canonicalRoot: string, logicalRoot: string): Promise<void> => {
		if (depth > 8) {
			result.limited = true;
			return;
		}
		try {
			const metadata = await lstat(path);
			if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) return;
		} catch {
			return;
		}
		let dir: Dir;
		try {
			dir = await opendir(path);
		} catch {
			return;
		}
		for await (const entry of dir) {
			signal?.throwIfAborted();
			const file = join(path, entry.name);
			if (entry.isDirectory()) await visit(file, depth + 1, canonicalRoot, logicalRoot);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const alias = join(logicalRoot, relative(canonicalRoot, file));
				if (seen.has(file)) {
					result.get(file)?.aliases?.push(alias);
					continue;
				}
				if (result.size >= MAX_FILES) {
					result.limited = true;
					continue;
				}
				seen.add(file);
				try {
					const s = await stat(file, { bigint: true });
					if (s.size > BigInt(Number.MAX_SAFE_INTEGER)) continue;
					result.set(file, {
						path: file,
						aliases: [alias],
						ino: String(s.ino),
						dev: String(s.dev),
						size: Number(s.size),
						mtime: String(s.mtimeNs),
						parsedBytes: 0,
						entries: [],
						limited: [],
					});
				} catch {
					/* disappeared */
				}
			}
		}
	};
	for (const root of roots) {
		try {
			const path = await realpath(root);
			await visit(path, 0, path, resolve(root));
		} catch {
			/* new installation */
		}
	}
	return result;
}

async function readLines(
	path: string,
	start: number,
	end: number,
	onLine: (row: Row, through: number) => void,
	limited: Set<string>,
	expected?: FileIndex,
	signal?: AbortSignal,
): Promise<number> {
	const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let chunks: Buffer[] = [],
		length = 0,
		oversized = false,
		cursor = start,
		parsed = start;
	const hash = createHash("sha256");
	let hashValid = true;
	try {
		if (expected) {
			const actual = await fd.stat({ bigint: true });
			if (String(actual.ino) !== expected.ino || String(actual.dev) !== expected.dev)
				throw new Error("Session file replaced");
		}
		const buffer = Buffer.alloc(32768);
		for (let offset = 0; offset < start; ) {
			const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, start - offset), offset);
			if (!bytesRead) throw new Error("Session prefix truncated");
			hash.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		if (start > 0 && expected?.digest && hash.copy().digest("hex") !== expected.digest)
			throw new Error("Session prefix changed");
		while (cursor < end) {
			signal?.throwIfAborted();
			const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, end - cursor), cursor);
			if (bytesRead === 0) break;
			let offset = 0;
			for (let i = 0; i < bytesRead; i++)
				if (buffer[i] === 10) {
					const slice = buffer.subarray(offset, i);
					length += slice.length;
					const through = cursor + i + 1;
					if (!oversized && length <= MAX_LINE) {
						chunks.push(Buffer.from(slice));
						const rawBytes = Buffer.concat(chunks, length);
						hash.update(rawBytes);
						hash.update("\n");
						try {
							const raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
							if (raw.trim()) onLine(projectUsageJson(raw), through);
						} catch (error) {
							limited.add(
								error instanceof UsageProjectionLimit ? "Resource-limited records" : "Invalid records",
							);
						}
					} else {
						limited.add("Resource-limited records");
						hashValid = false;
					}
					parsed = through;
					chunks = [];
					length = 0;
					oversized = false;
					offset = i + 1;
				}
			if (offset < bytesRead) {
				const slice = buffer.subarray(offset, bytesRead);
				length += slice.length;
				if (length > MAX_LINE) {
					oversized = true;
					chunks = [];
				} else if (!oversized) chunks.push(Buffer.from(slice));
			}
			cursor += bytesRead;
		}
		if (length > 0 || oversized) limited.add("Incomplete trailing records");
		if (expected) expected.digest = hashValid ? hash.digest("hex") : "";
		return parsed;
	} finally {
		await fd.close();
	}
}

async function readCache(options: ActivityScanOptions, signal?: AbortSignal): Promise<Map<string, FileIndex>> {
	const files = new Map<string, FileIndex>(),
		limited = new Set<string>(),
		chunks = new Map<string, number>();
	let matching = false,
		complete = false,
		entries = 0;
	try {
		const size = (await stat(options.cachePath)).size;
		if (size > 32 * 1024 * 1024) return files;
		await readLines(
			options.cachePath,
			0,
			size,
			(row) => {
				const d = row.data as Row | undefined;
				if (row.type === "usage-cache-meta") {
					matching = d?.key === options.key && d.version === 1;
					complete = d?.complete === true;
					return;
				}
				if (
					!matching ||
					row.type !== "usage-cache-file" ||
					!d ||
					typeof d.path !== "string" ||
					!Array.isArray(d.entries) ||
					entries + d.entries.length > MAX_ENTRIES ||
					typeof d.ino !== "string" ||
					typeof d.dev !== "string" ||
					typeof d.mtime !== "string" ||
					typeof d.size !== "number" ||
					typeof d.parsedBytes !== "number" ||
					!Number.isSafeInteger(d.size) ||
					!Number.isSafeInteger(d.parsedBytes) ||
					d.parsedBytes < 0 ||
					d.parsedBytes > d.size
				)
					throw new Error("cache");
				entries += d.entries.length;
				const old = files.get(d.path);
				if (
					typeof d.chunk !== "number" ||
					d.chunk !== (chunks.get(d.path) ?? 0) ||
					(old && (d.ino !== old.ino || d.parsedBytes !== old.parsedBytes))
				)
					throw new Error("cache chunk");
				chunks.set(d.path, d.chunk + 1);
				if (old) old.entries.push(...(d.entries as Row[]));
				else {
					if (
						d.chunk !== 0 ||
						typeof d.digest !== "string" ||
						!Array.isArray(d.limited) ||
						!d.limited.every((item) => typeof item === "string")
					)
						throw new Error("cache chunk");
					files.set(d.path, {
						path: d.path,
						ino: d.ino,
						dev: d.dev,
						size: d.size,
						mtime: d.mtime,
						parsedBytes: d.parsedBytes,
						digest: d.digest,
						header: d.header as Row,
						entries: d.entries as Row[],
						limited: d.limited,
					});
				}
			},
			limited,
			undefined,
			signal,
		);
		if (!matching || !complete || limited.size) files.clear();
	} catch {
		files.clear();
	}
	return files;
}

function sameSource(a: FileIndex, b: FileIndex): boolean {
	return a.ino === b.ino && a.dev === b.dev;
}

async function prefixDigest(file: FileIndex, size: number): Promise<string> {
	const fd = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const actual = await fd.stat({ bigint: true });
		if (String(actual.ino) !== file.ino || String(actual.dev) !== file.dev) throw new Error("Session replaced");
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(32768);
		for (let offset = 0; offset < size; ) {
			const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
			if (!bytesRead) throw new Error("Session truncated");
			hash.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await fd.close();
	}
}

async function commitCache(
	options: ActivityScanOptions,
	files: Map<string, FileIndex>,
	signal?: AbortSignal,
): Promise<boolean> {
	let release: (() => Promise<void>) | undefined;
	const temp = `${options.cachePath}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(options.cachePath), { recursive: true, mode: 0o700 });
		release = await lockfile.lock(options.cachePath, {
			realpath: false,
			stale: 5000,
			retries: { retries: 4, factor: 1, minTimeout: 50, maxTimeout: 50 },
		});
		signal?.throwIfAborted();
		const latest = await readCache(options, signal),
			current = await inventory(options.roots, signal);
		for (const [path, live] of current) {
			const candidate = files.get(path),
				previous = latest.get(path);
			if (
				!candidate ||
				!sameSource(candidate, live) ||
				live.size < candidate.size ||
				(live.size === candidate.size && live.mtime !== candidate.mtime) ||
				(previous && sameSource(previous, candidate) && previous.parsedBytes > candidate.parsedBytes)
			)
				return false;
			if (candidate.digest && (await prefixDigest(live, candidate.parsedBytes)) !== candidate.digest) return false;
		}
		for (const path of files.keys()) if (!current.has(path)) return false;
		const fd = await open(temp, "wx", 0o600);
		try {
			await fd.write(`${JSON.stringify({ type: "usage-cache-meta", data: { key: options.key, version: 1 } })}\n`);
			let bytes = 0;
			for (const file of files.values()) {
				signal?.throwIfAborted();
				let index = 0,
					chunk = 0;
				do {
					const selected: Row[] = [];
					let frameBytes = 0;
					while (index < file.entries.length && selected.length < 100) {
						const row = file.entries[index],
							rowBytes = Buffer.byteLength(JSON.stringify(row));
						if (selected.length && frameBytes + rowBytes > 96 * 1024) break;
						selected.push(row);
						index++;
						frameBytes += rowBytes;
					}
					const frame = { type: "usage-cache-file", data: { ...file, chunk: chunk++, entries: selected } };
					const line = `${JSON.stringify(frame)}\n`;
					bytes += Buffer.byteLength(line);
					if (bytes > 32 * 1024 * 1024) throw new Error("cache budget");
					await fd.write(line);
				} while (index < file.entries.length);
			}
			await fd.write(
				`${JSON.stringify({ type: "usage-cache-meta", data: { key: options.key, version: 1, complete: true } })}\n`,
			);
		} finally {
			await fd.close();
		}
		signal?.throwIfAborted();
		await rename(temp, options.cachePath);
		return true;
	} catch {
		return true; /* No disk cache is preferable to failing the read-only view. */
	} finally {
		await unlink(temp).catch(() => {});
		await release?.().catch(() => {});
	}
}

interface Origin {
	sessionId: string;
	cwd: string;
	role: "user" | "subagent";
}
function validID(id: unknown): id is string {
	return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id);
}

function buildOverview(
	options: ActivityScanOptions,
	files: Map<string, FileIndex>,
	limited: Set<string>,
): UsageOverview {
	const dateFormat = new Intl.DateTimeFormat("en-CA", {
		timeZone: options.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const dayKey = (time: unknown): string | undefined => {
		const d = new Date(typeof time === "number" || typeof time === "string" ? time : NaN);
		if (!Number.isFinite(d.getTime())) return undefined;
		const parts = dateFormat.formatToParts(d);
		return ["year", "month", "day"].map((k) => parts.find((p) => p.type === k)?.value).join("-");
	};
	const days = new Map(options.dates.map((date) => [date, { date, tokens: 0, chats: new Set<string>() }]));
	const dedup = new Set<string>(),
		chats = new Set<string>(),
		reasoning = new Map<string, number>(),
		skills = new Set<string>(),
		usedSkills = new Set<string>(),
		resources = new Map<string, Set<string>>();
	let coverage = false,
		unrecorded = false;
	let globalTokens = 0;
	const fileMetadata = new Map<
		FileIndex,
		{ cap?: Row; ids: Set<string>; manifests: Map<string, Origin>; owned: boolean }
	>();
	for (const file of files.values()) {
		const sessionId = file.header?.id,
			manifests = new Map<string, Origin>();
		let owned = false;
		for (const entry of file.entries)
			if (entry.customType === "step.usage_lineage") {
				const d = entry.data as Row;
				if (d?.version === 1 && d.sessionId === sessionId && d.origins && typeof d.origins === "object") {
					owned = true;
					for (const [id, raw] of Object.entries(d.origins)) {
						const source = raw as Origin;
						if (
							source &&
							validID(source.sessionId) &&
							typeof source.cwd === "string" &&
							["user", "subagent"].includes(source.role)
						)
							manifests.set(id, source);
					}
				}
			}
		fileMetadata.set(file, {
			cap: file.entries.find(
				(e) => e.customType === "step.activity_capabilities" && (e.data as Row)?.sessionId === sessionId,
			)?.data as Row | undefined,
			ids: new Set(file.entries.map((e) => String(e.id))),
			manifests,
			owned,
		});
	}
	const parents = new Map<string, FileIndex>();
	for (const file of files.values()) {
		parents.set(file.path, file);
		for (const alias of file.aliases ?? []) parents.set(alias, file);
	}
	const origins = new Map<string, Origin>(),
		resolving = new Set<string>();
	const originFor = (file: FileIndex, entryID: string): Origin => {
		const key = `${file.path}|${entryID}`,
			known = origins.get(key);
		if (known) return known;
		const header = file.header!,
			sessionId = String(header.id),
			cwd = typeof header.cwd === "string" ? header.cwd : "";
		const metadata = fileMetadata.get(file)!,
			cap = metadata.cap;
		const role =
			cap?.sessionRole === "subagent" || sessionId.startsWith("subagent-") || sessionId.startsWith("workflow-")
				? "subagent"
				: "user";
		let result: Origin = { sessionId, cwd: typeof cap?.parentCwd === "string" ? cap.parentCwd : cwd, role };
		if (resolving.has(key)) {
			limited.add("Lineage cycle");
			return result;
		}
		resolving.add(key);
		const source = metadata.manifests.get(entryID);
		if (source) {
			result = source;
			origins.set(key, result);
			resolving.delete(key);
			return result;
		}
		if (!metadata.owned && typeof header.parentSession === "string") {
			const parent = parents.get(resolve(header.parentSession));
			if (parent?.header && fileMetadata.get(parent)?.ids.has(entryID)) result = originFor(parent, entryID);
			else if (!parent) limited.add("Missing legacy lineage source");
		}
		origins.set(key, result);
		resolving.delete(key);
		return result;
	};
	const recordedSince = new Map<string, number>();
	for (const file of files.values())
		if (file.header && validID(file.header.id))
			for (const entry of file.entries)
				if (entry.customType === "step.activity_capabilities") {
					const d = entry.data as Row,
						time = Date.parse(String(entry.timestamp));
					if (d?.sessionId === originFor(file, String(entry.id)).sessionId && Number.isFinite(time))
						recordedSince.set(
							String(d.sessionId),
							Math.min(time, recordedSince.get(String(d.sessionId)) ?? Infinity),
						);
				}
	for (const file of files.values()) {
		if (!file.header || !validID(file.header.id)) {
			limited.add("Missing session identity");
			continue;
		}
		const levels = new Map<string, string>(),
			provenance = new Map<string, string>();
		for (const entry of file.entries)
			if (entry.customType === "step.usage_provenance") {
				const d = entry.data as Row;
				if (
					typeof d?.usageEntryId === "string" &&
					typeof d.reasoningAtDispatch === "string" &&
					d.originSessionId === originFor(file, d.usageEntryId).sessionId
				)
					provenance.set(d.usageEntryId, d.reasoningAtDispatch);
			}
		for (let index = 0; index < file.entries.length; index++) {
			const entry = file.entries[index],
				id = typeof entry.id === "string" ? entry.id : `legacy-${index}`,
				origin = originFor(file, id),
				key = `${origin.sessionId}|${id}`;
			if (options.scope === "project" && resolve(origin.cwd || ".") !== resolve(options.cwd)) continue;
			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string")
				levels.set(id, entry.thinkingLevel);
			else if (typeof entry.parentId === "string" && levels.has(entry.parentId))
				levels.set(id, levels.get(entry.parentId)!);
			const data = entry.data as Row | undefined,
				message = entry.message as Row | undefined;
			const date = dayKey(data?.startedAt ?? entry.timestamp ?? message?.timestamp),
				day = date ? days.get(date) : undefined;
			if (!day) continue;
			if (entry.customType === "step.activity_capabilities") {
				coverage = true;
				continue;
			}
			const picked = entryUsage(entry),
				usage = normalizeUsage(picked.raw);
			if (picked.expected && !usage) limited.add(picked.raw === undefined ? "Missing usage" : "Invalid usage");
			if (usage && !dedup.has(key)) {
				if (entry.customType === "step-auto-clm-usage" && data?.sessionId !== origin.sessionId) {
					limited.add("Usage origin conflict");
					continue;
				}
				if (!Number.isSafeInteger(globalTokens + usage.total)) {
					limited.add("Token sum exceeds exact numeric range");
					continue;
				}
				dedup.add(key);
				day.tokens += usage.total;
				globalTokens += usage.total;
				if (picked.assistant && origin.role === "user") {
					day.chats.add(origin.sessionId);
					chats.add(origin.sessionId);
				}
				if (picked.assistant) {
					const level = provenance.get(id) ?? levels.get(id) ?? "unknown";
					if (!provenance.has(id)) limited.add("Reasoning coverage is limited");
					reasoning.set(level, (reasoning.get(level) ?? 0) + 1);
				}
			}
			if (message?.role === "user" && origin.role === "user") {
				day.chats.add(origin.sessionId);
				chats.add(origin.sessionId);
			}
			if (
				entry.customType === "step.activity" &&
				data?.sessionId === origin.sessionId &&
				typeof data.runId === "string" &&
				typeof data.resourceId === "string" &&
				["skill", "plugin"].includes(String(data.kind))
			) {
				const run = `${origin.sessionId}|${data.runId}|${data.kind}|${data.resourceId}`,
					name = typeof data.name === "string" ? data.name : data.resourceId;
				if (data.kind === "skill" && data.stage === "discovered") skills.add(data.resourceId);
				else {
					if (data.kind === "skill") usedSkills.add(data.resourceId);
					const runs = resources.get(name) ?? new Set<string>();
					runs.add(run);
					resources.set(name, runs);
					if (typeof data.pluginId === "string") {
						const plugins = resources.get(`@${data.pluginId}`) ?? new Set<string>();
						plugins.add(`${origin.sessionId}|${data.runId}|plugin|${data.pluginId}`);
						resources.set(`@${data.pluginId}`, plugins);
					}
				}
			}
			if (
				picked.assistant &&
				Date.parse(String(entry.timestamp)) < (recordedSince.get(origin.sessionId) ?? Infinity)
			)
				unrecorded = true;
		}
	}
	if (unrecorded) limited.add("Older sessions did not record activity");
	const result = Array.from(days.values(), (day) => ({ date: day.date, tokens: day.tokens, chats: day.chats.size }));
	return {
		days: result,
		tokens: globalTokens,
		chats: chats.size,
		activeDays: result.filter((d) => d.tokens > 0 || d.chats > 0).length,
		reasoning: Array.from(reasoning).sort((a, b) => b[1] - a[1]),
		discoveredSkills: coverage && (!unrecorded || skills.size > 0) ? skills.size : null,
		usedSkills: coverage && (!unrecorded || usedSkills.size > 0) ? usedSkills.size : null,
		topResources: Array.from(resources, ([name, runs]) => [name, runs.size] as [string, number])
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 8),
		limited: Array.from(limited),
		scope: options.scope,
	};
}

export async function scanActivity(options: ActivityScanOptions, signal?: AbortSignal): Promise<UsageOverview> {
	for (let attempt = 0; attempt < 2; attempt++) {
		signal?.throwIfAborted();
		const limited = new Set<string>(),
			files = await inventory(options.roots, signal),
			cached = await readCache(options, signal);
		let entries = 0,
			changed = files.size !== cached.size;
		if (files.limited) limited.add("File inventory budget exceeded");
		for (const file of files.values()) {
			signal?.throwIfAborted();
			const old = cached.get(file.path);
			let reusable =
				old &&
				!!old.digest &&
				sameSource(old, file) &&
				file.size >= old.size &&
				(file.size > old.size || file.mtime === old.mtime);
			if (reusable && old && file.size > old.size) {
				try {
					reusable = (await prefixDigest(file, old.parsedBytes)) === old.digest;
				} catch {
					reusable = false;
				}
			}
			if (!reusable || old?.size !== file.size || old?.mtime !== file.mtime) changed = true;
			if (reusable && old) {
				file.header = old.header;
				file.entries = old.entries;
				file.parsedBytes = old.parsedBytes;
				file.digest = old.digest;
				file.limited = old.limited.filter((reason) => reason !== "Incomplete trailing records");
			}
			const fileLimited = new Set(file.limited);
			entries += file.entries.length;
			if (entries >= MAX_ENTRIES) {
				file.limited.push("Record inventory budget exceeded");
				for (const reason of file.limited) limited.add(reason);
				continue;
			}
			if (reusable && old && old.size === file.size && old.mtime === file.mtime && old.parsedBytes === old.size) {
				for (const reason of file.limited) limited.add(reason);
				continue;
			}
			try {
				file.parsedBytes = await readLines(
					file.path,
					file.parsedBytes,
					file.size,
					(row) => {
						if (row.type === "session") file.header = row;
						else if (
							row.type === "thinking_level_change" ||
							row.type === "message" ||
							entryUsage(row).expected ||
							(row.type === "custom" &&
								[
									"step.activity",
									"step.activity_capabilities",
									"step.usage_lineage",
									"step.usage_provenance",
								].includes(String(row.customType)))
						) {
							if (entries < MAX_ENTRIES) {
								file.entries.push(row);
								entries++;
							} else fileLimited.add("Record inventory budget exceeded");
						}
					},
					fileLimited,
					file,
					signal,
				);
			} catch {
				fileLimited.add("Unreadable sessions");
			}
			file.limited = Array.from(fileLimited);
			for (const reason of file.limited) limited.add(reason);
		}
		signal?.throwIfAborted();
		if (changed && !(await commitCache(options, files, signal))) continue;
		signal?.throwIfAborted();
		return buildOverview(options, files, limited);
	}
	throw new Error("Activity changed during scanning; retry the view.");
}

export function activityCacheKey(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
