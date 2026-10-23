import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { writeClipboard } from "../../lib/clipboard";
import { cx } from "../../lib/format";
import { readStoredInt, STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { setUi, useAppStore } from "../../state/store";
import type { TerminalInfo, TerminalSnapshot, TerminalSupport } from "../../state/types";
import { Button, IconButton, ResizeHandle, Tooltip } from "../../ui";
import {
	closeTerminal,
	createTerminal,
	listTerminals,
	TerminalConnection,
	terminalWorkspaceKey,
	toggleTerminalDock,
} from "./actions";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type View = { terminal: Terminal; fit: FitAddon; element: HTMLDivElement; seq: number; truncated: boolean };

const HEIGHT_MIN = 140;
// Room for a dozen lines while the conversation keeps most of a laptop-height window.
const HEIGHT_DEFAULT = 240;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.25;

/** The conversation keeps at least 30% of the main column. */
function heightMax(dock: HTMLElement | null): number {
	const main = dock?.parentElement?.clientHeight || window.innerHeight;
	return Math.max(HEIGHT_MIN, Math.round(main * 0.7));
}
function clampHeight(height: number, dock: HTMLElement | null): number {
	return Math.min(heightMax(dock), Math.max(HEIGHT_MIN, Math.round(height)));
}

/**
 * xterm measures its cell size when it opens and again only when `fontFamily`
 * changes; it does not notice a web font finishing its download. Until Geist Mono
 * is available the terminal uses the system monospace stack, and the font-load
 * listener below switches it over, which makes xterm re-measure.
 */
function terminalFontFamily(): string {
	const style = getComputedStyle(document.documentElement);
	const loaded = document.fonts.check('13px "Geist Mono Variable"');
	return style.getPropertyValue(loaded ? "--mono" : "--mono-fallback").trim();
}

function terminalTheme(): ITheme {
	const style = getComputedStyle(document.documentElement);
	const color = (name: string) => style.getPropertyValue(name).trim();
	return {
		background: color("--term-bg"),
		foreground: color("--ink"),
		cursor: color("--caret"),
		selectionBackground: color("--focus-border"),
		black: color("--ink-2"),
		brightBlack: color("--ink-3"),
		red: color("--danger"),
		brightRed: color("--danger"),
		green: color("--term-green"),
		brightGreen: color("--term-green"),
		blue: color("--term-blue"),
		brightBlue: color("--term-blue"),
		yellow: color("--term-yellow"),
		brightYellow: color("--term-yellow"),
		cyan: color("--term-cyan"),
		brightCyan: color("--term-cyan"),
		magenta: color("--term-magenta"),
		brightMagenta: color("--term-magenta"),
		white: color("--ink"),
		brightWhite: color("--ink"),
	};
}

/** A first PTY size close to the visible area, so the shell's first prompt is not drawn for 80×24. */
function estimatedSize(element: HTMLElement | null): { cols: number; rows: number } | undefined {
	if (!element || element.clientWidth < 30 || element.clientHeight < 30) return undefined;
	return {
		cols: Math.min(500, Math.max(2, Math.floor(element.clientWidth / (FONT_SIZE * 0.6)))),
		rows: Math.min(300, Math.max(1, Math.floor(element.clientHeight / (FONT_SIZE * LINE_HEIGHT)))),
	};
}

/**
 * Bottom dock under the conversation. Tabs belong to the workspace folder the user asked for (the Host may
 * report a canonical realpath spelling in `info.cwd`), so lists are kept per requested scope.
 */
export function TerminalDock() {
	const t = useT();
	const open = useAppStore((state) => state.ui.terminalOpen);
	const cwd = useAppStore((state) => state.current?.cwd || state.draftCwd || state.bootstrapCwd);
	const scope = cwd ? terminalWorkspaceKey(cwd) : "";
	const dock = useRef<HTMLElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const views = useRef(new Map<string, View>());
	const connection = useRef<{ id: string; value: TerminalConnection } | undefined>(undefined);
	const current = useRef({ open, cwd });
	current.current = { open, cwd };
	/** Bumped by every create/close so a list request started earlier cannot drop or resurrect tabs. */
	const mutations = useRef(0);
	/** Opening the dock with no tab starts one shell; a page reload never does (the dock starts closed). */
	const autoStart = useRef(false);
	const [height, setHeight] = useState(() => readStoredInt(STORAGE_KEYS.terminalHeight) ?? HEIGHT_DEFAULT);
	const [lists, setLists] = useState<Record<string, readonly TerminalInfo[]>>({});
	const [support, setSupport] = useState<TerminalSupport>();
	const [selectedByCwd, setSelectedByCwd] = useState<Record<string, string>>({});
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState("");
	const [truncated, setTruncated] = useState(false);
	const [revision, setRevision] = useState(0);
	const tabs = lists[scope] ?? [];
	const selected = tabs.find((info) => info.id === selectedByCwd[scope]) || tabs[0];
	const selectedId = selected?.id;
	const selectedInfo = useRef(selected);
	selectedInfo.current = selected;
	const shell = selected?.shell || tabs[0]?.shell;
	const unavailable = support && !support.available ? support.reason : "";

	const updateInfo = (info: TerminalInfo) =>
		setLists((old) => {
			const next: Record<string, readonly TerminalInfo[]> = {};
			for (const [key, list] of Object.entries(old))
				next[key] = list.map((entry) => (entry.id === info.id ? info : entry));
			return next;
		});
	const removeInfo = (id: string) =>
		setLists((old) => {
			const next: Record<string, readonly TerminalInfo[]> = {};
			for (const [key, list] of Object.entries(old)) next[key] = list.filter((entry) => entry.id !== id);
			return next;
		});
	const disposeView = (id: string) => {
		const view = views.current.get(id);
		view?.terminal.dispose();
		view?.element.remove();
		views.current.delete(id);
	};

	const copy = async () => {
		const text = selectedId && views.current.get(selectedId)?.terminal.getSelection();
		if (!text) return;
		try {
			await writeClipboard(text);
		} catch {
			setError(t("terminalClipboardFailed"));
		}
	};
	const paste = async () => {
		if (!selectedId || !connected || selected?.status !== "running") return;
		try {
			const text = await navigator.clipboard.readText();
			if (selectedInfo.current?.id !== selectedId || !current.current.open) return;
			if (new TextEncoder().encode(text).byteLength > 65536) {
				setError(t("terminalPasteLimit"));
				return;
			}
			views.current.get(selectedId)?.terminal.paste(text);
			views.current.get(selectedId)?.terminal.focus();
		} catch {
			setError(t("terminalClipboardFailed"));
		}
	};
	const create = async () => {
		if (pendingRef.current || !cwd) return;
		const directory = cwd;
		const key = scope;
		mutations.current++;
		pendingRef.current = true;
		setPending(true);
		setError("");
		try {
			const size = estimatedSize(host.current);
			const snapshot = await createTerminal(directory, size);
			setLists((old) => ({
				...old,
				[key]: [...(old[key] ?? []).filter((info) => info.id !== snapshot.info.id), snapshot.info],
			}));
			setSelectedByCwd((old) => ({ ...old, [key]: snapshot.info.id }));
		} catch (failure) {
			if (current.current.cwd === directory) setError(errorMessage(failure));
			// A startup failure leaves a failed tab carrying the specific reason; list it.
			setRevision((value) => value + 1);
		} finally {
			mutations.current++;
			pendingRef.current = false;
			setPending(false);
		}
	};
	const close = async (id: string) => {
		const last = tabs.length === 1;
		mutations.current++;
		pendingRef.current = true;
		setPending(true);
		try {
			await closeTerminal(id);
			removeInfo(id);
			disposeView(id);
			setError("");
			// Like an editor's panel: ending the last terminal also hides the dock.
			if (last) toggleTerminalDock(false);
		} catch (failure) {
			setError(errorMessage(failure));
			setRevision((value) => value + 1);
		} finally {
			mutations.current++;
			pendingRef.current = false;
			setPending(false);
		}
	};
	const actions = useRef({ copy, paste, create });
	actions.current = { copy, paste, create };

	useEffect(() => {
		autoStart.current = open;
	}, [open]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new workspace starts without the previous workspace's error.
	useEffect(() => setError(""), [scope]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a list refresh after a mutation or reconnect.
	useEffect(() => {
		if (!open || !cwd) return;
		const controller = new AbortController();
		const generation = mutations.current;
		void listTerminals(cwd, controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				if (generation !== mutations.current) {
					// A create/close finished meanwhile; this list may predate it.
					setRevision((value) => value + 1);
					return;
				}
				setSupport(result.support);
				setLists((old) => ({ ...old, [scope]: result.terminals }));
				const live = new Set(result.terminals.map((info) => info.id));
				for (const [id, view] of views.current)
					if (view.element.dataset.scope === scope && !live.has(id)) disposeView(id);
				if (autoStart.current) {
					autoStart.current = false;
					if (!result.terminals.length && result.support.available) void actions.current.create();
				}
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) setError(errorMessage(failure));
			});
		return () => controller.abort();
	}, [open, cwd, scope, revision]);

	// Keep xterm instances while hidden; disconnect streams, never terminate shells.
	// biome-ignore lint/correctness/useExhaustiveDependencies: metadata updates must not reconnect the selected stream.
	useLayoutEffect(() => {
		for (const view of views.current.values()) view.element.hidden = true;
		setConnected(false);
		setTruncated(false);
		if (!open || !selected || !host.current) return;
		const id = selected.id;
		let view = views.current.get(id);
		if (!view) {
			const terminal = new Terminal({
				fontFamily: terminalFontFamily(),
				fontSize: FONT_SIZE,
				lineHeight: LINE_HEIGHT,
				scrollback: 5000,
				screenReaderMode: true,
				cols: selected.cols,
				rows: selected.rows,
				theme: terminalTheme(),
				disableStdin: true,
				linkHandler: {
					activate: () => {
						/* Terminal output cannot open untrusted links automatically. */
					},
				},
			});
			const fit = new FitAddon();
			terminal.loadAddon(fit);
			const element = document.createElement("div");
			element.className = "terminal-view";
			element.dataset.terminalId = id;
			element.dataset.scope = scope;
			host.current.append(element);
			terminal.open(element);
			terminal.parser.registerOscHandler(52, () => true);
			terminal.onData((data) => {
				if (
					!terminal.options.disableStdin &&
					connection.current?.id === id &&
					selectedInfo.current?.status === "running"
				)
					connection.current.value.send("input", { data });
			});
			terminal.attachCustomKeyEventHandler((event) => {
				if (event.type !== "keydown") return true;
				// The dock toggle belongs to the shell's shortcut table, not to the PTY.
				if (event.ctrlKey && event.code === "Backquote") return false;
				const key = event.key.toLowerCase();
				if (
					(event.ctrlKey || event.metaKey) &&
					!event.altKey &&
					key === "c" &&
					(event.shiftKey || terminal.hasSelection())
				) {
					event.preventDefault();
					void actions.current.copy();
					return false;
				}
				if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "v") {
					event.preventDefault();
					void actions.current.paste();
					return false;
				}
				return true;
			});
			view = { terminal, fit, element, seq: 0, truncated: false };
			views.current.set(id, view);
		}
		const active = view;
		active.element.hidden = false;
		active.terminal.textarea?.setAttribute("aria-label", t("terminalInput", { title: selected.title }));
		let live = true;
		let hydrated = false;
		let finishWrite: (() => void) | undefined;
		const fit = () => {
			if (!live || !hydrated || !host.current || host.current.clientWidth < 30 || host.current.clientHeight < 30)
				return;
			const dimensions = active.fit.proposeDimensions();
			if (!dimensions) return;
			const cols = Math.min(500, Math.max(2, dimensions.cols));
			const rows = Math.min(300, Math.max(1, dimensions.rows));
			if (cols === active.terminal.cols && rows === active.terminal.rows) return;
			active.terminal.resize(cols, rows);
			if (selectedInfo.current?.status === "running") client.send("resize", { cols, rows });
		};
		const client = new TerminalConnection(
			id,
			active.seq,
			async (snapshot: TerminalSnapshot) => {
				if (!live) return;
				updateInfo(snapshot.info);
				selectedInfo.current = snapshot.info;
				if (snapshot.truncated) {
					active.terminal.reset();
					active.seq = 0;
					active.truncated = true;
				}
				if (!hydrated) active.terminal.resize(snapshot.info.cols, snapshot.info.rows);
				const chunks = snapshot.chunks.filter((chunk) => chunk.seq > active.seq);
				// xterm owns the queued text even if the panel hides before parsing finishes.
				active.seq = snapshot.seq;
				if (chunks.length)
					await new Promise<void>((resolve) => {
						finishWrite = resolve;
						active.terminal.write(chunks.map((chunk) => chunk.data).join(""), () => {
							finishWrite = undefined;
							resolve();
						});
					});
				if (!live) return;
				hydrated = true;
				setTruncated(active.truncated);
				fit();
			},
			(ready, failure) => {
				if (!live) return;
				setConnected(ready);
				active.terminal.options.disableStdin = !ready || selectedInfo.current?.status !== "running";
				if (failure) setError(errorMessage(failure));
				else if (ready) setError("");
			},
			() => {
				if (!live) return;
				removeInfo(id);
				setRevision((value) => value + 1);
			},
		);
		connection.current = { id, value: client };
		const observer = new ResizeObserver(fit);
		observer.observe(host.current);
		const adoptLoadedFont = () => {
			const family = terminalFontFamily();
			if (!live || active.terminal.options.fontFamily === family) return;
			active.terminal.options.fontFamily = family;
			fit();
		};
		document.fonts.addEventListener("loadingdone", adoptLoadedFont);
		adoptLoadedFont();
		// Request the face explicitly: a terminal opened before any code block has rendered would otherwise never load it.
		// A failed load is harmless; the terminal simply keeps the system monospace stack.
		document.fonts.load('13px "Geist Mono Variable"').then(adoptLoadedFont, () => undefined);
		void client.connect();
		active.terminal.focus();
		return () => {
			live = false;
			finishWrite?.();
			observer.disconnect();
			document.fonts.removeEventListener("loadingdone", adoptLoadedFont);
			client.close();
			active.terminal.options.disableStdin = true;
			if (connection.current?.value === client) connection.current = undefined;
		};
	}, [open, cwd, scope, selectedId, revision, t]);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			for (const view of views.current.values()) view.terminal.options.theme = terminalTheme();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "style", "class"],
		});
		return () => {
			observer.disconnect();
			connection.current?.value.close();
			for (const view of views.current.values()) {
				view.terminal.dispose();
				view.element.remove();
			}
			views.current.clear();
		};
	}, []);
	useEffect(() => {
		if (open && selectedId)
			views.current.get(selectedId)?.terminal.refresh(0, (views.current.get(selectedId)?.terminal.rows || 1) - 1);
	}, [open, selectedId]);
	// Keep the stored height inside the window after it shrinks.
	useEffect(() => {
		if (!open) return;
		const settle = () => setHeight((value) => clampHeight(value, dock.current));
		settle();
		window.addEventListener("resize", settle);
		return () => window.removeEventListener("resize", settle);
	}, [open]);

	const status =
		selected && !(selected.status === "running" && connected)
			? selected.status === "running"
				? t("terminalConnecting")
				: t(`terminalStatus.${selected.status}`, { code: selected.exitCode ?? "?" })
			: "";
	const shownError = error || selected?.error || "";
	return (
		<section
			id="terminalDock"
			ref={dock}
			className="terminal-dock embedded-terminal"
			hidden={!open}
			aria-label={t("terminalTitle")}
			style={{ "--terminal-dock-height": `${height}px` } as CSSProperties}
		>
			<ResizeHandle
				bare
				className="terminal-dock-resizer"
				orientation="horizontal"
				direction={-1}
				aria-label={t("terminalResize")}
				min={HEIGHT_MIN}
				getSize={() => dock.current?.getBoundingClientRect().height ?? height}
				onResize={(value) => setHeight(clampHeight(value, dock.current))}
				onCommit={(value) => {
					const resolved = clampHeight(value, dock.current);
					setHeight(resolved);
					writeStorage(STORAGE_KEYS.terminalHeight, String(resolved));
				}}
				onReset={() => {
					setHeight(clampHeight(HEIGHT_DEFAULT, dock.current));
					writeStorage(STORAGE_KEYS.terminalHeight, String(HEIGHT_DEFAULT));
				}}
				onDraggingChange={(resizing) => setUi({ resizing })}
			/>
			<header className="terminal-header">
				<h2 className="terminal-heading">{t("terminalTitle")}</h2>
				{shell ? <span className="terminal-shell">{shell}</span> : null}
				<div className="terminal-tabs" role="tablist" aria-label={t("terminalTabs")}>
					{tabs.map((info) => (
						<div
							key={info.id}
							className={cx("terminal-tab", selectedId === info.id && "is-active")}
							data-status={info.status}
						>
							<Tooltip content={info.cwd}>
								<button
									type="button"
									role="tab"
									id={`terminal-tab-${info.id}`}
									aria-selected={selectedId === info.id}
									aria-controls="terminal-output"
									onClick={() => setSelectedByCwd((old) => ({ ...old, [scope]: info.id }))}
								>
									{info.title}
								</button>
							</Tooltip>
							<Tooltip content={t("terminalEnd")}>
								<IconButton
									icon="close"
									iconSize="xs"
									className="terminal-tab-close"
									disabled={pending}
									aria-label={t("terminalEndNamed", { title: info.title })}
									onClick={() => void close(info.id)}
								/>
							</Tooltip>
						</div>
					))}
				</div>
				<div className="terminal-actions">
					<Tooltip content={t("terminalNew")}>
						<IconButton
							icon="plus"
							data-terminal-new=""
							disabled={!cwd || pending || tabs.length >= 8 || Boolean(unavailable)}
							aria-label={t("terminalNew")}
							onClick={() => void create()}
						/>
					</Tooltip>
					<Tooltip content={t("terminalHide")}>
						<IconButton icon="close" aria-label={t("terminalHide")} onClick={() => toggleTerminalDock(false)} />
					</Tooltip>
				</div>
			</header>
			{unavailable ? (
				<div className="terminal-error" role="alert">
					<span>{t("terminalUnavailable", { reason: unavailable })}</span>
					<Tooltip content={t("terminalReconnect")}>
						<IconButton
							icon="refresh"
							aria-label={t("terminalReconnect")}
							onClick={() => setRevision((value) => value + 1)}
						/>
					</Tooltip>
				</div>
			) : shownError ? (
				<div className="terminal-error" role="alert">
					<span>{t("terminalError", { reason: shownError })}</span>
					<Tooltip content={t("terminalReconnect")}>
						<IconButton
							icon="refresh"
							aria-label={t("terminalReconnect")}
							onClick={() => setRevision((value) => value + 1)}
						/>
					</Tooltip>
				</div>
			) : null}
			{truncated ? <output className="terminal-notice">{t("terminalTruncated")}</output> : null}
			{status ? <output className="terminal-status">{status}</output> : null}
			<div
				id="terminal-output"
				className="terminal-output"
				role="tabpanel"
				aria-labelledby={selectedId ? `terminal-tab-${selectedId}` : undefined}
				ref={host}
			>
				{!selectedId ? (
					<div className="terminal-empty">
						<span>{t(cwd ? "terminalEmpty" : "terminalNoWorkspace")}</span>
						{cwd && !unavailable ? (
							<Button variant="secondary" disabled={pending} onClick={() => void create()}>
								{t("terminalNew")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		</section>
	);
}
