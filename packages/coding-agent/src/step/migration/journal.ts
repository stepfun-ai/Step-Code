import { randomUUID } from "node:crypto";
import { readdirSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isMigrationDiagnosticCode } from "./diagnostics.ts";
import { durableWrite, fail, hash, info, privateDir, record, safePath, stable, syncDir, text } from "./filesystem.ts";
import type {
	LegacyMigrationKind,
	MigrationItemResult,
	MigrationJob,
	MigrationLocation,
	MigrationScope,
} from "./types.ts";

export interface WriteIntent {
	itemId: string;
	path: string;
	before: string | null;
	after: string;
	backup?: string;
	sessionId?: string;
	/** Verified reservation metadata, independent of the legacy result's requested cwd. */
	actualScope?: MigrationScope;
	committed: boolean;
	/** Identity of the published rule file; equal bytes in a replacement are not the reviewed target. */
	targetIdentity?: string;
	restored?: boolean;
	recovery?: { before: string; after: string; committed: boolean };
}
export interface Journal {
	version: 1;
	key: string;
	digest: string;
	job: MigrationJob;
	intents: WriteIntent[];
	/** Project identities pinned by reviewed items before any publication intent is written. */
	projectIdentities?: Record<string, string>;
}
const held = new Set<string>();
const idPattern = /^[a-f0-9-]{36}$/u;
export function validId(value: unknown): value is string {
	return typeof value === "string" && idPattern.test(value);
}
function string(value: unknown): string {
	if (typeof value !== "string" || value.length > 8192) fail("invalid-journal");
	return value;
}
function scope(value: unknown): MigrationScope {
	const r = record(value);
	if (r.kind === "global") return { kind: "global" };
	if (r.kind === "project") return { kind: "project", cwd: string(r.cwd) };
	return fail("invalid-journal");
}
function actualSessionScope(value: unknown): MigrationScope | undefined {
	if (value === undefined) return undefined;
	const result = scope(value);
	if (result.kind !== "project" || !isAbsolute(result.cwd) || result.cwd.includes("\0")) fail("invalid-journal");
	return result;
}
function location(value: unknown): MigrationLocation {
	const r = record(value);
	return { scope: scope(r.scope), path: string(r.path), name: string(r.name) };
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) fail("invalid-journal");
	return value as T;
}
function identity(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^\d+:\d+:\d+(?:\.\d+)?$/u.test(value)) fail("invalid-journal");
	return value;
}
function parseJournal(raw: string): Journal {
	try {
		const r = record(JSON.parse(raw));
		const j = record(r.job);
		if (
			r.version !== 1 ||
			!validId(j.id) ||
			!Array.isArray(j.items) ||
			j.items.length > 2000 ||
			!Array.isArray(r.intents) ||
			r.intents.length > 2000 ||
			typeof j.revision !== "number"
		)
			fail("invalid-journal");
		const items: MigrationItemResult[] = j.items.map((value) => {
			const item = record(value);
			if (!validId(item.id) || !Array.isArray(item.diagnostics)) fail("invalid-journal");
			return {
				id: item.id,
				candidateId: string(item.candidateId),
				kind: member(item.kind, ["sessions", "skills", "mcp", "prompts", "rules"]) as LegacyMigrationKind,
				source: member(item.source, ["codex", "claude-code", "workbuddy", "qoder", "shared", "stepcode", "plugin"]),
				name: string(item.name),
				sourceScope: scope(item.sourceScope),
				requestedTarget: location(item.requestedTarget),
				actualTarget: item.actualTarget === undefined ? undefined : location(item.actualTarget),
				action: member(item.action, ["copy", "import", "create", "append", "replace", "skip"]),
				status: member(item.status, ["pending", "running", "imported", "skipped", "failed", "not-run"]),
				activation: member(item.activation, ["history", "disabled", "next-resource-load", "unchanged"]),
				diagnostics: item.diagnostics.map((d) => {
					const code = record(d).code;
					if (!isMigrationDiagnosticCode(code)) fail("invalid-journal");
					return { code };
				}),
				sessionId: item.sessionId === undefined ? undefined : string(item.sessionId),
				backupId: item.backupId === undefined ? undefined : string(item.backupId),
			};
		});
		const intents = r.intents.map((value) => {
			const i = record(value);
			if (!validId(i.itemId) || typeof i.committed !== "boolean") fail("invalid-journal");
			return {
				itemId: i.itemId,
				path: string(i.path),
				before: i.before === null ? null : string(i.before),
				after: string(i.after),
				committed: i.committed,
				targetIdentity: identity(i.targetIdentity),
				backup: i.backup === undefined ? undefined : string(i.backup),
				sessionId: i.sessionId === undefined ? undefined : string(i.sessionId),
				actualScope: actualSessionScope(i.actualScope),
				restored: i.restored === true,
				recovery:
					i.recovery === undefined
						? undefined
						: {
								before: string(record(i.recovery).before),
								after: string(record(i.recovery).after),
								committed: record(i.recovery).committed === true,
							},
			};
		});
		const projectIdentities = r.projectIdentities === undefined ? undefined : record(r.projectIdentities);
		if (
			projectIdentities &&
			(Object.keys(projectIdentities).length > 2000 ||
				Object.entries(projectIdentities).some(
					([id, value]) =>
						!validId(id) ||
						identity(value) === undefined ||
						!items.some((item) => item.id === id && item.requestedTarget.scope.kind === "project"),
				))
		)
			fail("invalid-journal");
		return {
			version: 1,
			projectIdentities:
				projectIdentities === undefined
					? undefined
					: Object.fromEntries(Object.entries(projectIdentities).map(([id, value]) => [id, identity(value)!])),
			key: string(r.key),
			digest: string(r.digest),
			intents,
			job: {
				id: j.id,
				revision: j.revision,
				createdAt: string(j.createdAt),
				status: member(j.status, ["queued", "running", "stopping", "completed", "cancelled", "interrupted"]),
				items,
			},
		};
	} catch {
		return fail("invalid-journal");
	}
}

export class MigrationJournalStore {
	readonly root: string;
	private readonly revisions = new Map<string, string>();
	private activeOwner?: string;
	constructor(agent: string) {
		this.root = join(agent, "migration");
	}
	hasLiveLock(): boolean {
		if (held.has(this.root)) return true;
		const raw = text(join(this.root, "active.lock"), true);
		if (raw === undefined) return false;
		try {
			const pid = record(JSON.parse(raw)).pid;
			if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return true;
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return !(error instanceof Error && "code" in error && error.code === "ESRCH");
			}
		} catch {
			return true;
		}
	}
	read(): Journal[] {
		if (!info(this.root)) return [];
		safePath(this.root);
		const entries = readdirSync(this.root);
		if (entries.length > 5000) fail("journal-limit");
		return entries
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				if (!validId(name.slice(0, -5))) fail("invalid-journal");
				const path = join(this.root, name);
				const raw = text(path)!;
				const journal = parseJournal(raw);
				if (!held.has(this.root) || !this.revisions.has(path)) this.revisions.set(path, hash(raw));
				if (`${journal.job.id}.json` !== name) fail("invalid-journal");
				return journal;
			});
	}
	write(journal: Journal): void {
		if (!this.activeOwner || text(join(this.root, "active.lock"), true) !== this.activeOwner)
			fail("migration-lock-lost", 409);
		privateDir(this.root, true);
		const target = join(this.root, `${journal.job.id}.json`);
		const current = text(target, true);
		const expected = this.revisions.get(target);
		if ((current === undefined ? undefined : hash(current)) !== expected) fail("journal-changed", 409);
		const temporary = join(this.root, `.${randomUUID()}.tmp`);
		const serialized = stable(journal);
		durableWrite(temporary, serialized);
		safePath(target);
		if (text(target, true) !== current) fail("journal-changed", 409);
		renameSync(temporary, target);
		syncDir(this.root);
		this.revisions.set(target, hash(serialized));
	}
	lock(): () => void {
		if (held.has(this.root)) fail("migration-busy", 409);
		privateDir(this.root, true);
		const path = join(this.root, "active.lock");
		const owner = stable({ pid: process.pid, token: randomUUID() });
		if (info(path)) {
			const previous = text(path)!;
			let pid: unknown;
			try {
				pid = record(JSON.parse(previous)).pid;
			} catch {
				return fail("migration-lock-invalid", 409);
			}
			if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) fail("migration-lock-invalid", 409);
			let dead = false;
			try {
				process.kill(pid, 0);
			} catch (error) {
				dead = error instanceof Error && "code" in error && error.code === "ESRCH";
			}
			if (!dead || text(path) !== previous) fail("migration-busy", 409);
			unlinkSync(path);
		}
		try {
			durableWrite(path, owner);
		} catch {
			return fail("migration-busy", 409);
		}
		held.add(this.root);
		this.activeOwner = owner;
		return () => {
			held.delete(this.root);
			this.activeOwner = undefined;
			if (text(path, true) !== owner) fail("migration-lock-lost", 409);
			unlinkSync(path);
			syncDir(this.root);
		};
	}
	backupPath(id: string): string {
		if (!validId(id)) fail("invalid-backup");
		return join(this.root, "backups", id);
	}
	backup(id: string, content: Buffer): void {
		const dir = join(this.root, "backups");
		privateDir(dir, true);
		durableWrite(this.backupPath(id), content);
		syncDir(dir);
	}
}
