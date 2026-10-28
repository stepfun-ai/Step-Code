import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { ReservedSessionImports, SessionImportService } from "../../core/session-import/service.ts";
import { acquireSettingsLockSync } from "../../core/settings-manager.ts";
import {
	anchor,
	bytes,
	diagnosticCode,
	durableWrite,
	fail,
	hash,
	info,
	inside,
	MigrationError,
	privateDir,
	record,
	safePath,
	stable,
	syncDir,
	text,
} from "./filesystem.ts";
import { type Journal, MigrationJournalStore, validId, type WriteIntent } from "./journal.ts";
import { MigrationPaths, resourceName } from "./paths.ts";
import { PREVIEW_TTL, type PreparedMigration, prepareResource } from "./preview.ts";
import { type ResourceCandidate, ResourceInspector } from "./resources.ts";
import { ruleImpact } from "./rules.ts";
import type {
	MigrationAcknowledgement,
	MigrationJob,
	MigrationKind,
	MigrationPlan,
	MigrationPreview,
	MigrationPreviewRequest,
	MigrationRecoveryPreview,
	MigrationScanRequest,
	MigrationScanResult,
	MigrationSelection,
	MigrationStartRequest,
} from "./types.ts";
import { currentHash, publishResource } from "./writer.ts";

export { MigrationError } from "./filesystem.ts";

const KINDS: MigrationKind[] = ["sessions", "skills", "mcp", "prompts", "rules"];
const ACKS: MigrationAcknowledgement[] = ["rules-impact", "scope-expansion", "independent-copy", "sensitive-values"];
interface StoredPlan {
	dto: MigrationPlan;
	prepared: PreparedMigration[];
}
interface Recovery {
	dto: MigrationRecoveryPreview;
	targetIdentity: string;
	currentHash: string;
	backupHash: string;
	fingerprint: string;
}

/** Offline migration coordinator. It never owns the injected session service's lifecycle. */
export class MigrationService {
	private readonly paths: MigrationPaths;
	private readonly inspector: ResourceInspector;
	private readonly sessions: SessionImportService;
	private readonly store: MigrationJournalStore;
	private records: ResourceCandidate[] = [];
	private readonly candidates = new Map<string, ResourceCandidate>();
	private readonly sessionCandidates = new Set<string>();
	private readonly previews = new Map<string, PreparedMigration>();
	private readonly plans = new Map<string, StoredPlan>();
	private readonly journals = new Map<string, Journal>();
	private readonly recoveries = new Map<string, Recovery>();
	private closed = false;
	private running?: Promise<void>;
	private active?: Journal;
	private starting = false;
	private preparation?: Promise<void>;
	private stopping = false;

	constructor(options: { agentDir: string; env?: NodeJS.ProcessEnv; sessions: SessionImportService }) {
		this.paths = new MigrationPaths(options.agentDir, options.env ?? process.env);
		this.inspector = new ResourceInspector(this.paths);
		this.sessions = options.sessions;
		this.store = new MigrationJournalStore(this.paths.agent);
		this.loadJournals();
	}
	private open(): void {
		if (this.closed) fail("migration-closed", 503);
	}
	private loadJournals(ownsLock = false): void {
		for (const journal of this.store.read()) {
			if (journal.job.id === this.active?.job.id) continue;
			if (
				(ownsLock || !this.store.hasLiveLock()) &&
				["queued", "running", "stopping"].includes(journal.job.status)
			) {
				journal.job.status = "interrupted";
				for (const item of journal.job.items) {
					if (!["pending", "running"].includes(item.status)) continue;
					const intent = journal.intents.find((i) => i.itemId === item.id);
					item.status = "not-run";
					if (!intent) continue;
					try {
						this.validateJournalTarget(journal, item.id);
						if (
							currentHash(
								intent.path,
								item.kind === "skills",
								item.kind === "sessions" ? 128 * 1024 * 1024 : undefined,
							) === intent.after
						) {
							if (item.kind === "sessions" && !intent.actualScope) fail("publication-uncertain");
							item.status = "imported";
							item.actualTarget = {
								...item.requestedTarget,
								scope: intent.actualScope ?? item.requestedTarget.scope,
								path: intent.path,
							};
							item.sessionId = intent.sessionId;
							item.backupId = intent.backup;
							item.diagnostics.push({ code: "publication-reconciled" });
						} else {
							item.status = "failed";
							item.diagnostics.push({ code: "publication-uncertain" });
						}
					} catch {
						item.status = "failed";
						item.diagnostics.push({ code: "publication-uncertain" });
					}
				}
			}
			if (ownsLock || !this.store.hasLiveLock()) {
				for (const intent of journal.intents) {
					if (!intent.recovery || intent.recovery.committed) continue;
					journal.job.status = "interrupted";
					const item = journal.job.items.find((i) => i.id === intent.itemId);
					if (!item) fail("invalid-journal");
					try {
						this.validateJournalTarget(journal, item.id);
						const current = currentHash(intent.path);
						if (current === intent.recovery.after) {
							intent.restored = true;
							intent.recovery.committed = true;
							item.diagnostics.push({ code: "recovery-reconciled" });
						} else
							item.diagnostics.push({
								code:
									current === intent.recovery.before ? "recovery-not-applied" : "recovery-outcome-uncertain",
							});
					} catch {
						item.diagnostics.push({ code: "recovery-outcome-uncertain" });
					}
				}
			}
			this.journals.set(journal.job.id, journal);
		}
	}

	async scan(input: MigrationScanRequest = {}): Promise<MigrationScanResult> {
		this.open();
		const r = record(input);
		if (r.kinds !== undefined && (!Array.isArray(r.kinds) || r.kinds.some((k) => !KINDS.includes(k))))
			fail("invalid-kinds");
		this.paths.chooseProjects(r.projectCwds);
		const kinds = input.kinds ?? KINDS;
		const resource = this.inspector.scan(kinds);
		for (const [id, item] of this.candidates) if (kinds.includes(item.dto.kind)) this.candidates.delete(id);
		this.records = resource.records;
		for (const item of this.records) this.candidates.set(item.dto.id, item);
		if (kinds.includes("sessions")) {
			const result = await this.sessions
				.scan({
					claudeRoot: join(this.paths.claude, "projects"),
					codexRoot: this.paths.codex,
					workbuddyRoot: join(this.paths.home, ".workbuddy", "projects"),
					qoderRoot: join(this.paths.home, ".qoder", "projects"),
				})
				.catch(() => fail("session-scan-failed", 409));
			this.open();
			this.sessionCandidates.clear();
			for (const item of result.candidates) {
				this.sessionCandidates.add(item.id);
				resource.result.candidates.push({
					id: item.id,
					kind: "sessions",
					source: item.source,
					name: item.title,
					sourcePath: item.sourcePath ?? "",
					sourceScope: item.cwd ? { kind: "project", cwd: item.cwd } : { kind: "global" },
					holding: "external",
					readiness: "ready",
					needsMigration: true,
					diagnostics: [],
					modified: item.modified,
					sourceSessionId: item.sessionId,
				});
			}
			const roots = {
				"claude-code": join(this.paths.claude, "projects"),
				codex: this.paths.codex,
				workbuddy: join(this.paths.home, ".workbuddy", "projects"),
				qoder: join(this.paths.home, ".qoder", "projects"),
			};
			for (const [source, path] of Object.entries(roots)) {
				const error = result.errors.some((e) => e.source === source);
				const exists = result.roots[source as keyof typeof roots] !== undefined;
				resource.result.sources.push({
					kind: "sessions",
					source: source as keyof typeof roots,
					scope: { kind: "global" },
					path,
					status: error
						? "error"
						: !exists
							? "missing"
							: result.candidates.some((c) => c.source === source)
								? "ok"
								: "empty",
					diagnostics: error ? [{ code: "session-source-read-error" }] : [],
				});
			}
		}
		return structuredClone(resource.result);
	}

	async preview(input: MigrationPreviewRequest): Promise<MigrationPreview> {
		this.open();
		const r = record(input);
		if (
			typeof r.candidateId !== "string" ||
			(r.includeSensitiveValues !== undefined && typeof r.includeSensitiveValues !== "boolean") ||
			(r.action !== undefined &&
				!["copy", "import", "create", "append", "replace", "skip"].includes(String(r.action)))
		)
			fail("invalid-preview-request");
		this.paths.chooseTarget(input.target);
		let prepared: PreparedMigration;
		if (this.sessionCandidates.has(input.candidateId)) prepared = await this.prepareSession(input);
		else {
			const known = this.candidates.get(input.candidateId);
			if (!known) fail("candidate-not-found", 404);
			const fresh = this.inspector.scan([known.dto.kind]);
			const item = fresh.records.find((c) => c.dto.id === input.candidateId);
			if (!item) fail("source-changed", 409);
			prepared = prepareResource(this.paths, item, input, fresh.records);
		}
		this.open();
		this.expireCaches();
		const weight = (p: PreparedMigration): number =>
			p.files.reduce((sum, file) => sum + file.data.length, 0) + 3 * (p.dto.sourceText.length + p.result.length);
		if (
			this.previews.size >= 500 ||
			[...this.previews.values()].reduce((sum, p) => sum + weight(p), weight(prepared)) > 128 * 1024 * 1024
		)
			fail("preview-limit", 429);
		this.previews.set(prepared.dto.id, prepared);
		return structuredClone(prepared.dto);
	}

	private async prepareSession(input: MigrationPreviewRequest): Promise<PreparedMigration> {
		const preview = await this.sessions.preview(input.candidateId).catch(() => fail("session-preview-failed", 409));
		const scope = this.paths.scope(input.target);
		if (scope.kind !== "project") fail("session-project-required");
		if (input.action !== undefined && !["import", "skip"].includes(input.action)) fail("unsupported-action");
		const action = input.action ?? "import";
		const dto: MigrationPreview = {
			id: randomUUID(),
			fingerprint: hash(
				stable({
					fingerprint: preview.fingerprint,
					cwd: scope.cwd,
					projectIdentity: this.paths.projectIdentity(scope),
					action,
				}),
			),
			expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString(),
			candidate: {
				id: preview.id,
				kind: "sessions",
				source: preview.source,
				name: preview.title,
				sourcePath: preview.sourcePath ?? "",
				sourceScope: preview.cwd ? { kind: "project", cwd: preview.cwd } : { kind: "global" },
				holding: "external",
				readiness: "ready",
				needsMigration: true,
				diagnostics: [],
				sourceSessionId: preview.sessionId,
			},
			target: {
				scope,
				path: this.paths.env.STEP_CODING_AGENT_SESSION_DIR || join(this.paths.agent, "sessions"),
				name: preview.title,
			},
			action,
			allowedActions: ["import", "skip"],
			sourceText: preview.excerpt,
			requiredAcknowledgements: [],
			blockers: [],
			warnings: preview.warnings,
			activation: action === "skip" ? "unchanged" : "history",
		};
		return {
			dto,
			request: structuredClone(input),
			session: { candidateId: preview.id, fingerprint: preview.fingerprint, cwd: scope.cwd },
			sourceHash: preview.fingerprint,
			targetHash: null,
			projectIdentity: this.paths.projectIdentity(scope),
			files: [],
			result: "",
		};
	}

	private expireCaches(): void {
		for (const [id, p] of this.previews) if (Date.parse(p.dto.expiresAt) < Date.now()) this.previews.delete(id);
		for (const [id, p] of this.plans) if (Date.parse(p.dto.expiresAt) < Date.now()) this.plans.delete(id);
		for (const [id, p] of this.recoveries) if (Date.parse(p.dto.expiresAt) < Date.now()) this.recoveries.delete(id);
	}
	private acknowledgements(value: unknown): MigrationAcknowledgement[] {
		if (!Array.isArray(value) || value.some((v) => !ACKS.includes(v))) fail("invalid-acknowledgements");
		return value;
	}
	private async revalidate(
		prepared: PreparedMigration,
		publishedSkills: ReadonlyMap<string, string> = new Map(),
	): Promise<void> {
		// Only byte-verified publications from this batch may be removed from the reviewed destination view.
		for (const [path, expected] of publishedSkills)
			if (currentHash(dirname(path), true) !== expected) fail("target-changed", 409);
		if (Date.parse(prepared.dto.expiresAt) < Date.now()) fail("preview-expired", 409);
		if (this.paths.projectIdentity(prepared.dto.target.scope) !== prepared.projectIdentity)
			fail("invalid-projects", 409);
		if (prepared.session) {
			this.paths.scope(prepared.request.target);
			return; // reserve() pins and validates the original reviewed snapshot before any write.
		}
		const current = this.inspector.scan([prepared.dto.candidate.kind]);
		const item = current.records.find((c) => c.dto.id === prepared.dto.candidate.id);
		if (
			!item ||
			prepareResource(this.paths, item, prepared.request, current.records, new Set(publishedSkills.keys())).dto
				.fingerprint !== prepared.dto.fingerprint
		)
			fail("preview-changed", 409);
	}

	async plan(selections: MigrationSelection[]): Promise<MigrationPlan> {
		this.open();
		if (!Array.isArray(selections) || !selections.length || selections.length > 200) fail("invalid-selections");
		const prepared: PreparedMigration[] = [];
		const targets = new Set<string>();
		let ruleWrites = 0;
		for (const value of selections) {
			const selection = record(value);
			const p = typeof selection.previewId === "string" ? this.previews.get(selection.previewId) : undefined;
			if (!p) fail("preview-not-found", 404);
			const acknowledged = this.acknowledgements(selection.acknowledged);
			if (p.dto.blockers.length) fail("migration-blocked", 409);
			if (p.dto.requiredAcknowledgements.some((ack) => !acknowledged.includes(ack)))
				fail("acknowledgement-required");
			if (prepared.includes(p)) fail("duplicate-selection");
			if (p.dto.action !== "skip") {
				const target = `${p.dto.target.path}\0${p.mcp ? p.dto.target.name : p.session ? p.session.candidateId : ""}`;
				if (targets.has(target)) fail("batch-target-conflict", 409);
				targets.add(target);
				if (p.dto.candidate.kind === "rules" && ++ruleWrites > 1) fail("rule-batch-impact-conflict", 409);
			}
			await this.revalidate(p);
			prepared.push(p);
		}
		this.open();
		this.expireCaches();
		if (this.plans.size >= 100) fail("plan-limit", 429);
		const dto: MigrationPlan = {
			id: randomUUID(),
			digest: hash(stable(prepared.map((p) => [p.dto.id, p.dto.fingerprint]))),
			expiresAt: new Date(Math.min(...prepared.map((p) => Date.parse(p.dto.expiresAt)))).toISOString(),
			items: prepared.map((p) => p.dto),
		};
		this.plans.set(dto.id, { dto, prepared });
		return structuredClone(dto);
	}

	async start(input: MigrationStartRequest): Promise<MigrationJob> {
		this.open();
		const r = record(input);
		if (
			typeof r.idempotencyKey !== "string" ||
			!/^[a-zA-Z0-9_-]{1,128}$/u.test(r.idempotencyKey) ||
			typeof r.planId !== "string" ||
			typeof r.digest !== "string"
		)
			fail("invalid-start-request");
		const key = hash(r.idempotencyKey);
		this.loadJournals();
		const previous = [...this.journals.values()].find((j) => j.key === key);
		if (previous) {
			if (previous.digest !== input.digest) fail("idempotency-conflict", 409);
			return structuredClone(previous.job);
		}
		if (this.starting || this.running) fail("migration-busy", 409);
		const plan = this.plans.get(input.planId);
		if (!plan || plan.dto.digest !== input.digest) fail("plan-not-found", 404);
		if (Date.parse(plan.dto.expiresAt) < Date.now()) fail("plan-expired", 409);
		this.starting = true;
		let settlePreparation!: () => void;
		this.preparation = new Promise<void>((resolve) => {
			settlePreparation = resolve;
		});
		let release: (() => void) | undefined;
		let reserved: ReservedSessionImports | undefined;
		try {
			const selections = plan.prepared.flatMap((p) => (p.session && p.dto.action !== "skip" ? [p.session] : []));
			reserved = selections.length ? await this.sessions.reserve(selections) : { items: [], async release() {} };
			this.open();
			for (const p of plan.prepared) await this.revalidate(p);
			release = this.store.lock();
			this.loadJournals(true);
			const raced = [...this.journals.values()].find((j) => j.key === key);
			if (raced) {
				if (raced.digest !== input.digest) fail("idempotency-conflict", 409);
				return structuredClone(raced.job);
			}
			// Reserve every session first, then recheck every resource/consent as one batch before journaling or publication.
			for (const p of plan.prepared) await this.revalidate(p);
			this.open();
			const job: MigrationJob = {
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				revision: 0,
				status: "queued",
				items: plan.prepared.map((p) => ({
					id: p.dto.id,
					candidateId: p.dto.candidate.id,
					kind: p.dto.candidate.kind,
					source: p.dto.candidate.source,
					name: p.dto.candidate.name,
					sourceScope: p.dto.candidate.sourceScope,
					requestedTarget: p.dto.target,
					action: p.dto.action,
					status: "pending",
					diagnostics: [],
					activation: p.dto.activation,
				})),
			};
			const journal: Journal = {
				version: 1,
				key,
				digest: input.digest,
				job,
				intents: [],
				projectIdentities: Object.fromEntries(
					plan.prepared.flatMap((p, index) =>
						p.projectIdentity ? [[job.items[index]!.id, p.projectIdentity]] : [],
					),
				),
			};
			this.store.write(journal);
			this.journals.set(job.id, journal);
			this.active = journal;
			this.stopping = false;
			const ownedRelease = release;
			const ownedReserved = reserved;
			release = undefined;
			reserved = undefined;
			this.running = this.execute(journal, plan.prepared, ownedReserved).finally(async () => {
				try {
					await ownedReserved.release();
				} finally {
					try {
						ownedRelease();
					} finally {
						this.running = undefined;
						this.active = undefined;
					}
				}
			});
			// Observe finalizer failures without abandoning cleanup or publishing an unhandled rejection.
			this.running.catch(() => {
				journal.job.status = "interrupted";
			});
			return structuredClone(job);
		} catch (error) {
			if (error instanceof MigrationError) throw error;
			throw new MigrationError("session-reservation-failed", 409);
		} finally {
			try {
				await reserved?.release();
			} finally {
				try {
					release?.();
				} finally {
					this.starting = false;
					settlePreparation();
					this.preparation = undefined;
				}
			}
		}
	}

	private async execute(
		journal: Journal,
		prepared: PreparedMigration[],
		reserved: ReservedSessionImports,
	): Promise<void> {
		const ownConfigHashes = new Map<string, string>();
		const publishedSkills = new Map<string, string>();
		let failed = false;
		try {
			await yieldTurn();
			journal.job.status = "running";
			this.persist(journal);
			for (let index = 0; index < prepared.length; index++) {
				const p = prepared[index]!;
				const item = journal.job.items[index]!;
				if (this.closed || this.stopping || failed) {
					item.status = "not-run";
					continue;
				}
				if (p.dto.action === "skip") {
					item.status = "skipped";
					item.activation = "unchanged";
					this.persist(journal);
					continue;
				}
				item.status = "running";
				this.persist(journal);
				try {
					if (p.session) {
						await this.revalidate(p);
						const session = reserved.items.find((s) => s.candidate.id === p.session!.candidateId);
						if (!session) fail("session-reservation-missing");
						const intent: WriteIntent = {
							itemId: item.id,
							actualScope: { kind: "project", cwd: session.existing?.cwd ?? session.cwd },
							path: anchor(session.existing?.path ?? session.path),
							before: session.existing ? session.fingerprint : null,
							after: session.fingerprint,
							sessionId: session.existing?.sessionId ?? basename(session.path, ".jsonl"),
							committed: false,
						};
						journal.intents.push(intent);
						this.persist(journal);
						const result = await session.publish();
						if (result.status === "failed") fail("session-publication-failed");
						item.status = result.status;
						if (result.warning) item.diagnostics.push({ code: "session-publication-warning" });
						item.sessionId = result.sessionId;
						item.actualTarget = {
							scope: { kind: "project", cwd: session.existing?.cwd ?? session.cwd },
							path: anchor(session.existing?.path ?? result.path ?? session.path),
							name: p.dto.target.name,
						};
						intent.actualScope = item.actualTarget.scope;
						intent.path = item.actualTarget.path;
						intent.sessionId = result.sessionId ?? intent.sessionId;
						if (result.status === "skipped")
							intent.after =
								currentHash(item.actualTarget.path, false, 128 * 1024 * 1024) ??
								fail("publication-uncertain", 409);
						intent.committed = true;
					} else {
						if (p.dto.candidate.kind !== "mcp") await this.revalidate(p, publishedSkills);
						const intent = publishResource(
							p,
							journal,
							this.store,
							this.paths,
							ownConfigHashes.get(p.dto.target.path) ?? p.targetHash,
						);
						intent.committed = true;
						if (p.dto.candidate.kind === "rules" && intent.backup)
							intent.targetIdentity = this.ruleTargetIdentity(intent.path);
						item.status = "imported";
						item.actualTarget = p.dto.target;
						item.backupId = intent.backup;
						if (p.dto.candidate.kind === "skills")
							publishedSkills.set(join(p.dto.target.path, "SKILL.md"), intent.after);
						if (p.mcp) ownConfigHashes.set(p.dto.target.path, intent.after);
					}
					this.persist(journal);
				} catch (error) {
					item.status = "failed";
					item.diagnostics.push({ code: diagnosticCode(error) });
					// A failed or uncertain unit never triggers automatic retry or rollback. Stop the remaining batch.
					failed = true;
					this.persist(journal);
				}
				await yieldTurn();
			}
			journal.job.status = this.closed || this.stopping ? "cancelled" : "completed";
			this.persist(journal);
		} catch {
			journal.job.status = "interrupted";
			for (const item of journal.job.items)
				if (["pending", "running"].includes(item.status)) {
					item.status = "not-run";
					item.diagnostics.push({ code: "journal-write-failed" });
				}
			// The last durable intent remains available for next-start reconciliation; do not claim a durable outcome.
		}
	}
	private persist(journal: Journal): void {
		journal.job.revision++;
		this.store.write(journal);
	}
	listJobs(): MigrationJob[] {
		this.loadJournals();
		return [...this.journals.values()].map((j) => structuredClone(j.job));
	}
	getJob(id: string): MigrationJob {
		if (id !== this.active?.job.id) this.loadJournals();
		const journal = this.journals.get(id);
		if (!journal) fail("job-not-found", 404);
		return structuredClone(journal.job);
	}
	cancel(id: string): MigrationJob {
		this.open();
		const journal = this.journals.get(id);
		if (!journal) fail("job-not-found", 404);
		if (journal === this.active && ["queued", "running", "stopping"].includes(journal.job.status)) {
			this.stopping = true;
			journal.job.status = "stopping";
			this.persist(journal);
		}
		return structuredClone(journal.job);
	}
	/** Stop scheduling, then await the currently owned publication and release its reservations. */
	async close(): Promise<void> {
		this.closed = true;
		this.stopping = true;
		await this.preparation;
		await this.running;
	}

	private validateJournalTarget(journal: Journal, itemId: string): void {
		const item = journal.job.items.find((i) => i.id === itemId);
		const intent = journal.intents.find((i) => i.itemId === itemId);
		if (!item || !intent) fail("recovery-unavailable", 404);
		const scope = item.requestedTarget.scope;
		if (scope.kind === "project" && item.kind !== "sessions")
			this.paths.validateRecordedProject(scope, journal.projectIdentities?.[item.id]);
		const expected =
			item.kind === "rules"
				? join(scope.kind === "global" ? this.paths.agent : scope.cwd, "AGENTS.md")
				: item.kind === "mcp"
					? this.paths.config
					: item.kind === "sessions"
						? item.requestedTarget.path
						: join(
								this.paths.resourceRoot(scope),
								item.kind,
								item.kind === "skills"
									? resourceName(item.requestedTarget.name, true)
									: `${resourceName(item.requestedTarget.name)}.md`,
							);
		if (item.kind === "sessions") {
			const sessionRoot = this.paths.env.STEP_CODING_AGENT_SESSION_DIR || join(this.paths.agent, "sessions");
			if (!inside(anchor(sessionRoot), intent.path)) fail("invalid-journal-target");
		} else if (
			intent.path !== expected ||
			(!inside(this.paths.agent, expected) && item.kind !== "mcp" && scope.kind !== "project")
		)
			fail("invalid-journal-target");
		safePath(intent.path);
	}

	private ruleTargetIdentity(path: string): string {
		safePath(path);
		const entry = info(path);
		if (!entry?.isFile()) fail("recovery-target-changed", 409);
		return `${entry.dev}:${entry.ino}:${entry.birthtimeMs}`;
	}

	previewRecovery(jobId: string, itemId: string): MigrationRecoveryPreview {
		this.open();
		this.expireCaches();
		const journal = this.journals.get(jobId);
		if (!journal) fail("job-not-found", 404);
		this.validateJournalTarget(journal, itemId);
		const item = journal.job.items.find((i) => i.id === itemId)!;
		const intent = journal.intents.find((i) => i.itemId === itemId)!;
		if (
			item.kind !== "rules" ||
			!intent.backup ||
			!validId(intent.backup) ||
			!intent.targetIdentity ||
			(item.requestedTarget.scope.kind === "project" && !journal.projectIdentities?.[item.id]) ||
			intent.restored ||
			!["imported", "failed"].includes(item.status)
		)
			fail("recovery-unavailable", 404);
		if (intent.targetIdentity && this.ruleTargetIdentity(intent.path) !== intent.targetIdentity)
			fail("recovery-target-changed", 409);
		const currentText = text(intent.path, true);
		const restoredText = text(this.store.backupPath(intent.backup), true);
		if (
			currentText === undefined ||
			restoredText === undefined ||
			hash(currentText) !== intent.after ||
			hash(restoredText) !== intent.before
		)
			fail("recovery-target-changed", 409);
		const dto: MigrationRecoveryPreview = {
			id: randomUUID(),
			jobId,
			itemId,
			target: item.requestedTarget,
			currentText,
			restoredText,
			expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString(),
			requiredAcknowledgements: ["rules-impact"],
			diagnostics: [{ code: "recovery-future-loads-only" }],
		};
		this.recoveries.set(dto.id, {
			dto,
			targetIdentity: this.ruleTargetIdentity(intent.path),
			currentHash: intent.after,
			backupHash: intent.before!,
			fingerprint: ruleImpact(this.paths, item.requestedTarget.scope, intent.path, restoredText).impact.fingerprint,
		});
		return structuredClone(dto);
	}

	recover(input: { previewId: string; acknowledged: MigrationAcknowledgement[] }): { restored: boolean } {
		this.open();
		const r = record(input);
		const recovery = typeof r.previewId === "string" ? this.recoveries.get(r.previewId) : undefined;
		if (!recovery || Date.parse(recovery.dto.expiresAt) < Date.now()) fail("recovery-preview-expired", 409);
		if (!this.acknowledgements(r.acknowledged).includes("rules-impact")) fail("acknowledgement-required");
		const release = this.store.lock();
		let releaseTarget: (() => void) | undefined;
		try {
			const journal = this.journals.get(recovery.dto.jobId)!;
			this.validateJournalTarget(journal, recovery.dto.itemId);
			const intent = journal.intents.find((i) => i.itemId === recovery.dto.itemId)!;
			if (intent.restored || !intent.backup) fail("recovery-unavailable", 409);
			releaseTarget = acquireSettingsLockSync(intent.path);
			const backup = bytes(this.store.backupPath(intent.backup), true);
			if (
				!backup ||
				this.ruleTargetIdentity(intent.path) !== recovery.targetIdentity ||
				currentHash(intent.path) !== recovery.currentHash ||
				hash(backup) !== recovery.backupHash
			)
				fail("recovery-target-changed", 409);
			if (
				ruleImpact(this.paths, recovery.dto.target.scope, intent.path, backup.toString("utf8")).impact
					.fingerprint !== recovery.fingerprint
			)
				fail("recovery-impact-changed", 409);
			const stageRoot = join(dirname(intent.path), ".migration-stage");
			privateDir(stageRoot, true);
			const stage = join(stageRoot, randomUUID());
			durableWrite(stage, backup);
			intent.recovery = { before: recovery.currentHash, after: recovery.backupHash, committed: false };
			this.persist(journal);
			this.validateJournalTarget(journal, recovery.dto.itemId);
			if (
				this.ruleTargetIdentity(intent.path) !== recovery.targetIdentity ||
				currentHash(intent.path) !== recovery.currentHash
			)
				fail("recovery-target-changed", 409);
			if (
				ruleImpact(this.paths, recovery.dto.target.scope, intent.path, backup.toString("utf8")).impact
					.fingerprint !== recovery.fingerprint
			)
				fail("recovery-impact-changed", 409);
			renameSync(stage, intent.path);
			syncDir(dirname(intent.path));
			if (currentHash(intent.path) !== recovery.backupHash) fail("publication-conflict", 409);
			intent.restored = true;
			intent.recovery.committed = true;
			this.persist(journal);
			this.recoveries.delete(recovery.dto.id);
			return { restored: true };
		} finally {
			try {
				releaseTarget?.();
			} finally {
				release();
			}
		}
	}
}
