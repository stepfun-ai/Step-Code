import { useEffect } from "react";
import { ApiError } from "../../lib/api";
import { appStore } from "../../state/store";
import type {
	MigrationAcknowledgement,
	MigrationKind,
	MigrationPreviewRequest,
	MigrationScope,
} from "../../state/types";
import {
	acceptJob,
	backoffDelay,
	collectSelections,
	initialPreviewRequest,
	invalidateDraft,
	isActiveJob,
	MIGRATION_KINDS,
	planReady,
} from "./model";
import { getMigrationState, type MigrationOrigin, updateMigration } from "./store";
import { isJob, isJobs, isPlan, isPreview, isRecovery, isScan, migrationRequest } from "./transport";

function errorCode(error: unknown): string {
	if (error instanceof ApiError) return typeof error.body.code === "string" ? error.body.code : `http-${error.status}`;
	return error instanceof Error && error.message === "invalid-response" ? "invalid-response" : "network-error";
}
let scanGeneration = 0;
let scanController: AbortController | null = null;
const previewGenerations = new Map<string, number>();
const previewControllers = new Map<string, AbortController>();

export function openMigration(origin: MigrationOrigin, kind?: MigrationKind): void {
	const state = getMigrationState();
	updateMigration({
		open: true,
		origin,
		error: null,
		...(kind && !isActiveJob(state.job) ? { kind, scanKinds: [kind], stage: "invitation" as const } : {}),
		...(isActiveJob(state.job) ? { stage: "job" as const } : {}),
	});
	reconcilePolling();
}
export function closeMigration(): void {
	updateMigration({ open: false });
	reconcilePolling();
}
export function handleMigrationEscape(): boolean {
	const state = getMigrationState();
	if (!state.open) return false;
	if (state.recovery) {
		if (state.busy !== "recovery") updateMigration({ recovery: null, recoveryAcknowledged: [] });
	} else closeMigration();
	return true;
}
export function setMigrationKind(kind: MigrationKind): void {
	updateMigration({ kind, stage: "select", focusedId: null, error: null });
}
export function showMigrationStage(stage: "invitation" | "select" | "review" | "job"): void {
	updateMigration({ stage, error: null });
}
export function setSourceProjects(projectCwds: readonly string[]): void {
	if (!getMigrationState().scanning) updateMigration({ projectCwds: [...projectCwds] });
}
export function startNewMigration(kind?: MigrationKind): void {
	const state = getMigrationState();
	if (isActiveJob(state.job) || state.busy) {
		updateMigration({ stage: "job" });
		return;
	}
	updateMigration({ stage: "invitation", scanKinds: kind ? [kind] : MIGRATION_KINDS, kind: kind ?? "sessions" });
}
export async function scanMigration(): Promise<void> {
	const state = getMigrationState();
	if (isActiveJob(state.job) || state.busy) return;
	const generation = ++scanGeneration;
	scanController?.abort();
	for (const controller of previewControllers.values()) controller.abort();
	previewControllers.clear();
	previewGenerations.clear();
	const controller = new AbortController();
	scanController = controller;
	updateMigration({
		scanning: true,
		scan: null,
		drafts: {},
		focusedId: null,
		plan: null,
		startKey: null,
		error: null,
	});
	try {
		const scan = await migrationRequest(
			"/scan",
			isScan,
			{ kinds: [...state.scanKinds], projectCwds: [...state.projectCwds] },
			controller.signal,
		);
		if (generation !== scanGeneration) return;
		updateMigration({
			scan,
			scanning: false,
			stage: isActiveJob(getMigrationState().job) ? "job" : "select",
			kind: state.scanKinds[0] ?? "sessions",
		});
	} catch (error) {
		if (generation === scanGeneration && !controller.signal.aborted)
			updateMigration({ scanning: false, error: errorCode(error) });
	}
}
export function deselectCandidate(id: string): void {
	const state = getMigrationState();
	const draft = state.drafts[id];
	if (!draft || state.busy === "start") return;
	updateMigration({ drafts: { ...state.drafts, [id]: { ...draft, selected: false } }, plan: null, startKey: null });
}
export async function previewCandidate(
	id: string,
	patch: Partial<MigrationPreviewRequest> = {},
	select?: boolean,
): Promise<void> {
	const state = getMigrationState();
	if (isActiveJob(state.job) || state.busy === "start") return;
	const existing = state.drafts[id];
	const candidate = state.scan?.candidates.find((item) => item.id === id);
	const app = appStore.getState();
	const offeredProjects = [
		...app.workspaces
			.filter((workspace) => workspace.available && !workspace.hidden)
			.map((workspace) => workspace.path),
		...(app.defaultCwd ? [app.defaultCwd] : []),
	];
	const initial = candidate ? initialPreviewRequest(candidate, offeredProjects) : {};
	const request = { ...initial, ...existing?.request, ...patch, candidateId: id };
	const generation = (previewGenerations.get(id) ?? 0) + 1;
	previewGenerations.set(id, generation);
	previewControllers.get(id)?.abort();
	const controller = new AbortController();
	previewControllers.set(id, controller);
	const draft = invalidateDraft(
		existing ?? { request, selected: false, acknowledged: [], ruleChecked: false, loading: false },
		request,
	);
	updateMigration({
		focusedId: id,
		drafts: {
			...state.drafts,
			[id]: { ...draft, preview: existing?.preview, selected: select ?? draft.selected, loading: true },
		},
		plan: null,
		startKey: null,
		error: null,
	});
	try {
		const preview = await migrationRequest("/preview", isPreview, request, controller.signal);
		if (preview.candidate.id !== id) throw new Error("invalid-response");
		if (previewGenerations.get(id) !== generation || controller.signal.aborted) return;
		const latest = getMigrationState();
		const current = latest.drafts[id];
		if (!current) return;
		updateMigration({ drafts: { ...latest.drafts, [id]: { ...current, preview, loading: false } } });
	} catch (error) {
		if (previewGenerations.get(id) !== generation || controller.signal.aborted) return;
		const latest = getMigrationState();
		const current = latest.drafts[id];
		if (current)
			updateMigration({
				drafts: { ...latest.drafts, [id]: { ...current, loading: false, error: errorCode(error) } },
			});
	} finally {
		if (previewControllers.get(id) === controller) previewControllers.delete(id);
	}
}
export function changeTarget(id: string, target: MigrationScope): void {
	void previewCandidate(id, { target });
}
export function acknowledgePreview(id: string, ack: MigrationAcknowledgement, checked: boolean): void {
	const state = getMigrationState();
	const draft = state.drafts[id];
	if (!draft?.preview || draft.loading || state.busy === "start") return;
	const acknowledged = checked
		? [...new Set([...draft.acknowledged, ack])]
		: draft.acknowledged.filter((value) => value !== ack);
	updateMigration({ drafts: { ...state.drafts, [id]: { ...draft, acknowledged } }, plan: null, startKey: null });
}
export function checkRuleConsent(id: string, checked: boolean): void {
	const state = getMigrationState();
	const draft = state.drafts[id];
	if (!draft) return;
	updateMigration({
		drafts: {
			...state.drafts,
			[id]: {
				...draft,
				ruleChecked: checked,
				acknowledged: draft.acknowledged.filter((value) => value !== "rules-impact"),
			},
		},
		plan: null,
		startKey: null,
	});
}
export async function createMigrationPlan(): Promise<void> {
	const state = getMigrationState();
	const selections = collectSelections(state.drafts);
	if (!selections || state.busy || isActiveJob(state.job)) return;
	const drafts = state.drafts;
	updateMigration({ busy: "plan", error: null, plan: null });
	try {
		const plan = await migrationRequest("/plans", isPlan, { selections });
		if (getMigrationState().drafts !== drafts || isActiveJob(getMigrationState().job)) return;
		updateMigration({ plan, startKey: crypto.randomUUID(), stage: "review" });
	} catch (error) {
		updateMigration({ error: errorCode(error) });
	} finally {
		updateMigration({ busy: null });
	}
}
export async function startMigrationJob(): Promise<void> {
	const state = getMigrationState();
	if (!state.plan || !state.startKey || state.busy || isActiveJob(state.job) || !planReady(state.plan, state.drafts))
		return;
	updateMigration({ busy: "start", error: null });
	try {
		const job = await migrationRequest("", isJob, {
			planId: state.plan.id,
			digest: state.plan.digest,
			idempotencyKey: state.startKey,
		});
		updateMigration({
			job,
			stage: "job",
			jobs: [job, ...getMigrationState().jobs.filter((item) => item.id !== job.id)],
		});
		reconcilePolling();
	} catch (error) {
		// An uncertain response retains this plan's key. Only an explicit retry may repeat start.
		updateMigration({ error: errorCode(error) });
	} finally {
		updateMigration({ busy: null });
	}
}
let historyGeneration = 0;
export async function refreshMigrationHistory(): Promise<void> {
	const generation = ++historyGeneration;
	updateMigration({ historyLoading: true });
	try {
		const { jobs } = await migrationRequest("", isJobs);
		if (generation !== historyGeneration) return;
		const current = getMigrationState();
		const active = jobs.find(isActiveJob);
		const updated = current.job ? jobs.find((job) => job.id === current.job?.id) : undefined;
		const attached = active
			? acceptJob(current.job, active)
			: updated
				? acceptJob(current.job, updated)
				: current.job;
		updateMigration({
			jobs,
			job: attached,
			...(active && current.open ? { stage: "job" as const } : {}),
			historyLoading: false,
		});
		reconcilePolling();
	} catch (error) {
		if (generation === historyGeneration) updateMigration({ historyLoading: false, error: errorCode(error) });
	}
}
export function attachMigrationJob(id: string): void {
	const state = getMigrationState();
	if (isActiveJob(state.job) && state.job?.id !== id) {
		updateMigration({ stage: "job" });
		return;
	}
	const job = state.jobs.find((item) => item.id === id);
	if (job) {
		updateMigration({ job, open: true, stage: "job", pollError: null });
		reconcilePolling();
	}
}
export async function stopMigrationJob(): Promise<void> {
	const state = getMigrationState();
	if (!state.job || !isActiveJob(state.job) || state.job.status === "stopping" || state.busy) return;
	updateMigration({ busy: "cancel", error: null });
	try {
		const job = await migrationRequest(`/${encodeURIComponent(state.job.id)}/cancel`, isJob, {});
		if (getMigrationState().job?.id === job.id) updateMigration({ job: acceptJob(getMigrationState().job, job) });
	} catch (error) {
		updateMigration({ error: errorCode(error) });
	} finally {
		updateMigration({ busy: null });
		reconcilePolling();
	}
}
export async function retryMigrationFailures(): Promise<void> {
	const state = getMigrationState();
	if (!state.job || isActiveJob(state.job) || state.busy) return;
	const retryIds = state.job.items
		.filter((item) => item.status === "failed" || item.status === "not-run")
		.map((item) => item.candidateId);
	if (retryIds.some((id) => !state.scan?.candidates.some((candidate) => candidate.id === id))) {
		startNewMigration();
		updateMigration({ error: "retry-scan-required" });
		return;
	}
	const drafts = Object.fromEntries(
		Object.entries(state.drafts).map(([id, draft]) => [
			id,
			{ ...invalidateDraft(draft, draft.request), selected: retryIds.includes(id) },
		]),
	);
	updateMigration({ drafts, plan: null, startKey: null, stage: "select", focusedId: retryIds[0] ?? null });
	for (const id of retryIds) await previewCandidate(id, {}, true);
}
export async function previewMigrationRecovery(jobId: string, itemId: string): Promise<void> {
	if (getMigrationState().busy || isActiveJob(getMigrationState().job)) return;
	updateMigration({ busy: "recovery", recovery: null, recoveryAcknowledged: [], error: null });
	try {
		updateMigration({ recovery: await migrationRequest("/recoveries/preview", isRecovery, { jobId, itemId }) });
	} catch (error) {
		updateMigration({ error: errorCode(error) });
	} finally {
		updateMigration({ busy: null });
	}
}
export function acknowledgeRecovery(checked: boolean): void {
	const recovery = getMigrationState().recovery;
	if (recovery && !getMigrationState().busy)
		updateMigration({
			recoveryAcknowledged: checked
				? [...new Set<MigrationAcknowledgement>([...recovery.requiredAcknowledgements, "rules-impact"])]
				: [],
		});
}
function isRestored(value: unknown): value is { restored: boolean } {
	return typeof value === "object" && value !== null && "restored" in value && typeof value.restored === "boolean";
}
export async function applyMigrationRecovery(): Promise<void> {
	const state = getMigrationState();
	if (
		!state.recovery ||
		state.busy ||
		isActiveJob(state.job) ||
		Date.parse(state.recovery.expiresAt) <= Date.now() ||
		!state.recoveryAcknowledged.includes("rules-impact") ||
		!state.recovery.requiredAcknowledgements.every((ack) => state.recoveryAcknowledged.includes(ack))
	)
		return;
	updateMigration({ busy: "recovery", error: null });
	try {
		const result = await migrationRequest("/recoveries/apply", isRestored, {
			previewId: state.recovery.id,
			acknowledged: [...state.recoveryAcknowledged],
		});
		if (result.restored)
			updateMigration({
				recovered: [...state.recovered, `${state.recovery.jobId}:${state.recovery.itemId}`],
				recovery: null,
				recoveryAcknowledged: [],
			});
		else updateMigration({ error: "recovery-not-applied" });
	} catch (error) {
		updateMigration({ error: errorCode(error), recovery: null, recoveryAcknowledged: [] });
	} finally {
		updateMigration({ busy: null });
	}
}

let visibleReaders = 0;
let pollGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollController: AbortController | null = null;
let polledId: string | null = null;
function stopPolling(): void {
	pollGeneration++;
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
	pollController?.abort();
	pollController = null;
	polledId = null;
}
function reconcilePolling(): void {
	const state = getMigrationState();
	const wanted =
		visibleReaders > 0 && typeof document !== "undefined" && !document.hidden && isActiveJob(state.job)
			? state.job?.id
			: null;
	if (!wanted) {
		stopPolling();
		return;
	}
	if (polledId === wanted) return;
	stopPolling();
	polledId = wanted;
	const generation = pollGeneration;
	void pollJob(wanted, generation, 0);
}
async function pollJob(id: string, generation: number, failures: number): Promise<void> {
	const controller = new AbortController();
	pollController = controller;
	try {
		const job = await migrationRequest(`/${encodeURIComponent(id)}`, isJob, undefined, controller.signal);
		if (generation !== pollGeneration || getMigrationState().job?.id !== id) return;
		const state = getMigrationState();
		const accepted = acceptJob(state.job, job);
		updateMigration({
			job: accepted,
			jobs: [accepted, ...state.jobs.filter((item) => item.id !== id)],
			pollError: null,
		});
		failures = 0;
		if (!isActiveJob(accepted)) {
			stopPolling();
			return;
		}
	} catch (error) {
		if (generation !== pollGeneration || controller.signal.aborted) return;
		failures++;
		updateMigration({ pollError: errorCode(error) });
	}
	if (generation === pollGeneration)
		pollTimer = setTimeout(() => void pollJob(id, generation, failures), backoffDelay(failures));
}
/** A visible entry leases reads, not the server job; both entries share one bound poller. */
export function useMigrationVisibility(visible: boolean): void {
	useEffect(() => {
		if (!visible) return;
		visibleReaders++;
		const changed = () => reconcilePolling();
		document.addEventListener("visibilitychange", changed);
		reconcilePolling();
		return () => {
			visibleReaders--;
			document.removeEventListener("visibilitychange", changed);
			reconcilePolling();
		};
	}, [visible]);
}

export function confirmRule(id: string): void {
	const draft = getMigrationState().drafts[id];
	if (
		draft?.ruleChecked &&
		draft.preview?.ruleImpact &&
		draft.preview.action !== "skip" &&
		!draft.preview.blockers.length
	)
		acknowledgePreview(id, "rules-impact", true);
}
