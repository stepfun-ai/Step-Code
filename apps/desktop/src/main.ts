/**
 * StepCode desktop: an Electron shell around the StepCode web app.
 *
 * Lifecycle
 *   1. Claim the single-instance lock; a second launch focuses the first.
 *   2. Show the window with a local "starting" page.
 *   3. Start apps/web's server under Electron's Node (server-host.ts) with the
 *      user's login-shell environment, on a free loopback port.
 *   4. Load http://127.0.0.1:<port>/#token=<launch token>; the React client
 *      exchanges the token for its auth cookie and runs exactly as in a browser,
 *      plus window.stepcodeDesktop from the preload.
 *   5. On quit, stop the server (SIGTERM, then SIGKILL after 5 s).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, type BrowserWindow, shell } from "electron";
import { installDesktopIpc } from "./ipc.ts";
import { installApplicationMenu } from "./menu.ts";
import { addBundledNodeToPath } from "./node-environment.ts";
import { errorPageUrl, loadingPageUrl } from "./pages.ts";
import { readReleaseEnvelope } from "./release-envelope.ts";
import { launchWebServer, type RunningWebServer, resolveNodeExecutable, resolveWebServerEntry } from "./server-host.ts";
import { readShellEnvironment } from "./shell-environment.ts";
import { DesktopStateStore } from "./state.ts";
import { createMainWindow } from "./window.ts";

const userDataOverride = process.env.STEPCODE_DESKTOP_USER_DATA_DIR?.trim();
if (userDataOverride) {
	app.setPath("userData", resolve(userDataOverride));
	app.setAppLogsPath(join(resolve(userDataOverride), "logs"));
}

/** STEPCODE_DESKTOP_SMOKE=1: load the app hidden, report what the page sees, then quit. */
const smoke = process.env.STEPCODE_DESKTOP_SMOKE === "1";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const preload = join(here, "preload.cjs");
	// resources/ sits beside dist/ both in the source tree and in the packaged app.
	const icon = join(here, "..", "resources", "icon.png");
	const state = new DesktopStateStore(join(app.getPath("userData"), "desktop-state.json"));
	const logPath = join(app.getPath("logs"), "web-server.log");
	// Started before `ready` so the shell probe overlaps Electron's own startup.
	const shellEnvironment = readShellEnvironment(process.env);

	let window: BrowserWindow | undefined;
	let server: RunningWebServer | undefined;
	let launchUrlUsed = false;
	let restarting: Promise<void> | undefined;
	let quitting = false;
	let shutdownComplete = false;

	const showError = (title: string, detail: string): void => {
		console.error(`[desktop] ${title}\n${detail}`);
		if (window !== undefined && !window.isDestroyed()) void window.loadURL(errorPageUrl(title, detail, logPath));
	};

	/**
	 * The launch token is single-use. The first load carries it; later loads
	 * (a recreated macOS window) rely on the cookie it was exchanged for.
	 */
	const appUrl = (): string | undefined => {
		if (server === undefined) return undefined;
		if (launchUrlUsed) return `${server.origin}/`;
		launchUrlUsed = true;
		return server.launchUrl;
	};

	const loadApp = (target: BrowserWindow): void => {
		const url = appUrl();
		if (url === undefined || target.isDestroyed()) return;
		target.loadURL(url).catch((error: unknown) => {
			// ERR_ABORTED means another navigation replaced this one, which is fine.
			if (!message(error).includes("ERR_ABORTED")) showError("StepCode could not load the app", message(error));
		});
	};

	const startServer = async (): Promise<void> => {
		const entry = resolveWebServerEntry(
			process.env,
			app.isPackaged ? join(process.resourcesPath, "server") : undefined,
		);
		// The installer's envelope is the only source of installed-build identity
		// (launchWebServer applies the same file to the server's environment).
		const release = readReleaseEnvelope(dirname(entry));
		if (release !== undefined) {
			const install = release.installSource === undefined ? "" : `, ${release.installSource}`;
			console.info(`[desktop] release ${release.version} (channel ${release.channel}${install})`);
		}
		const publicDir = process.env.STEPCODE_WEB_PUBLIC_DIR?.trim() || join(dirname(entry), "public");
		if (!existsSync(join(publicDir, "index.html"))) {
			throw new Error(
				`The web client is not built: ${join(publicDir, "index.html")} is missing.\nRun: pnpm --filter @step-harness/web build`,
			);
		}
		const { environment, skipped } = await shellEnvironment;
		if (skipped !== undefined) console.info(`[desktop] login shell environment not applied (${skipped})`);
		else
			console.info(
				`[desktop] login shell environment applied (${(environment.PATH ?? "").split(delimiter).length} PATH entries)`,
			);
		const node = resolveNodeExecutable(process.env);
		let serverEnvironment = environment;
		try {
			serverEnvironment = await addBundledNodeToPath({
				environment,
				node,
				directory: join(app.getPath("userData"), "node-bin"),
			});
		} catch (error) {
			// The host can still run; StepPage will report its own prerequisite failure
			// if neither a system Node nor the private fallback is available.
			console.warn(`[desktop] bundled Node fallback unavailable (${message(error)})`);
		}
		const workspace = process.env.STEPCODE_WEB_CWD?.trim() || state.lastWorkspace() || homedir();
		const options = {
			entry,
			node,
			workspace,
			environment: serverEnvironment,
			logPath,
			port: positiveInteger(process.env.STEPCODE_DESKTOP_PORT),
			readyTimeoutMs: positiveInteger(process.env.STEPCODE_DESKTOP_START_TIMEOUT_MS),
			echo: !app.isPackaged,
		};
		let running: RunningWebServer;
		try {
			running = await launchWebServer(options);
		} catch (error) {
			// The free port can be taken between probing and binding; one retry picks another.
			if (options.port !== undefined || !message(error).includes("EADDRINUSE")) throw error;
			running = await launchWebServer(options);
		}
		if (quitting) {
			await running.stop();
			return;
		}
		server = running;
		launchUrlUsed = false;
		console.info(
			`[desktop] web server ready at ${running.origin} (pid ${String(running.pid)}, workspace ${workspace})`,
		);
		void running.exited.then((exit) => {
			if (exit.requested || server !== running) return;
			server = undefined;
			if (quitting) return;
			const status = exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`;
			showError("The StepCode server stopped unexpectedly", `${status}\n${exit.stderr}`.trim());
		});
	};

	/** Start (or restart) the server and point the window at it. */
	const restartServer = (): Promise<void> => {
		restarting ??= (async () => {
			const previous = server;
			server = undefined;
			await previous?.stop();
			if (window !== undefined && !window.isDestroyed())
				await window.loadURL(loadingPageUrl()).catch(() => undefined);
			try {
				await startServer();
			} catch (error) {
				showError("StepCode could not start its server", message(error));
				return;
			}
			if (window !== undefined) loadApp(window);
		})().finally(() => {
			restarting = undefined;
		});
		return restarting;
	};

	const openWindow = (): BrowserWindow => {
		const created = createMainWindow({
			preload,
			icon,
			version: app.getVersion(),
			state,
			getServerOrigin: () => server?.origin,
		});
		window = created;
		created.once("ready-to-show", () => {
			if (!smoke) created.show();
		});
		created.on("closed", () => {
			if (window === created) window = undefined;
		});
		if (server !== undefined) loadApp(created);
		else void created.loadURL(loadingPageUrl()).catch(() => undefined);
		return created;
	};

	const focusWindow = (): void => {
		if (window === undefined || window.isDestroyed()) {
			openWindow();
			return;
		}
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	};

	app.on("second-instance", () => {
		if (app.isReady()) focusWindow();
	});
	app.on("activate", () => {
		if (window === undefined || window.isDestroyed()) openWindow();
	});
	app.on("window-all-closed", () => {
		// macOS keeps the app (and its server) alive in the Dock without windows.
		if (process.platform !== "darwin") app.quit();
	});
	app.on("before-quit", (event) => {
		quitting = true;
		if (shutdownComplete || server === undefined) return;
		event.preventDefault();
		const running = server;
		server = undefined;
		void running.stop().finally(() => {
			shutdownComplete = true;
			app.quit();
		});
	});

	await app.whenReady();
	// A packaged app shows the bundle's icon.icns; `electron .` would show Electron's own icon.
	if (!app.isPackaged && existsSync(icon)) app.dock?.setIcon(icon);
	installDesktopIpc({
		getWindow: () => window,
		getServerOrigin: () => server?.origin,
		onDirectoryPicked: (path) => state.update({ lastWorkspace: path }),
	});
	installApplicationMenu({
		restartServer: () => void restartServer(),
		showLogs: () => void shell.openPath(app.getPath("logs")),
	});
	const first = openWindow();
	await restartServer();
	if (smoke) await runSmoke(first, () => server, logPath);
}

/**
 * Wait for the window to show the server origin, then print one JSON line
 * describing what the page sees and exit (0 when the bridge is present and
 * the cookie exchange worked).
 */
async function runSmoke(
	target: BrowserWindow,
	currentServer: () => RunningWebServer | undefined,
	logPath: string,
): Promise<void> {
	const deadline = Date.now() + (positiveInteger(process.env.STEPCODE_DESKTOP_SMOKE_TIMEOUT_MS) ?? 60_000);
	const report: Record<string, unknown> = { logPath };
	let code = 1;
	try {
		for (;;) {
			const running = currentServer();
			if (running === undefined) throw new Error("server is not running");
			const contents = target.webContents;
			if (!contents.isLoading() && contents.getURL().startsWith(`${running.origin}/`)) break;
			if (Date.now() > deadline) throw new Error(`timed out; window URL is ${contents.getURL().slice(0, 80)}`);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		}
		const running = currentServer() as RunningWebServer;
		report.origin = running.origin;
		report.healthz = await fetch(`${running.origin}/healthz`).then((response) => response.json());
		// Give the client a moment to exchange its launch token.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
		report.page = await target.webContents.executeJavaScript(`(async () => {
			const bridge = window.stepcodeDesktop;
			const bootstrap = await fetch("/api/v1/bootstrap").then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : null }));
			return {
				href: location.href.replace(/#token=[^&]*/, "#token=<redacted>"),
				title: document.title,
				bridge: typeof bridge,
				bridgeKeys: bridge ? Object.keys(bridge) : [],
				platform: bridge ? bridge.platform : null,
				version: bridge ? bridge.version : null,
				dataHost: document.documentElement.dataset.host ?? null,
				dataPlatform: document.documentElement.dataset.platform ?? null,
				bootstrapStatus: bootstrap.status,
				bootstrapCwd: bootstrap.body ? bootstrap.body.cwd : null,
			};
		})()`);
		const page = report.page as { bridge?: string; bootstrapStatus?: number };
		code = page.bridge === "object" && page.bootstrapStatus === 200 ? 0 : 1;
	} catch (error) {
		report.error = message(error);
	}
	console.log(`STEPCODE_DESKTOP_SMOKE ${JSON.stringify(report)}`);
	await currentServer()?.stop();
	app.exit(code);
}

if (app.requestSingleInstanceLock()) {
	// Ctrl+C in `pnpm dev` or a service manager's SIGTERM: quit through before-quit so the server is stopped.
	process.once("SIGINT", () => app.quit());
	process.once("SIGTERM", () => app.quit());
	main().catch((error: unknown) => {
		console.error("[desktop] fatal startup error", error);
		app.exit(1);
	});
} else {
	app.quit();
}
