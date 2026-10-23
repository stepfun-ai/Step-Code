import { type FormEvent, useEffect, useRef, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { setState, useAppStore } from "../../state/store";
import type { LoginMethod, LoginReport } from "../../state/types";
import { Icon, IconButton, Spinner, Tooltip } from "../../ui";
import { cancelBrowserSignIn, openLoginPage, signInWithApiKey, signInWithBrowser } from "../login/actions";
import { canLogout, logout, stepPlanUrl } from "../shell/actions";
import { useSettingsResource } from "./actions";
import { PageHeader, ResourceState, SectionHeader, StatusDot } from "./parts";
import "./account.css";

const SESSION_LABELS: Readonly<Record<LoginReport["session"]["state"], string>> = {
	ready: "settingsAccountSessionReady",
	expiring: "settingsAccountSessionExpiring",
	expired: "settingsAccountSessionExpired",
	missing: "settingsAccountSessionMissing",
};

const PROFILE_LABELS: Readonly<Record<string, string>> = {
	step_plan: "settingsAccountStepPlanCn",
	step_plan_oversea: "settingsAccountStepPlanGlobal",
	platform_cn: "settingsAccountPlatformCn",
	platform_oversea: "settingsAccountPlatformGlobal",
};

function accountLabel(t: TranslateFn, login: LoginReport | null): string {
	if (!login?.configured) return t("settingsAccountNone");
	if (login.source === "environment") return t("settingsAccountEnvironment");
	const key = login.profile ? PROFILE_LABELS[login.profile] : undefined;
	return typeof key === "string" ? t(key) : (login.provider ?? t("settingsAccountSignedIn"));
}

export function AccountPage() {
	const t = useT();
	const login = useAppStore((state) => state.login);
	const running = useAppStore((state) =>
		[...state.statusById.values()].some((status) => status === "running" || status === "waiting"),
	);
	const methods = useSettingsResource<{ methods: readonly LoginMethod[] }>("/api/v1/login/methods", true);
	const [profile, setProfile] = useState<string>(login?.profile ?? "step_plan");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [authUrl, setAuthUrl] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [warning, setWarning] = useState("");
	const [refreshing, setRefreshing] = useState(true);
	const [refreshError, setRefreshError] = useState("");
	const [revision, setRevision] = useState(0);
	const request = useRef<{ controller: AbortController; browser: boolean } | null>(null);
	const active = useRef(false);
	const selected = methods.data?.methods.find((method) => method.id === profile);
	const environment = login?.source === "environment";
	const disabled = busy || running || environment || refreshing || !!refreshError;
	// Signed in with the selected method already: signing in is a repair, not the page's main action.
	const current = Boolean(login?.configured && login.validity !== "invalid" && login.profile === profile);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a fresh host credential report.
	useEffect(() => {
		active.current = true;
		const controller = new AbortController();
		api<LoginReport>("/api/v1/login", { signal: controller.signal }).then(
			(report) => {
				if (controller.signal.aborted) return;
				setState({ login: report });
				setRefreshing(false);
			},
			(caught: unknown) => {
				if (controller.signal.aborted) return;
				setRefreshError(errorMessage(caught));
				setRefreshing(false);
			},
		);
		return () => {
			active.current = false;
			controller.abort();
			request.current?.controller.abort();
			if (request.current?.browser) cancelBrowserSignIn();
			request.current = null;
		};
	}, [revision]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!selected || disabled || request.current || (selected.credentialSource === "apiKey" && !apiKey.trim()))
			return;
		const entry = { controller: new AbortController(), browser: selected.credentialSource === "browser" };
		request.current = entry;
		setBusy(true);
		setError("");
		setNotice("");
		setWarning("");
		try {
			if (entry.browser) {
				const outcome = await signInWithBrowser(selected.id, setAuthUrl, entry.controller.signal);
				if (!entry.controller.signal.aborted && outcome.outcome === "completed") {
					if (outcome.warning) setWarning(t("settingsAccountSessionWarning"));
					else setNotice(t("settingsAccountSaved"));
				}
			} else {
				const outcome = await signInWithApiKey(selected.id, apiKey.trim(), entry.controller.signal);
				if (entry.controller.signal.aborted) return;
				setApiKey("");
				if (outcome.kind === "ok") {
					if (outcome.warning) setWarning(t("settingsAccountSessionWarning"));
					else setNotice(t("settingsAccountSaved"));
				} else if (outcome.kind === "invalid") setError(t("loginInvalidKey"));
				else if (outcome.kind === "unavailable") setError(t("loginUnavailable"));
				else setError(t("loginFailed", { error: outcome.message }));
			}
		} catch (caught) {
			if (!entry.controller.signal.aborted) setError(t("loginFailed", { error: errorMessage(caught) }));
		} finally {
			if (request.current === entry) request.current = null;
			if (active.current) {
				setBusy(false);
				setAuthUrl("");
			}
		}
	};

	const cancel = () => {
		request.current?.controller.abort();
		if (request.current?.browser) cancelBrowserSignIn();
		// Keep the request locked until it settles, so a late DELETE cannot cancel a new attempt.
		setAuthUrl("");
	};

	const verified = login?.configured && login.validity === "valid";
	const rejected = login?.configured && login.validity === "invalid";
	const removable = canLogout(login);
	const status = !login?.configured
		? "settingsAccountNone"
		: verified
			? "settingsAccountSignedIn"
			: rejected
				? "settingsAccountInvalid"
				: "settingsAccountUnverified";

	return (
		<>
			<PageHeader
				title={t("settingsAccount")}
				description={t("settingsAccountDesc")}
				actions={
					<Tooltip content={t("settingsAccountRefresh")}>
						<IconButton
							icon="refresh"
							aria-label={t("settingsAccountRefresh")}
							disabled={busy || refreshing}
							onClick={() => {
								setRefreshing(true);
								setRefreshError("");
								setRevision((value) => value + 1);
							}}
						/>
					</Tooltip>
				}
			/>
			<section className="settings-account-identity" aria-label={t("settingsAccountCurrent")}>
				<span className="settings-account-logo">
					<Icon name="stepPlatform" />
				</span>
				<div className="settings-account-identity-text">
					<strong id="settingsAccountLabel">{accountLabel(t, login)}</strong>
					{/* Signed out, the label above already says so; the line points at the way in instead. */}
					<StatusDot
						tone={verified ? "success" : rejected ? "danger" : "off"}
						label={login?.configured ? t(status) : t("settingsAccountConnectHint")}
					/>
					{login?.userId && (
						<span className="settings-account-uid">{t("settingsAccountUid", { uid: login.userId })}</span>
					)}
					{login?.session && (
						<span className="settings-account-uid" id="settingsAccountSession">
							{t("settingsAccountSession", {
								state: t(SESSION_LABELS[login.session.state]),
							})}
						</span>
					)}
				</div>
				{/* Nothing to sign out of without an account. */}
				{login?.configured ? (
					<Tooltip content={t(removable ? "settingsLogoutDesc" : "settingsLogoutUnavailable")}>
						<button
							type="button"
							className="settings-btn settings-account-logout"
							id="logoutButton"
							disabled={busy || !removable}
							onClick={() => void logout()}
						>
							<Icon name="accountLogout" size="xs" />
							{t("logout")}
						</button>
					</Tooltip>
				) : null}
			</section>
			{login?.configured &&
				login.profile?.startsWith("step_plan") &&
				(login.session?.state === "expired" || login.session?.state === "missing") && (
					<p className="settings-account-note">{t("settingsAccountSessionMissingHint")}</p>
				)}
			{refreshing && (
				<output className="settings-loading">
					<Spinner />
					{t("settingsAccountLoading")}
				</output>
			)}
			{refreshError && (
				<div className="settings-alert danger" role="alert">
					{refreshError}
				</div>
			)}

			<SectionHeader title={t("settingsAccountMethods")} />
			<ResourceState
				loading={methods.loading}
				error={methods.error}
				hasData={!!methods.data}
				loadingLabel={t("settingsAccountLoading")}
			/>
			{methods.error && (
				<button type="button" className="settings-btn" onClick={methods.reload}>
					<Icon name="refresh" size="xs" />
					{t("settingsAccountRetry")}
				</button>
			)}
			{methods.data && (
				<form className="settings-account-form" onSubmit={(event) => void submit(event)}>
					<fieldset className="settings-account-channels" aria-label={t("settingsAccountMethods")}>
						{methods.data.methods.map((method) => (
							<button
								type="button"
								key={method.id}
								data-login-profile={method.id}
								className={cx("settings-account-channel", profile === method.id && "active")}
								aria-pressed={profile === method.id}
								disabled={disabled}
								onClick={() => {
									setProfile(method.id);
									setApiKey("");
									setError("");
									setNotice("");
								}}
							>
								<span className="settings-account-channel-top">
									<Icon name={method.credentialSource === "browser" ? "stepPlatform" : "keyRound"} size="sm" />
									<span>{t(method.region === "cn" ? "loginRegionCn" : "loginRegionGlobal")}</span>
									<span className="settings-account-channel-check">
										{profile === method.id && <Icon name="accountCheck" size="xs" />}
									</span>
								</span>
								<strong>{method.credentialSource === "browser" ? "Step Plan" : t("loginApiKeyLabel")}</strong>
								<small>
									{t(
										method.credentialSource === "browser"
											? "settingsAccountBrowserAuth"
											: "settingsAccountApiAuth",
									)}
								</small>
							</button>
						))}
					</fieldset>
					{environment && <p className="settings-account-note">{t("settingsAccountEnvironmentHint")}</p>}
					{running && <p className="settings-account-note">{t("settingsAccountBusy")}</p>}
					<div className="settings-account-login-area" key={profile}>
						{selected?.credentialSource === "apiKey" && (
							<label className="settings-field" htmlFor="settingsAccountKey">
								<span>{t("loginApiKeyLabel")}</span>
								<input
									id="settingsAccountKey"
									type="password"
									autoComplete="off"
									spellCheck={false}
									value={apiKey}
									disabled={disabled}
									onChange={(event) => {
										setApiKey(event.currentTarget.value);
										setError("");
										setNotice("");
									}}
								/>
							</label>
						)}
						<div className="settings-account-actions">
							<button
								type="submit"
								className={current ? "settings-btn" : "settings-btn primary"}
								id="settingsAccountLogin"
								disabled={disabled || !selected || (selected.credentialSource === "apiKey" && !apiKey.trim())}
							>
								{busy ? <Spinner /> : <Icon name="accountExternal" size="xs" />}
								{t(
									busy
										? selected?.credentialSource === "browser"
											? "loginBrowserWaiting"
											: "loginVerifying"
										: current
											? "settingsAccountSignInAgain"
											: "settingsAccountSignIn",
								)}
							</button>
							{busy && selected?.credentialSource === "browser" && (
								<button type="button" className="settings-btn" onClick={cancel}>
									{t("loginCancel")}
								</button>
							)}
							{authUrl && (
								<button type="button" className="settings-btn" onClick={() => openLoginPage(authUrl)}>
									{t("loginBrowserReopen")}
								</button>
							)}
							{selected?.credentialSource === "apiKey" && (
								<button
									type="button"
									className="settings-link"
									onClick={() => openLoginPage(selected.keyPageUrl)}
								>
									{t("loginGetApiKey")}
								</button>
							)}
						</div>
						{error && (
							<div className="settings-alert danger" role="alert">
								{error}
							</div>
						)}
						{warning && <output className="settings-account-notice">{warning}</output>}
						{notice && <output className="settings-account-notice">{notice}</output>}
					</div>
				</form>
			)}
			<div className="settings-account-links">
				<a
					className="settings-link"
					id="stepPlanLink"
					href={stepPlanUrl(login)}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Icon name="accountExternal" size="xs" />
					{t("upgrade")}
				</a>
			</div>
		</>
	);
}
