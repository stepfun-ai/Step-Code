import { useEffect } from "react";
import { ApiError } from "../../lib/api";
import { appStore } from "../../state/store";
import type {
	MigrationAcknowledgement,
	MigrationCandidate,
	MigrationKind,
	MigrationPreviewRequest,
	MigrationScope,
	MigrationTargetRequest,
} from "../../state/types";
import {
	acceptJob,
	adoptMigrationPlan,
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
		...(kind && !isActiveJob(state.job) ? { kind, scanKinds: [kind], stage: "select" as const } : {}),
		...(!kind && state.stage === "invitation" ? { stage: "select" as const } : {}),
		closeRequested: false,
		closeWhenSettled: false,
		...(isActiveJob(state.job) ? { stage: "job" as const } : {}),
	});
	reconcilePolling();
}
export function closeMigration(): void {
	const state = getMigrationState();
	if (
		isActiveJob(state.job) ||
		(state.stage !== "job" && Object.values(state.drafts).some((draft) => draft.selected))
	) {
		updateMigration({ closeRequested: true });
		return;
	}
	finishClosingMigration();
}
export function finishClosingMigration(): void {
	updateMigration({ open: false, closeRequested: false, closeWhenSettled: false });
	reconcilePolling();
}
export async function confirmCloseMigration(): Promise<void> {
	if (isActiveJob(getMigrationState().job)) {
		updateMigration({ closeRequested: false, closeWhenSettled: true });
		await stopMigrationJob();
		if (getMigrationState().error) updateMigration({ closeWhenSettled: false });
		else if (!isActiveJob(getMigrationState().job)) finishClosingMigration();
	} else {
		updateMigration({ drafts: {}, plan: null, startKey: null });
		finishClosingMigration();
	}
}
export function handleMigrationEscape(): boolean {
	const state = getMigrationState();
	if (!state.open) return false;
	if (state.closeRequested) {
		updateMigration({ closeRequested: false });
		return true;
	}
	if (state.recovery) {
		if (state.busy !== "recovery") updateMigration({ recovery: null, recoveryAcknowledged: [] });
	} else closeMigration();
	return true;
}
export function setMigrationKind(kind: MigrationKind): void {
	updateMigration({ kind, stage: "select", focusedId: null, error: null });
	if (!getMigrationState().scannedKinds.includes(kind) && !getMigrationState().scanning) void scanMigration(kind);
}
export function showMigrationStage(stage: "invitation" | "select" | "review" | "job"): void {
	updateMigration({ stage, error: null });
}
export function setSourceProjects(projectCwds: readonly string[]): void {
	if (!getMigrationState().scanning) updateMigration({ projectCwds: [...projectCwds] });
}
export function setMcpSourcePath(source: "claude-code" | "codex", path?: string): void {
	const state = getMigrationState();
	if (state.scanning || state.busy || isActiveJob(state.job)) return;
	const mcpSourcePaths = { ...state.mcpSourcePaths };
	if (path) mcpSourcePaths[source] = path;
	else delete mcpSourcePaths[source];
	updateMigration({ mcpSourcePaths, plan: null, startKey: null });
}
export function startNewMigration(kind?: MigrationKind): void {
	const state = getMigrationState();
	if (isActiveJob(state.job)) {
		updateMigration({ stage: "job" });
		return;
	}
	if (state.busy || state.scanning) return;
	updateMigration({
		stage: "select",
		scanKinds: kind ? [kind] : MIGRATION_KINDS,
		kind: kind ?? "sessions",
		...(state.stage === "job" ? { job: null, drafts: {}, plan: null, startKey: null, scannedKinds: [] } : {}),
	});
}
export function setSessionOptions(patch: Partial<ReturnType<typeof getMigrationState>["sessionOptions"]>): void {
	const state = getMigrationState();
	if (state.scanning || state.busy || isActiveJob(state.job)) return;
	updateMigration({ sessionOptions: { ...state.sessionOptions, ...patch } });
	void scanMigration("sessions");
}
export async function scanMigration(kind = getMigrationState().kind): Promise<void> {
	const state = getMigrationState();
	if (isActiveJob(state.job) || state.busy) return;
	const generation = ++scanGeneration;
	scanController?.abort();
	for (const [id, controller] of previewControllers) {
		if (!state.scan?.candidates.some((candidate) => candidate.id === id && candidate.kind === kind)) continue;
		controller.abort();
		previewControllers.delete(id);
		previewGenerations.delete(id);
	}
	const controller = new AbortController();
	scanController = controller;
	updateMigration({
		scanning: true,
		drafts: Object.fromEntries(
			Object.entries(state.drafts).map(([id, draft]) => [
				id,
				state.scan?.candidates.some((item) => item.id === id && item.kind === kind)
					? { ...draft, loading: false, acknowledged: [], ruleChecked: false, error: "preview-expired" }
					: draft,
			]),
		),
		focusedId: null,
		plan: null,
		startKey: null,
		error: null,
	});
	try {
		const scan = await migrationRequest(
			"/scan",
			isScan,
			{
				kinds: [kind],
				projectCwds: [...state.projectCwds],
				...(kind === "mcp" ? { mcpSourcePaths: { ...state.mcpSourcePaths } } : {}),
				...(kind === "sessions" ? { sessionOptions: { ...state.sessionOptions } } : {}),
			},
			controller.signal,
		);
		if (generation !== scanGeneration) return;
		const latest = getMigrationState();
		updateMigration({
			scan: {
				...scan,
				candidates: [...(latest.scan?.candidates ?? []).filter((item) => item.kind !== kind), ...scan.candidates],
				sources: [...(latest.scan?.sources ?? []).filter((item) => item.kind !== kind), ...scan.sources],
			},
			scannedKinds: [...new Set([...latest.scannedKinds, kind])],
			drafts: Object.fromEntries(
				Object.entries(latest.drafts).map(([id, draft]) => [
					id,
					state.scan?.candidates.some((item) => item.id === id && item.kind === kind)
						? { ...draft, acknowledged: [], ruleChecked: false, loading: false, error: "preview-expired" }
						: draft,
				]),
			),
			scanning: false,
			stage: isActiveJob(getMigrationState().job) ? "job" : "select",
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
	focus = true,
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
	const defaultTarget = candidate ? state.defaultTargets[candidate.kind] : undefined;
	const request = {
		...initial,
		...(defaultTarget ? { target: defaultTarget } : {}),
		...existing?.request,
		...patch,
		candidateId: id,
	};
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
		...(focus ? { focusedId: id } : {}),
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
/** Group selection only reviews eligible items; it never grants rule, scope or credential consent. */
export async function selectMigrationGroup(candidates: readonly MigrationCandidate[], checked: boolean): Promise<void> {
	const state = getMigrationState();
	if (state.busy || isActiveJob(state.job) || state.scanning) return;
	const eligible = candidates.filter(
		(candidate) =>
			candidate.kind !== "rules" &&
			candidate.needsMigration &&
			candidate.readiness === "ready" &&
			candidate.holding !== "plugin",
	);
	if (!checked) {
		for (const candidate of eligible) deselectCandidate(candidate.id);
		return;
	}
	const review = eligible.filter((candidate) => !state.drafts[candidate.id]?.selected);
	const drafts = { ...state.drafts };
	for (const candidate of review) {
		const previous = drafts[candidate.id];
		drafts[candidate.id] = {
			...(previous ?? { request: { candidateId: candidate.id } }),
			selected: true,
			loading: true,
			acknowledged: [],
			ruleChecked: false,
			error: undefined,
		};
	}
	updateMigration({ busy: "selection", drafts, plan: null, startKey: null });
	try {
		for (const candidate of review) {
			if (!getMigrationState().open || getMigrationState().scan !== state.scan) break;
			await previewCandidate(candidate.id, {}, true, false);
		}
	} finally {
		const current = getMigrationState();
		const settled = { ...current.drafts };
		for (const candidate of review) {
			const pending = settled[candidate.id];
			if (pending?.loading) settled[candidate.id] = { ...pending, loading: false };
		}
		if (current.busy === "selection") updateMigration({ busy: null, drafts: settled });
	}
}

/** Changing a shared target re-previews selected items, invalidating any earlier acknowledgements. */
export async function changeMigrationBatchTarget(kind: MigrationKind, target?: MigrationScope): Promise<void> {
	const state = getMigrationState();
	if (kind === "rules" || state.busy || state.scanning || isActiveJob(state.job)) return;
	const defaultTargets = { ...state.defaultTargets };
	if (target) defaultTargets[kind] = target;
	else delete defaultTargets[kind];
	updateMigration({ defaultTargets, plan: null, startKey: null });
	if (!target) return; // Existing explicit destinations remain intact; only the future default is reset.
	const ids = (state.scan?.candidates ?? [])
		.filter((candidate) => candidate.kind === kind && state.drafts[candidate.id]?.selected)
		.map((candidate) => candidate.id);
	const drafts = { ...state.drafts };
	for (const id of ids) {
		const existing = drafts[id];
		if (existing) drafts[id] = { ...invalidateDraft(existing, { ...existing.request, target }), loading: true };
	}
	updateMigration({ busy: "selection", drafts });
	try {
		for (const id of ids) {
			// Hiding the dialog does not cancel a target operation already explicitly requested.
			if (getMigrationState().scan !== state.scan) break;
			await previewCandidate(id, { target });
		}
	} finally {
		const current = getMigrationState();
		const settled = { ...current.drafts };
		for (const id of ids) {
			const pending = settled[id];
			if (pending?.loading) settled[id] = { ...pending, loading: false };
		}
		if (current.busy === "selection") updateMigration({ busy: null, drafts: settled });
	}
}

export async function changeMigrationGroupTarget(ids: readonly string[], target: MigrationScope): Promise<void> {
	const state = getMigrationState();
	if (state.busy || state.scanning || isActiveJob(state.job)) return;
	updateMigration({ busy: "selection", plan: null, startKey: null });
	try {
		for (const id of ids) {
			if (!getMigrationState().open || getMigrationState().scan !== state.scan) break;
			if (getMigrationState().drafts[id]?.selected) await previewCandidate(id, { target }, undefined, false);
		}
	} finally {
		if (getMigrationState().busy === "selection") updateMigration({ busy: null });
	}
}
export function changeTarget(id: string, target: MigrationTargetRequest): void {
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
	const selections = collectSelections(state.drafts, state.skipBlocked);
	updateMigration({ stage: "review" });
	if (!selections?.length || state.busy || isActiveJob(state.job)) return;
	const drafts = state.drafts;
	updateMigration({ busy: "plan", error: null, plan: null });
	try {
		const plan = await migrationRequest("/plans", isPlan, { selections });
		if (getMigrationState().drafts !== drafts || isActiveJob(getMigrationState().job)) return;
		const confirmedDrafts = adoptMigrationPlan(plan, drafts, state.skipBlocked);
		if (!confirmedDrafts) throw new Error("invalid-response");
		updateMigration({
			drafts: confirmedDrafts,
			skipBlocked: state.skipBlocked,
			plan,
			startKey: crypto.randomUUID(),
			stage: "review",
		});
	} catch (error) {
		updateMigration({ error: errorCode(error) });
	} finally {
		updateMigration({ busy: null });
	}
}
export async function startMigrationJob(): Promise<void> {
	const state = getMigrationState();
	if (
		!state.plan ||
		!state.startKey ||
		state.busy ||
		isActiveJob(state.job) ||
		!planReady(state.plan, state.drafts, Date.now(), state.skipBlocked)
	)
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
			if (getMigrationState().closeWhenSettled) finishClosingMigration();
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
