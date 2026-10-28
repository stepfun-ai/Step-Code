import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Button, IconButton, Modal, Spinner, Tooltip } from "../../ui";
import {
	closeMigration,
	createMigrationPlan,
	handleMigrationEscape,
	openMigration,
	refreshMigrationHistory,
	scanMigration,
	setMigrationKind,
	setSourceProjects,
	showMigrationStage,
	startMigrationJob,
	startNewMigration,
	useMigrationVisibility,
} from "./actions";
import { CandidateList, DiagnosticList } from "./CandidateList";
import { useMigrationExpiry } from "./expiry";
import { trapMigrationFocus, useMigrationDialogFocus } from "./focus";
import { MigrationHistory, MigrationJobView, RecoveryReview } from "./JobView";
import { collectSelections, isActiveJob, MIGRATION_KINDS, planReady } from "./model";
import { type MigrationFeatureProps, PreviewPanel, ScopeLabel } from "./PreviewPanel";
import { updateMigration, useMigrationStore } from "./store";
import "./migration.css";

export { migrationMessages } from "../../i18n/migration-messages";
export { closeMigration, handleMigrationEscape, openMigration } from "./actions";
export type { MigrationFeatureProps } from "./PreviewPanel";

function MigrationInvitation() {
	const t = useT();
	const workspaces = useAppStore((state) => state.workspaces);
	const defaultCwd = useAppStore((state) => state.defaultCwd);
	const projects = useMigrationStore((state) => state.projectCwds);
	const scanning = useMigrationStore((state) => state.scanning);
	const scanKinds = useMigrationStore((state) => state.scanKinds);
	const paths = [
		...new Set([
			...workspaces
				.filter((workspace) => workspace.available && !workspace.hidden)
				.map((workspace) => workspace.path),
			...(defaultCwd ? [defaultCwd] : []),
		]),
	];
	return (
		<section className="migration-invitation">
			<h2>{t("migrationInvitationTitle")}</h2>
			<p>{t("migrationInvitationBody")}</p>
			<div className="migration-category-list">
				{scanKinds.map((kind) => (
					<span key={kind}>{t(`migrationKind.${kind}`)}</span>
				))}
			</div>
			<p>{t("migrationScanBoundary")}</p>
			<p>{t("migrationSourcePreserved")}</p>
			<fieldset disabled={scanning}>
				<legend>{t("migrationSourceProjects")}</legend>
				<p>{t("migrationSourceProjectsHelp")}</p>
				{paths.map((cwd) => (
					<label className="migration-check" key={cwd}>
						<input
							type="checkbox"
							checked={projects.includes(cwd)}
							onChange={(event) =>
								setSourceProjects(
									event.currentTarget.checked ? [...projects, cwd] : projects.filter((path) => path !== cwd),
								)
							}
						/>
						<code>{cwd}</code>
					</label>
				))}
			</fieldset>
			<Button variant="primary" disabled={scanning} onClick={() => void scanMigration()}>
				{scanning ? <Spinner /> : null}
				{t(scanning ? "migrationScanning" : "migrationStartScan")}
			</Button>
		</section>
	);
}
function FinalPlan() {
	const t = useT();
	const plan = useMigrationStore((state) => state.plan);
	if (!plan) return <p>{t("migrationPlanRequired")}</p>;
	return (
		<section className="migration-final-plan">
			<h3>{t("migrationFinalPlan")}</h3>
			<p>{t("migrationPlanImmutable")}</p>
			{plan.items.map((preview) => (
				<article className="migration-plan-item" key={preview.id}>
					<h4>
						{preview.candidate.name} · {t(`migrationAction.${preview.action}`)}
					</h4>
					<div className="migration-map">
						<div>
							<span>{t("migrationSourcePath")}</span>
							<code>{preview.candidate.sourcePath}</code>
						</div>
						<div>
							<span>{t("migrationTargetPath")}</span>
							<code>{preview.target.path}</code>
							<ScopeLabel scope={preview.target.scope} />
						</div>
					</div>
					<p>{t(`migrationActivation.${preview.activation}`)}</p>
					{preview.candidate.kind === "rules" && preview.action !== "skip" ? (
						<p className="migration-attention">
							{preview.target.scope.kind === "global"
								? t("migrationRuleGlobalScope")
								: t("migrationRuleProjectScope", { cwd: preview.target.scope.cwd })}
							<br />
							{t("migrationRuleModel")}
						</p>
					) : null}
					<DiagnosticList diagnostics={preview.warnings} />
					<div className="migration-danger">
						<DiagnosticList diagnostics={preview.blockers} />
					</div>
				</article>
			))}
		</section>
	);
}
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
				{t(isActiveJob(job) ? "migrationViewJob" : "migrationNew")}
			</Button>
			<div className="migration-category-list">
				{MIGRATION_KINDS.map((kind) => (
					<Button
						key={kind}
						variant="secondary"
						onClick={() => {
							startNewMigration(kind);
							openMigration("settings", kind);
						}}
					>
						{t(`migrationKind.${kind}`)}
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
/** One always-mounted host serves onboarding and Settings, including hidden background jobs. */
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
			await onFinish(status, job?.id);
			closeMigration();
		} catch {
			updateMigration({ error: "onboarding-save-failed" });
		} finally {
			setFinishing(false);
		}
	};
	const selected = Object.values(drafts).filter((draft) => draft.selected).length;
	const ready = collectSelections(drafts) !== null;
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
			<header className="migration-dialog-head">
				<h2 id="migrationDialogTitle">{t("migrationTitle")}</h2>
				<Tooltip content={t("migrationHide")}>
					<IconButton icon="close" aria-label={t("migrationHide")} onClick={closeMigration} />
				</Tooltip>
			</header>
			<div className="migration-wizard" hidden={!!recovery}>
				<nav className="migration-step-rail" aria-label={t("migrationSteps")}>
					{MIGRATION_KINDS.map((value, index) => (
						<Button
							key={value}
							disabled={stage === "invitation" || !!busy || isActiveJob(job)}
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
						disabled={!ready || !!busy || stage === "invitation" || isActiveJob(job)}
						onClick={() => void createMigrationPlan()}
					>
						<span className="migration-step-number">6</span>
						{t("migrationConfirmStep")}
					</Button>
					<p>{t("migrationLocalOnly")}</p>
				</nav>
				<div className="migration-main">
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
					{stage === "invitation" ? (
						<MigrationInvitation />
					) : stage === "select" ? (
						<>
							<h3>{t(`migrationKind.${kind}`)}</h3>
							<p className="migration-meta">{t(`migrationCategoryHelp.${kind}`)}</p>
							<div className={`migration-resource-layout${kind === "rules" ? " migration-resource-rules" : ""}`}>
								<CandidateList key={kind} />
								<PreviewPanel {...featureProps} />
							</div>
						</>
					) : stage === "review" ? (
						<FinalPlan />
					) : (
						<MigrationJobView {...featureProps} />
					)}
				</div>
			</div>
			<RecoveryReview />
			{recovery && recoveryExpired ? (
				<p className="migration-attention">{t("migrationDiagnostic.recovery-preview-expired")}</p>
			) : null}
			{recovery && error ? (
				<div role="alert" className="migration-danger">
					<DiagnosticList diagnostics={[{ code: error }]} />
				</div>
			) : null}
			<footer className="migration-dialog-foot">
				{recovery ? (
					<Button variant="secondary" disabled={!!busy} onClick={handleMigrationEscape}>
						{t("migrationCancelRecovery")}
					</Button>
				) : (
					<>
						<span className="migration-meta">{t("migrationSelected", { count: selected })}</span>
						{stage === "select" ? (
							<>
								<Button variant="secondary" disabled={!!busy} onClick={() => showMigrationStage("invitation")}>
									{t("migrationScanAgain")}
								</Button>
								<Button
									variant="primary"
									disabled={!ready || !!busy}
									onClick={() => void createMigrationPlan()}
								>
									{t("migrationReviewPlan")}
								</Button>
							</>
						) : null}
						{stage === "review" ? (
							<>
								<Button variant="secondary" disabled={!!busy} onClick={() => showMigrationStage("select")}>
									{t("migrationBackToSelection")}
								</Button>
								<Button
									variant="primary"
									disabled={!!busy || !plan || !planReady(plan, drafts)}
									onClick={() => void startMigrationJob()}
								>
									{t(busy === "start" ? "migrationStarting" : "migrationStart")}
								</Button>
							</>
						) : null}
						{origin === "onboarding" ? (
							<Button
								variant="secondary"
								disabled={finishing || !!busy}
								onClick={() => void finish(stage === "job" && !isActiveJob(job) ? "completed" : "skipped")}
							>
								{t(stage === "job" && !isActiveJob(job) ? "migrationFinish" : "migrationSkip")}
							</Button>
						) : (
							<Button variant="secondary" onClick={closeMigration}>
								{t("migrationHide")}
							</Button>
						)}
					</>
				)}
			</footer>
		</Modal>
	);
}
