import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Button, IconButton, Modal, Tooltip } from "../../ui";
import {
	closeMigration,
	confirmCloseMigration,
	createMigrationPlan,
	finishClosingMigration,
	handleMigrationEscape,
	openMigration,
	refreshMigrationHistory,
	scanMigration,
	setMigrationKind,
	showMigrationStage,
	startMigrationJob,
	startNewMigration,
	useMigrationVisibility,
} from "./actions";
import { CandidateList, DiagnosticList } from "./CandidateList";
import { useMigrationExpiry } from "./expiry";
import { trapMigrationFocus, useMigrationDialogFocus } from "./focus";
import { MigrationHistory, MigrationJobView, RecoveryReview } from "./JobView";
import { draftReady, isActiveJob, MIGRATION_KINDS, planReady } from "./model";
import { type MigrationFeatureProps, PreviewPanel } from "./PreviewPanel";
import { FinalPlan } from "./ReviewPlan";
import { getMigrationState, updateMigration, useMigrationStore } from "./store";
import "./migration.css";

export { migrationMessages } from "../../i18n/migration-messages";
export { closeMigration, handleMigrationEscape, openMigration } from "./actions";
export type { MigrationFeatureProps } from "./PreviewPanel";

/** Settings slot. App must keep MigrationOnboarding mounted as the shared dialog host. */
export function MigrationPage() {
	const t = useT();
	const job = useMigrationStore((state) => state.job);
	const error = useMigrationStore((state) => state.error);
	useMigrationVisibility(true);
	useEffect(() => {
		void refreshMigrationHistory();
	}, []);
	return (
		<div className="migration-page" id="migrationPage">
			<h2>{t("migrationTitle")}</h2>
			<p>{t("migrationSettingsBody")}</p>
			<Button
				variant="primary"
				onClick={() => {
					startNewMigration();
					openMigration("settings");
				}}
			>
				{t(isActiveJob(job) ? "migrationViewJob" : "migrationStartEntry")}
			</Button>
			<div className="migration-category-list">
				{MIGRATION_KINDS.map((kind) => (
					<Button
						key={kind}
						className="migration-category-card"
						onClick={() => {
							startNewMigration(kind);
							openMigration("settings", kind);
						}}
					>
						<strong>{t(`migrationKind.${kind}`)}</strong>
						<span>{t(`migrationCardHint.${kind}`)}</span>
					</Button>
				))}
			</div>
			{error ? (
				<div role="alert" className="migration-danger">
					<DiagnosticList diagnostics={[{ code: error }]} />
				</div>
			) : null}
			<MigrationHistory />
		</div>
	);
}
export interface MigrationOnboardingProps extends MigrationFeatureProps {
	readonly open: boolean;
	readonly onFinish: (status: "completed" | "skipped", lastJobId?: string) => Promise<void>;
	readonly onJobStarted?: (lastJobId: string) => Promise<void>;
}
/** One always-mounted host serves onboarding and Settings, with settled cancellation before closing. */
export function MigrationOnboarding({
	open: invited,
	onFinish,
	onJobStarted,
	...featureProps
}: MigrationOnboardingProps) {
	const t = useT();
	const open = useMigrationStore((state) => state.open);
	const origin = useMigrationStore((state) => state.origin);
	const stage = useMigrationStore((state) => state.stage);
	const kind = useMigrationStore((state) => state.kind);
	const drafts = useMigrationStore((state) => state.drafts);
	const plan = useMigrationStore((state) => state.plan);
	const job = useMigrationStore((state) => state.job);
	const busy = useMigrationStore((state) => state.busy);
	const error = useMigrationStore((state) => state.error);
	const recovery = useMigrationStore((state) => state.recovery);
	const consentDeadline =
		Object.values(drafts)
			.filter((draft) => draft.selected && draft.preview)
			.map((draft) => draft.preview?.expiresAt ?? "")
			.sort()[0] ?? null;
	const consentExpired = useMigrationExpiry(open, consentDeadline);
	const planExpired = useMigrationExpiry(open, plan?.expiresAt ?? null);
	const recoveryExpired = useMigrationExpiry(open, recovery?.expiresAt ?? null);
	const [finishing, setFinishing] = useState(false);
	const recordedJob = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (origin !== "onboarding" || !job?.id || !onJobStarted || recordedJob.current === job.id) return;
		recordedJob.current = job.id;
		void onJobStarted(job.id).catch(() => {
			// The already-durable job continues even when optional onboarding metadata cannot be saved.
			updateMigration({ error: "onboarding-save-failed" });
		});
	}, [job?.id, origin, onJobStarted]);
	const workspaceBrowserOpen = useAppStore((state) => state.ui.workspaceBrowserOpen);
	const dialogRef = useMigrationDialogFocus(open && !workspaceBrowserOpen);
	useMigrationVisibility(open);
	useEffect(() => {
		if (invited) {
			openMigration("onboarding");
			void refreshMigrationHistory();
		}
	}, [invited]);
	useEffect(() => {
		if (!open || !recovery) return;
		const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.querySelector<HTMLElement>(".migration-recovery input")?.focus();
		return () => {
			if (trigger?.isConnected && !trigger.closest("[hidden]")) trigger.focus();
		};
	}, [open, recovery, dialogRef]);
	const finish = async (status: "completed" | "skipped") => {
		setFinishing(true);
		try {
			if (origin === "onboarding") await onFinish(status, job?.id);
			updateMigration({ drafts: {}, plan: null, startKey: null });
			finishClosingMigration();
		} catch {
			updateMigration({ error: "onboarding-save-failed" });
		} finally {
			setFinishing(false);
		}
	};
	const selectedDrafts = Object.values(drafts).filter((draft) => draft.selected);
	const selected = selectedDrafts.length;
	const readyCount = selectedDrafts.filter((draft) => draftReady(draft)).length;
	const selectedSessions = selectedDrafts.filter(
		(draft) =>
			(draft.preview?.candidate.kind ??
				getMigrationState().scan?.candidates.find((item) => item.id === draft.request.candidateId)?.kind) ===
			"sessions",
	);
	const selectedWorkspaces = new Set(
		selectedSessions.map((draft) => {
			const candidate =
				draft.preview?.candidate ??
				getMigrationState().scan?.candidates.find((item) => item.id === draft.request.candidateId);
			return candidate?.sourceScope.kind === "project" ? candidate.sourceScope.cwd : "";
		}),
	).size;
	const stepIndex = MIGRATION_KINDS.indexOf(kind);
	const mcpTotal = (getMigrationState().scan?.candidates ?? []).filter((candidate) => candidate.kind === "mcp").length;
	const closeRequested = useMigrationStore((state) => state.closeRequested);
	const confirmDialogRef = useMigrationDialogFocus(open && closeRequested);
	const closeWhenSettled = useMigrationStore((state) => state.closeWhenSettled);
	const focusedId = useMigrationStore((state) => state.focusedId);
	const scanning = useMigrationStore((state) => state.scanning);
	useEffect(() => {
		if (
			open &&
			stage === "select" &&
			!getMigrationState().scannedKinds.includes(kind) &&
			!getMigrationState().scanning
		)
			void scanMigration(kind);
	}, [open, kind, stage]);
	useEffect(() => {
		if (closeWhenSettled && !isActiveJob(job) && !busy) finishClosingMigration();
	}, [closeWhenSettled, job, busy]);
	return (
		<Modal
			id="migrationModal"
			open={open}
			onClose={closeMigration}
			closeOnBackdrop={false}
			labelledBy="migrationDialogTitle"
			className="migration-dialog"
			dialogProps={{ ref: dialogRef, tabIndex: -1, onKeyDown: trapMigrationFocus }}
		>
			<div className="migration-wizard" hidden={!!recovery}>
				<nav className="migration-step-rail" aria-label={t("migrationSteps")}>
					{MIGRATION_KINDS.map((value, index) => (
						<Button
							key={value}
							disabled={!!busy || scanning || isActiveJob(job)}
							className={`migration-step${stage === "select" && kind === value ? " migration-step-active" : ""}`}
							aria-current={stage === "select" && kind === value ? "step" : undefined}
							onClick={() => setMigrationKind(value)}
						>
							<span className="migration-step-number">{index + 1}</span>
							{t(`migrationKind.${value}`)}
						</Button>
					))}
					<Button
						className={`migration-step${stage === "review" || stage === "job" ? " migration-step-active" : ""}`}
						disabled={(!!busy && busy !== "selection") || isActiveJob(job)}
						onClick={() => void createMigrationPlan()}
					>
						<span className="migration-step-number">{MIGRATION_KINDS.length + 1}</span>
						{t("migrationConfirmStep")}
					</Button>
				</nav>
				<div className="migration-main">
					<header className="migration-dialog-head">
						<div className="migration-heading">
							<span className="migration-eyebrow">
								{t(origin === "onboarding" ? "migrationEntryFirst" : "migrationEntrySettings")}
							</span>
							<h2 id="migrationDialogTitle">
								{t(
									stage === "select"
										? `migrationKind.${kind}`
										: stage === "review"
											? "migrationConfirmStep"
											: isActiveJob(job)
												? "migrationJobRunning"
												: "migrationJobResult",
								)}
							</h2>
						</div>
						<p className="migration-step-hint">
							{t(
								stage === "select"
									? `migrationStepHint.${kind}`
									: stage === "review"
										? "migrationPlanHint"
										: "migrationLocalOnly",
							)}
						</p>
						<Tooltip content={t("migrationCloseWizard")}>
							<IconButton icon="close" aria-label={t("migrationCloseWizard")} onClick={closeMigration} />
						</Tooltip>
					</header>
					<div className="migration-main-content">
						{(stage === "select" || stage === "review") && consentExpired ? (
							<p className="migration-attention">{t("migrationDiagnostic.preview-expired")}</p>
						) : null}
						{stage === "review" && planExpired ? (
							<p className="migration-attention">{t("migrationDiagnostic.plan-expired")}</p>
						) : null}
						{error ? (
							<div role="alert" className="migration-danger">
								<DiagnosticList diagnostics={[{ code: error }]} />
							</div>
						) : null}
						{stage === "select" || stage === "invitation" ? (
							<>
								<div
									className={`migration-resource-layout${focusedId ? " migration-has-preview" : ""}${kind === "rules" ? " migration-resource-rules" : ""}`}
								>
									<CandidateList key={kind} onPickTarget={featureProps.onPickTarget} />
									<PreviewPanel {...featureProps} />
								</div>
							</>
						) : stage === "review" ? (
							<FinalPlan />
						) : (
							<MigrationJobView {...featureProps} />
						)}
					</div>
					<footer className="migration-dialog-foot">
						{recovery ? (
							<Button variant="secondary" disabled={!!busy} onClick={handleMigrationEscape}>
								{t("migrationCancelRecovery")}
							</Button>
						) : (
							<>
								<span className="migration-meta">
									{stage === "job"
										? t(isActiveJob(job) ? "migrationHideContinues" : "migrationJobRecorded")
										: stage === "review" || (stage === "select" && kind === "rules")
											? t("migrationReviewSelected", { count: readyCount })
											: kind === "mcp"
												? t("migrationMcpSelection", { selected, total: mcpTotal })
												: t("migrationSessionSelection", {
														workspaces: selectedWorkspaces,
														sessions: selectedSessions.length,
													})}
								</span>
								{stage === "select" && !isActiveJob(job) ? (
									<div className="migration-selection-footer">
										<div className="migration-selection-nav">
											<Button
												variant="secondary"
												disabled={!!busy || stepIndex <= 0}
												onClick={() => {
													const previous = MIGRATION_KINDS[stepIndex - 1];
													if (previous) setMigrationKind(previous);
												}}
											>
												{t("migrationPreviousStep")}
											</Button>
											{stepIndex < MIGRATION_KINDS.length - 1 ? (
												<Button
													variant="primary"
													disabled={!!busy}
													onClick={() => {
														const next = MIGRATION_KINDS[stepIndex + 1];
														if (next) setMigrationKind(next);
													}}
												>
													{t("migrationNextStep")}
												</Button>
											) : null}
											<Button
												id="migrationReviewPlan"
												variant={stepIndex === MIGRATION_KINDS.length - 1 ? "primary" : "secondary"}
												disabled={!!busy && busy !== "selection"}
												onClick={() => {
													if (!selected) void finish("skipped");
													else void createMigrationPlan();
												}}
											>
												{t("migrationReviewPlan")}
											</Button>
										</div>
									</div>
								) : null}
								{stage === "review" ? (
									<>
										<Button
											variant="secondary"
											disabled={!!busy}
											onClick={() => showMigrationStage("select")}
										>
											{t("migrationBackToSelection")}
										</Button>
										<Button
											id="migrationStartPlan"
											variant="primary"
											disabled={!!busy || !plan || !planReady(plan, drafts, Date.now())}
											onClick={() => void startMigrationJob()}
										>
											{t(busy === "start" ? "migrationStarting" : "migrationStartCount", {
												count: readyCount,
											})}
										</Button>
									</>
								) : null}
								{origin === "onboarding" ? (
									<Button
										variant="secondary"
										disabled={finishing || !!busy}
										onClick={() => {
											if (stage === "job" && !isActiveJob(job)) void finish("completed");
											else if (isActiveJob(job) || selected) closeMigration();
											else void finish("skipped");
										}}
									>
										{t(stage === "job" && !isActiveJob(job) ? "migrationFinish" : "migrationSkip")}
									</Button>
								) : null}
							</>
						)}
					</footer>
				</div>
			</div>
			<RecoveryReview />
			<div hidden={!recovery}>
				<Button variant="secondary" disabled={!!busy} onClick={handleMigrationEscape}>
					{t("migrationCancelRecovery")}
				</Button>
			</div>
			{recovery && recoveryExpired ? (
				<p className="migration-attention">{t("migrationDiagnostic.recovery-preview-expired")}</p>
			) : null}
			{recovery && error ? (
				<div role="alert" className="migration-danger">
					<DiagnosticList diagnostics={[{ code: error }]} />
				</div>
			) : null}

			<Modal
				id="migrationCloseConfirm"
				open={closeRequested}
				onClose={() => updateMigration({ closeRequested: false })}
				labelledBy="migrationCloseTitle"
				className="migration-close-confirm"
				closeOnBackdrop={false}
				dialogProps={{ ref: confirmDialogRef, tabIndex: -1, onKeyDown: trapMigrationFocus }}
			>
				<h3 id="migrationCloseTitle">
					{t(isActiveJob(job) ? "migrationStopCloseTitle" : "migrationDiscardTitle")}
				</h3>
				<p>{t(isActiveJob(job) ? "migrationStopCloseBody" : "migrationDiscardBody")}</p>
				<div className="migration-toolbar">
					<Button variant="secondary" onClick={() => updateMigration({ closeRequested: false })}>
						{t("migrationBackToSelection")}
					</Button>
					<Button variant="primary" disabled={!!busy} onClick={() => void confirmCloseMigration()}>
						{t(isActiveJob(job) ? "migrationStopAndClose" : "migrationDiscardClose")}
					</Button>
				</div>
			</Modal>
		</Modal>
	);
}
