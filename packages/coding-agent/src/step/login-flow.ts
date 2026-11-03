import { ProcessTerminal, type TUI, TuiMainScreen } from "@step-harness/pi-tui";
import { AuthStorage, readStoredCredential } from "../core/auth-storage.ts";
import {
	defaultStepCliClientInfo,
	loginStepOAuth,
	parseStepCliLoginState,
	STEP_PROVIDER_ID,
	STEP_STATIC_REFRESH_TOKEN,
	type StepCliLoginState,
} from "../features/step-provider/index.ts";
import { detectTerminalBackgroundFromEnv, initTheme, resolveThemeSetting, theme } from "../theme/theme.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { resolveStepAgentDir } from "./environment.ts";
import { buildStepLoginState, clearStepLoginState, saveStepLoginState } from "./login-state.ts";
import {
	INITIAL_STEP_LOGIN_STEP,
	isStepLoginSettled,
	reduceStepLogin,
	resolveStepLoginProfiles,
	type StepLoginEvent,
	type StepLoginProfile,
	type StepLoginProfileId,
	type StepLoginStep,
} from "./onboarding.ts";
import { StepOnboardingView } from "./onboarding-view.ts";
import { PlanUsageController, resolvePlanUsageAccount } from "./usage/account.ts";
import type { AccountUsageState } from "./usage/types.ts";
import { resolveStepCodeVersion } from "./version.ts";

export interface StepLoginHost {
	addChild(child: unknown): void;
	setFocus(child: unknown): void;
	requestRender(): void;
	start(): void | Promise<void>;
	stop(): void | Promise<void>;
	/** Clear a standalone login screen before another TUI takes over. */
	clearScreen?(): void;
}

export interface StepLoginOutcome {
	readonly kind: "completed" | "exit";
	readonly profile?: StepLoginProfile;
	readonly credentialsPath?: string;
	readonly warning?: string;
}

export interface RunStepLoginOptions {
	readonly authPath?: string;
	readonly createHost?: () => StepLoginHost;
	readonly now?: () => Date;
	readonly env?: Record<string, string | undefined>;
	readonly themeName?: string;
	/**
	 * Never try to launch a browser; only print the URL. Useful over SSH and in
	 * containers, where a launcher may "succeed" without a window ever appearing.
	 */
	readonly noBrowser?: boolean;
	/** Reuse the process account controller, including identity-scoped caching. */
	readonly planUsage?: PlanUsageController;
	/** A confirmed missing plan discovered during interactive startup. */
	readonly requiredPlan?: "step_plan" | "step_plan_oversea";
}

/**
 * Narrow the account session that rode along on the OAuth credentials.
 *
 * It arrives through an `unknown` bag, so it is validated here rather than
 * trusted. This is the *parsed* shape; the wire shape is validated where the
 * protocol defines it, in providers, so the two cannot drift apart.
 */
function readLoginState(value: unknown): StepCliLoginState | undefined {
	return parseStepCliLoginState(value);
}

/** Both warnings matter; showing only one hides why account features are gone. */
function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
	const present = warnings.filter((warning): warning is string => Boolean(warning));
	return present.length > 0 ? present.join("\n") : undefined;
}

/** Model discovery can return fallback models even when the account has no plan. */ export function getMissingStepPlanProfile(
	state: AccountUsageState,
): "step_plan" | "step_plan_oversea" | undefined {
	const { snapshot, account } = state;
	if (state.status !== "ready" || !snapshot || !account.eligible) return undefined;
	if (account.profile !== "step_plan" && account.profile !== "step_plan_oversea") return undefined;
	return snapshot.plan.state === "known" &&
		snapshot.plan.family === "none" &&
		snapshot.plan.subscription === null &&
		snapshot.quota.state === "known" &&
		!snapshot.quota.allowed &&
		snapshot.quota.reason === "no_active_subscription" &&
		snapshot.quota.credit_buckets?.length === 0
		? account.profile
		: undefined;
}

export function stepPlanCheckWarning(state: AccountUsageState): string | undefined {
	return state.account.eligible &&
		(state.status === "error" ||
			state.status === "stale" ||
			(state.snapshot?.plan.state === "unavailable" && !state.snapshot.quota.allowed))
		? `Could not verify Step Plan availability. ${state.message ?? "Retry with /usage account when online."}`
		: undefined;
}

export async function checkStepPlanBeforeInteractive(input: {
	readonly authPath: string;
	readonly interactive: boolean;
	readonly planUsage: PlanUsageController;
	readonly env?: Record<string, string | undefined>;
}): Promise<{ requiredPlan?: "step_plan" | "step_plan_oversea"; warning?: string }> {
	if (!input.interactive || (input.env ?? process.env).STEP_API_KEY?.trim()) return {};
	const profile = readStepLoginProfile(input.authPath);
	if (profile !== "step_plan" && profile !== "step_plan_oversea") return {};
	const state = await input.planUsage.query();
	return { requiredPlan: getMissingStepPlanProfile(state), warning: stepPlanCheckWarning(state) };
}

export async function writeStepLoginCredential(input: {
	authPath: string;
	profile: StepLoginProfileId;
	apiKey: string;
	uid?: string;
	obtainedAt?: string;
}): Promise<void> {
	const storage = AuthStorage.create(input.authPath);
	await storage.modify(STEP_PROVIDER_ID, async () => ({
		type: "oauth",
		access: input.apiKey.trim(),
		refresh: STEP_STATIC_REFRESH_TOKEN,
		expires: Number.MAX_SAFE_INTEGER,
		profile: input.profile,
		obtainedAt: input.obtainedAt ?? new Date().toISOString(),
		...(input.uid?.trim() ? { uid: input.uid.trim() } : {}),
	}));
}

export function readStepLoginProfile(authPath: string): StepLoginProfileId | undefined {
	const credential = readStoredCredential(STEP_PROVIDER_ID, authPath) as { profile?: unknown } | undefined;
	const profile = typeof credential?.profile === "string" ? credential.profile.trim() : "";
	if (profile === "step") return "step_plan";
	return resolveStepLoginProfiles().some((candidate) => candidate.id === profile)
		? (profile as StepLoginProfileId)
		: undefined;
}

export function readStepLoginCredential(
	authPath: string,
):
	| { readonly type: "oauth"; readonly access: string; readonly profile?: unknown; readonly uid?: unknown }
	| { readonly type: "api_key"; readonly key?: string }
	| undefined {
	const credential = readStoredCredential(STEP_PROVIDER_ID, authPath);
	if (!credential) return undefined;
	if (credential.type === "oauth" && typeof credential.access === "string" && credential.access.trim().length > 0)
		return credential;
	if (credential.type === "api_key" && typeof credential.key === "string" && credential.key.trim().length > 0)
		return credential;
	return undefined;
}

/** True only when the Step entrypoint is about to open an empty interactive session. */
export function isStepInteractiveLoginStartup(input: {
	readonly stdinIsTTY?: boolean;
	readonly stdoutIsTTY?: boolean;
	readonly args: {
		readonly help?: boolean;
		readonly version?: boolean;
		readonly export?: string;
		readonly listModels?: string | true;
		readonly sdkStdio?: boolean;
		readonly messages: readonly string[];
		readonly fileArgs: readonly string[];
		readonly print?: boolean;
		readonly mode?: string;
	};
}): boolean {
	return (
		input.stdinIsTTY === true &&
		input.stdoutIsTTY === true &&
		input.args.help !== true &&
		input.args.version !== true &&
		input.args.export === undefined &&
		input.args.listModels === undefined &&
		input.args.sdkStdio !== true &&
		input.args.messages.length === 0 &&
		input.args.fileArgs.length === 0 &&
		input.args.print !== true &&
		input.args.mode !== "json" &&
		input.args.mode !== "rpc"
	);
}

export function needsStepLoginBeforeInteractive(input: {
	readonly authPath: string;
	readonly interactive: boolean;
	readonly env?: Record<string, string | undefined>;
}): boolean {
	if (!input.interactive) return false;
	if (input.env?.STEP_API_KEY?.trim()) return false;
	return readStepLoginCredential(input.authPath) === undefined;
}

/**
 * Update the provider endpoint hints used by the Step extension on reload.
 *
 * Both the model endpoint and the developer-center login page follow the stored
 * profile, so a mainland and an overseas plan never cross regions.
 */
export function syncStepLoginProfileEndpoint(
	authPath: string,
	env: Record<string, string | undefined> = process.env,
): void {
	const profileId = readStepLoginProfile(authPath);
	const profile = profileId
		? resolveStepLoginProfiles(env).find((candidate) => candidate.id === profileId)
		: undefined;
	if (!profile) {
		delete env.STEP_LOGIN_PROFILE_API_URL;
		delete env.STEP_LOGIN_PROFILE_AUTH_URL;
		return;
	}
	env.STEP_LOGIN_PROFILE_API_URL = profile.baseUrl;
	env.STEP_LOGIN_PROFILE_AUTH_URL = profile.authBaseUrl;
}

export async function runStepLogin(options: RunStepLoginOptions = {}): Promise<StepLoginOutcome> {
	const authPath = options.authPath ?? "auth.json";
	const profiles = resolveStepLoginProfiles(options.env);
	const host = options.createHost?.() ?? createStandaloneStepHost();
	// `step login` runs before main() initializes the product theme. Reusing the
	// configured theme is safe in-session; only initialize when this is the first
	// renderer in the process.
	try {
		theme.fg("text", "");
	} catch {
		const terminalTheme = detectTerminalBackgroundFromEnv({ env: options.env }).theme;
		const themeName = resolveThemeSetting(options.themeName ?? "dark", terminalTheme) ?? "dark";
		initTheme(themeName, false);
	}

	let step: StepLoginStep = options.requiredPlan
		? { kind: "planRequired", choice: options.requiredPlan }
		: INITIAL_STEP_LOGIN_STEP;
	const planUsage = options.planUsage ?? new PlanUsageController(() => resolvePlanUsageAccount(authPath, options.env));
	let browserAbort: AbortController | undefined;
	let savedProfile = options.requiredPlan
		? profiles.find((profile) => profile.id === options.requiredPlan)
		: undefined;
	let savedPath = options.requiredPlan ? authPath : undefined;
	let warning: string | undefined;
	/** Set when sign-in succeeded but the account session could not be stored. */
	let loginWarning: string | undefined;
	let settle: ((outcome: StepLoginOutcome) => void) | undefined;
	const finished = new Promise<StepLoginOutcome>((resolve) => {
		settle = resolve;
	});

	const view = new StepOnboardingView(profiles, {
		onChoose: (choice) => dispatch({ type: "choose", choice }),
		onSubmitApiKey: (apiKey) => dispatch({ type: "credential", apiKey }),
		onType: (text) => dispatch({ type: "type", text }),
		onBackspace: () => dispatch({ type: "backspace" }),
		onBack: () => dispatch({ type: "back" }),
		onQuit: () => dispatch({ type: "quit" }),
		onRetryPlan: () => dispatch({ type: "checkPlan" }),
		onOpenPlan: () => {
			if (step.kind !== "planRequired" || options.noBrowser) return;
			const choice = step.choice;
			const profile = profiles.find((candidate) => candidate.id === choice);
			if (profile) openBrowser(`${profile.authBaseUrl}/step-plan`);
		},
		requestRender: () => host.requestRender(),
	});

	function dispatch(event: StepLoginEvent): void {
		const previous = step;
		step = reduceStepLogin(previous, event);
		if (step === previous) return;
		if (previous.kind === "checkingPlan") planUsage.cancel();
		view.setStep(step);
		host.requestRender();
		void runEffects(previous, step, event);
	}

	async function runEffects(previous: StepLoginStep, next: StepLoginStep, event: StepLoginEvent): Promise<void> {
		if (previous.kind === "continueInBrowser" && next.kind !== "continueInBrowser") {
			browserAbort?.abort();
			browserAbort = undefined;
		}
		if (next.kind === "continueInBrowser" && previous.kind !== next.kind) {
			await beginBrowserLogin(next.choice);
			return;
		}
		if (next.kind === "saving") {
			const apiKey = event.type === "credential" ? event.apiKey.trim() : "";
			await persist(
				next.choice,
				apiKey,
				event.type === "credential" ? event.uid : undefined,
				event.type === "credential" ? event.login : undefined,
				event.type === "credential" ? event.loginError : undefined,
			);
			return;
		}
		if (next.kind === "checkingPlan") {
			const account = await planUsage.query(true);
			// Esc, cancellation, or a replacement login owns the view now.
			if (step !== next) return;
			// A failed account-session save is reported alongside the plan check,
			// not replaced by it: only the browser path can carry a session, and
			// that is exactly the path that runs this check.
			warning = combineWarnings(stepPlanCheckWarning(account), loginWarning);
			dispatch({ type: getMissingStepPlanProfile(account) ? "planRequired" : "saved" });
			return;
		}
		if (isStepLoginSettled(next)) {
			settle?.(
				next.kind === "done"
					? {
							kind: "completed",
							profile: savedProfile,
							credentialsPath: savedPath,
							...(warning ? { warning } : {}),
						}
					: { kind: "exit" },
			);
		}
	}

	async function beginBrowserLogin(choice: StepLoginProfileId): Promise<void> {
		const profile = profiles.find((candidate) => candidate.id === choice);
		if (!profile) return;
		const controller = new AbortController();
		browserAbort = controller;
		try {
			const credential = await loginStepOAuth(
				{
					signal: controller.signal,
					onAuth: ({ url }) => {
						// Show the URL before launching anything: if the launcher hangs or
						// the host has no browser, the user still has something to copy.
						dispatch({ type: "browserOpened", authUrl: url });
						if (!options.noBrowser) openBrowser(url);
					},
					onDeviceCode: () => {},
					// Cloud login never prompts for a callback URL or opens a local port.
					onPrompt: async () => "",
					onSelect: async () => undefined,
				},
				{
					apiBaseUrl: profile.baseUrl,
					authBaseUrl: profile.authBaseUrl,
					env: options.env ?? process.env,
					loginProfile: choice,
					client: defaultStepCliClientInfo(resolveStepCodeVersion(options.env).value),
				},
			);
			dispatch({
				type: "credential",
				apiKey: credential.access,
				uid: typeof credential.uid === "string" ? credential.uid : undefined,
				// Absent on backends that predate the account session; the login
				// then completes with the API key alone, as it always has.
				login: readLoginState(credential.login),
				loginError: typeof credential.loginError === "string" ? credential.loginError : undefined,
			});
		} catch (error) {
			if (!controller.signal.aborted)
				dispatch({ type: "fail", message: error instanceof Error ? error.message : String(error) });
		}
	}

	async function persist(
		choice: StepLoginProfileId,
		apiKey: string,
		uid?: string,
		login?: StepCliLoginState,
		loginError?: string,
	): Promise<void> {
		const saving = step;
		try {
			const profile = profiles.find((candidate) => candidate.id === choice);
			if (!profile) throw new Error(`Unknown Step login profile: ${choice}`);
			await writeStepLoginCredential({
				authPath,
				profile: choice,
				apiKey,
				...(uid ? { uid } : {}),
				obtainedAt: (options.now ?? (() => new Date()))().toISOString(),
			});
			// The account session is a separate file on purpose: it expires and
			// refreshes on its own, and losing it must never cost the API key. Every
			// failure here is a warning, never a failed sign-in — the key is already
			// written by this point.
			//
			// Any previous session is dropped first. Signing in again — as another
			// account, or with a profile that carries no session at all — must not
			// leave the old account's session behind, or a host would read an
			// identity that does not match the API key just written.
			const rejected = loginError ? `The server rejected the account session (${loginError}).` : undefined;
			const staleSession = "A previous account session may still be on disk and could be used by account features.";
			let cleared = false;
			try {
				cleared = await clearStepLoginState(options.env ?? process.env);
				const written = login
					? await saveStepLoginState(buildStepLoginState(login, choice), options.env ?? process.env)
					: true;
				// A written session has already replaced whatever was there, so an
				// unsuccessful clear is irrelevant in that case. Only a session that
				// was neither written nor cleared leaves the old account's behind.
				const replaced = cleared || (login !== undefined && written);
				loginWarning = combineWarnings(
					login && !written
						? "Signed in, but the account session could not be written. Account features will ask you to sign in again."
						: undefined,
					replaced ? undefined : staleSession,
					rejected,
				);
			} catch (error) {
				loginWarning = combineWarnings(
					`Signed in, but the account session could not be saved: ${
						error instanceof Error ? error.message : String(error)
					}.`,
					cleared ? "Account features will ask you to sign in again." : staleSession,
					rejected,
				);
			}
			if (step !== saving) return;
			savedProfile = profile;
			savedPath = authPath;
			warning = loginWarning;
			syncStepLoginProfileEndpoint(authPath, options.env ?? process.env);
			dispatch({ type: profile.credentialSource === "browser" ? "checkPlan" : "saved" });
		} catch (error) {
			if (step !== saving) return;
			dispatch({
				type: "fail",
				message: `Could not save credentials: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	view.setStep(step);
	host.addChild(view);
	host.setFocus(view);
	try {
		await host.start();
		return await finished;
	} finally {
		browserAbort?.abort();
		planUsage.cancel();
		await host.stop();
		host.clearScreen?.();
	}
}

/**
 * A screen of its own for a startup flow that runs before the main UI exists.
 *
 * `preserveScreen` plus an explicit clear is what keeps these screens from
 * bleeding into whatever renders next: the login, the MCP import offer and the
 * theme picker each own the terminal for their turn and hand it back empty.
 */
export function createStandaloneStepHost(): StepLoginHost {
	const ui = new TuiMainScreen(new ProcessTerminal(), undefined, resolveStepAgentDir());
	return {
		addChild: (child) => ui.addChild(child as Parameters<TUI["addChild"]>[0]),
		setFocus: (child) => ui.setFocus(child as Parameters<TUI["setFocus"]>[0]),
		requestRender: () => ui.requestRender(),
		start: () => ui.start(),
		stop: () => ui.stop({ preserveScreen: true }),
		clearScreen: () => ui.terminal.clearScreen(),
	};
}
