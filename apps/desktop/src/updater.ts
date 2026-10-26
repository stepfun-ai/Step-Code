/**
 * The desktop app's own updates, on electron-updater.
 *
 * macOS installs through Squirrel.Mac (MacUpdater, from the `.zip` payload),
 * Windows through the NSIS installer run with `--updated` (NsisUpdater). Both
 * need a signed build: Squirrel.Mac only accepts an update signed by the same
 * Developer ID as the running app, and on Windows the downloaded installer
 * must be Authenticode-signed by the publisher named in app-update.yml
 * (written by scripts/package.mjs). The release CI produces exactly those.
 *
 * The channel is the pipeline's single `latest.json` (update-feed.ts), read by
 * `ReleaseManifestProvider`, a custom electron-updater provider; the payload's
 * SHA-512 and size come from the same manifest.
 *
 * One instance per app. It owns the `DesktopUpdateState` the page renders
 * (`@step-harness/web/desktop-bridge`) and pushes every change through
 * `onState`. Background checks never download: only the user moves it past
 * `available`, and only the user's restart (or quitting after a download)
 * installs.
 */

import { appendFileSync, existsSync } from "node:fs";
import type { DesktopUpdateState } from "@step-harness/web/desktop-bridge";
import {
	type AppUpdater,
	MacUpdater,
	NsisUpdater,
	type ProgressInfo,
	Provider,
	type ResolvedUpdateFileInfo,
	type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { assertUpdateUrl, assetsFor, installBlocker, manifestUrl, parseRelease } from "./update-feed.ts";

/** First background check after start, then the interval between checks. */
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Options electron-updater hands to a custom provider (`setFeedURL`). */
interface ReleaseFeedOptions {
	readonly provider: "custom";
	readonly url?: unknown;
}

/**
 * Reads the pipeline's `latest.json` and offers this platform's payloads.
 * electron-updater compares the version, downloads, checks SHA-512 and installs.
 */
export class ReleaseManifestProvider extends Provider<UpdateInfo> {
	readonly #manifest: URL;

	constructor(options: ReleaseFeedOptions, _updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
		super(runtimeOptions);
		if (typeof options.url !== "string") throw new Error("update feed URL missing");
		this.#manifest = manifestUrl(options.url);
	}

	async getLatestVersion(): Promise<UpdateInfo> {
		// The pointer is replaced in place on every release; never take a cached copy.
		const url = new URL(this.#manifest);
		url.searchParams.set("noCache", Date.now().toString(36));
		const body = await this.httpRequest(url, { accept: "application/json", "cache-control": "no-cache" });
		if (!body) throw new Error(`empty update manifest at ${this.#manifest.href}`);
		const release = parseRelease(JSON.parse(body), this.#manifest);
		const files = assetsFor(release, process.platform).map((asset) => ({
			url: asset.url,
			sha512: asset.sha512,
			size: asset.size,
		}));
		const first = files[0];
		if (first === undefined) throw new Error(`StepCode ${release.version} has no update for ${process.platform}`);
		return {
			version: release.version,
			files,
			path: first.url,
			sha512: first.sha512,
			releaseDate: release.releaseDate ?? new Date(0).toISOString(),
		};
	}

	resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
		return updateInfo.files.map((info) => ({ url: assertUpdateUrl(info.url), info }));
	}
}

export interface UpdaterOptions {
	/** Channel directory (`.../stepcode/desktop/`); undefined disables updates. */
	readonly feed: string | undefined;
	/** Why updates are off when `feed` is undefined (e.g. "development build"). */
	readonly disabledReason?: string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	/** `process.execPath` of the app. */
	readonly executable: string;
	/**
	 * electron-updater's `resources/app-update.yml` (cache folder; the Windows
	 * publisher check). Only builds packaged with an update feed carry it.
	 */
	readonly configPath: string;
	/** electron-updater's own log, for diagnosing a failed update. */
	readonly logPath: string;
	readonly onState: (state: DesktopUpdateState) => void;
	/**
	 * Stop what holds the app's files (the web server and its children) before
	 * the installer runs; the quit that follows must not wait on it again.
	 */
	readonly prepareQuit: () => Promise<void>;
}

/** The payload this machine will download, for the size shown before downloading. */
function payloadSize(info: UpdateInfo, arch: string): number {
	const own = info.files.find((file) => file.url.includes(`-${arch}.`));
	return own?.size ?? info.files[0]?.size ?? 0;
}

export class DesktopUpdater {
	readonly #options: UpdaterOptions;
	#state: DesktopUpdateState;
	#updater: AppUpdater | undefined;
	#available: UpdateInfo | undefined;
	/** The version electron-updater has downloaded and staged, kept through a failed restart. */
	#readyVersion: string | undefined;
	#checking: Promise<DesktopUpdateState> | undefined;
	#downloading: Promise<void> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#lastCheckedAt: number | undefined;

	constructor(options: UpdaterOptions) {
		this.#options = options;
		const reason =
			options.feed === undefined
				? (options.disabledReason ?? "this build has no update feed")
				: !existsSync(options.configPath)
					? "this build was packaged without an update feed (no app-update.yml)"
					: installBlocker(options.platform, options.executable);
		this.#state = reason === undefined ? { phase: "idle" } : { phase: "disabled", reason };
	}

	get state(): DesktopUpdateState {
		return this.#state;
	}

	#set(state: DesktopUpdateState): void {
		this.#state = state;
		this.#options.onState(state);
	}

	#log(level: string, text: unknown): void {
		try {
			appendFileSync(this.#options.logPath, `${new Date().toISOString()} ${level} ${String(text)}\n`);
		} catch {
			// The log is diagnostics only; an unwritable log folder must not break updates.
		}
	}

	#create(feed: string): AppUpdater {
		const updater = this.#options.platform === "darwin" ? new MacUpdater() : new NsisUpdater();
		updater.logger = {
			info: (text) => this.#log("info", text),
			warn: (text) => this.#log("warn", text),
			error: (text) => this.#log("error", text),
		};
		updater.autoDownload = false;
		// A downloaded update installs when the user quits, as well as on "Restart".
		updater.autoInstallOnAppQuit = true;
		updater.allowDowngrade = false;
		updater.allowPrerelease = false;
		// No blockmaps are published; differential download would only add a failed request.
		updater.disableDifferentialDownload = true;
		updater.setFeedURL({ provider: "custom", updateProvider: ReleaseManifestProvider, url: feed });
		// electron-updater also rejects the promise of the failed operation; that is where
		// failures are reported. An "error" event without a listener would crash the process.
		updater.on("error", (error) => this.#log("error", message(error)));
		updater.on("download-progress", (progress: ProgressInfo) => this.#progress(progress));
		updater.on("update-downloaded", (info: UpdateInfo) => {
			this.#readyVersion = info.version;
			this.#set({ phase: "ready", version: info.version });
		});
		return updater;
	}

	/** Check once the app has settled, then periodically. */
	start(): void {
		const feed = this.#options.feed;
		if (this.#state.phase === "disabled" || feed === undefined || this.#updater !== undefined) return;
		try {
			this.#updater = this.#create(feed);
		} catch (error) {
			this.#set({ phase: "disabled", reason: `updater unavailable: ${message(error)}` });
			return;
		}
		const schedule = (delay: number) => {
			this.#timer = setTimeout(() => {
				void this.check(false).finally(() => schedule(CHECK_INTERVAL_MS));
			}, delay);
			this.#timer.unref();
		};
		schedule(FIRST_CHECK_DELAY_MS);
	}

	stop(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/**
	 * Ask the feed. `manual` checks report failures as `error`; background checks
	 * keep what they had and only log. Joins a check already running.
	 */
	check(manual: boolean): Promise<DesktopUpdateState> {
		const phase = this.#state.phase;
		if (phase === "disabled" || phase === "downloading" || phase === "installing" || phase === "restarting") {
			return Promise.resolve(this.#state);
		}
		if (phase === "ready") return Promise.resolve(this.#state);
		this.#checking ??= this.#check(manual).finally(() => {
			this.#checking = undefined;
		});
		return this.#checking;
	}

	async #check(manual: boolean): Promise<DesktopUpdateState> {
		const updater = this.#updater;
		if (updater === undefined) return this.#state;
		const previous = this.#state;
		this.#set({ phase: "checking" });
		try {
			const result = await updater.checkForUpdates();
			this.#lastCheckedAt = Date.now();
			if (result === null || !result.isUpdateAvailable) {
				this.#available = undefined;
				this.#set({ phase: "idle", checkedAt: this.#lastCheckedAt });
			} else {
				this.#available = result.updateInfo;
				this.#set({
					phase: "available",
					version: result.updateInfo.version,
					size: payloadSize(result.updateInfo, this.#options.arch),
				});
			}
		} catch (error) {
			this.#log("warn", `update check failed: ${message(error)}`);
			if (manual) this.#set({ phase: "error", operation: "check", message: message(error) });
			else if (previous.phase === "available") this.#set(previous);
			else this.#set({ phase: "idle", ...(this.#lastCheckedAt ? { checkedAt: this.#lastCheckedAt } : {}) });
		}
		return this.#state;
	}

	#progress(progress: ProgressInfo): void {
		const version = this.#available?.version;
		if (version === undefined) return;
		// The last bytes are followed by the SHA-512 check and, on macOS, Squirrel's staging.
		if (progress.total > 0 && progress.transferred >= progress.total) {
			if (this.#state.phase === "downloading") this.#set({ phase: "installing", version });
			return;
		}
		this.#set({ phase: "downloading", version, received: progress.transferred, size: progress.total });
	}

	/** Download, verify and stage the available version. Joins a download already running. */
	download(): Promise<void> {
		this.#downloading ??= this.#download().finally(() => {
			this.#downloading = undefined;
		});
		return this.#downloading;
	}

	async #download(): Promise<void> {
		const updater = this.#updater;
		const info = this.#available;
		const retry = this.#state.phase === "error" && this.#state.operation === "download";
		if (updater === undefined || info === undefined || !(this.#state.phase === "available" || retry)) return;
		const size = payloadSize(info, this.#options.arch);
		this.#set({ phase: "downloading", version: info.version, received: 0, size });
		try {
			await updater.downloadUpdate();
			// Squirrel.Mac may still be staging; `update-downloaded` moves on to `ready`.
			if (this.#state.phase === "downloading") this.#set({ phase: "installing", version: info.version });
		} catch (error) {
			this.#log("error", `update download failed: ${message(error)}`);
			this.#set({ phase: "error", operation: "download", message: message(error), version: info.version });
			throw error;
		}
	}

	/** Stop the server, then quit into the installer and start the new version. */
	async restart(): Promise<void> {
		const updater = this.#updater;
		const version = this.#readyVersion;
		if (updater === undefined || version === undefined || this.#state.phase === "restarting") {
			throw new Error("No update is ready to install");
		}
		this.#set({ phase: "restarting", version });
		try {
			await this.#options.prepareQuit();
			this.stop();
			// Silent install into the same folder, then start the app (Windows); Squirrel relaunches on macOS.
			updater.quitAndInstall(true, true);
		} catch (error) {
			this.#set({ phase: "error", operation: "restart", message: message(error), version });
			throw error;
		}
	}
}
