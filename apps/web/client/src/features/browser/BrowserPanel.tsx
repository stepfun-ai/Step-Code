import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { ApiError, errorMessage } from "../../lib/api";
import { writeClipboard } from "../../lib/clipboard";
import { isMacPlatform } from "../../lib/format";
import { useAppStore } from "../../state/store";
import type { EmbeddedBrowserFrame, EmbeddedBrowserSnapshot } from "../../state/types";
import { Button, Icon, IconButton, type IconName, Tooltip } from "../../ui";
import {
	BrowserConnection,
	BrowserDisconnect,
	type BrowserPointerMove,
	browserKeyRoute,
	browserRetryable,
} from "./actions";

const EMPTY: EmbeddedBrowserSnapshot = { revision: 0, activeId: null, tabs: [] };
/** Backoff for an unexpected stream drop; a manual Reconnect starts over. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];
/**
 * A connection must stay up this long before its retry budget is restored. A stream that opens and
 * drops at once is not healthy: resetting on every open would retry it every second forever.
 */
const HEALTHY_AFTER_MS = 10_000;

export function BrowserPanel({ open }: { open: boolean }) {
	const t = useT();
	const [snapshot, setSnapshot] = useState(EMPTY);
	const [error, setError] = useState("");
	/*
	 * The host refuses a second page with 409, and tells a displaced duplicate page it was replaced; say
	 * so in the UI language instead of echoing its English.
	 */
	const failureText = (failure: unknown) =>
		(failure instanceof ApiError && failure.status === 409) ||
		(failure instanceof BrowserDisconnect && failure.reason === "replaced")
			? t("browserBusy")
			: errorMessage(failure);
	const [ready, setReady] = useState(false);
	const [retry, setRetry] = useState(0);
	const [frame, setFrame] = useState<EmbeddedBrowserFrame>();
	const [address, setAddress] = useState("");
	const connection = useRef<BrowserConnection>(null);
	/**
	 * The connection that finished connecting. `ready` still reads true from the previous connection in the
	 * render that reopens the panel, while the new one has no control token yet and drops what it is sent.
	 */
	const connected = useRef<BrowserConnection>(null);
	const attempts = useRef(0);
	const surface = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const addressInput = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	const clicks = useRef({ at: 0, x: 0, y: 0, button: 0, count: 1 });
	const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeId);
	const activeId = active?.id;
	const openRequest = useAppStore((state) => state.ui.browserOpenRequest);
	const handledRequest = useRef(0);
	const tabs = useRef(snapshot.tabs);
	tabs.current = snapshot.tabs;
	useEffect(() => {
		setAddress(active?.url === "about:blank" ? "" : (active?.url ?? ""));
	}, [active?.url]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately recreates the transport.
	useEffect(() => {
		if (!open) return;
		let disposed = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let healthyTimer: ReturnType<typeof setTimeout> | undefined;
		let decoding = false;
		let latest: EmbeddedBrowserFrame | undefined;
		const display = async (value: EmbeddedBrowserFrame) => {
			latest = value;
			if (decoding) return;
			decoding = true;
			try {
				while (latest && !disposed) {
					const next = latest;
					latest = undefined;
					const image = new Image();
					image.src = `data:image/jpeg;base64,${next.data}`;
					await image.decode();
					if (!disposed) setFrame(next);
				}
			} catch (failure) {
				if (!disposed) setError(failureText(failure));
			} finally {
				decoding = false;
			}
		};
		// A lost stream (a stalled renderer, a Host restart) reconnects by itself with backoff. A competing
		// page, a displaced duplicate page and a stopping Host keep the manual Reconnect button instead,
		// so two pages never take control from each other in a loop.
		const reconnect = (failure: unknown) => {
			if (disposed || retryTimer || !browserRetryable(failure)) return;
			const attempt = attempts.current;
			if (attempt >= RECONNECT_DELAYS_MS.length) return;
			attempts.current = attempt + 1;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				setRetry((value) => value + 1);
			}, RECONNECT_DELAYS_MS[attempt]);
		};
		const client = new BrowserConnection(
			(value) => {
				if (!disposed) setSnapshot(value);
			},
			(value) => {
				void display(value);
			},
			(failure, disconnected) => {
				if (disposed) return;
				setError(failureText(failure));
				if (disconnected) {
					clearTimeout(healthyTimer);
					if (connected.current === client) connected.current = null;
					setReady(false);
					reconnect(failure);
				}
			},
		);
		connection.current = client;
		setReady(false);
		setError("");
		void client
			.connect()
			.then(() => {
				if (disposed) return;
				connected.current = client;
				setReady(true);
				healthyTimer = setTimeout(() => {
					attempts.current = 0;
				}, HEALTHY_AFTER_MS);
			})
			.catch((failure: unknown) => {
				if (disposed) return;
				setError(failureText(failure));
				client.close();
				reconnect(failure);
			});
		return () => {
			disposed = true;
			clearTimeout(retryTimer);
			clearTimeout(healthyTimer);
			client.close();
			connection.current = null;
			if (connected.current === client) connected.current = null;
		};
	}, [open, retry]);
	// Another feature asked for a page (a delivered file's preview): reuse a tab already on it, reloaded so a
	// rewritten file shows its new content, or open a new one. Each request is handled once, once connected.
	useEffect(() => {
		const client = connected.current;
		if (!open || !ready || !client || !openRequest || openRequest.seq <= handledRequest.current) return;
		handledRequest.current = openRequest.seq;
		setError("");
		const existing = tabs.current.find((tab) => tab.url === openRequest.url);
		if (existing) {
			client.send(`/tabs/${existing.id}/select`);
			client.send(`/tabs/${existing.id}/action`, { action: "reload" });
		} else client.send("/tabs", { url: openRequest.url });
	}, [open, ready, openRequest]);
	useEffect(() => {
		const element = surface.current;
		if (!open || !ready || !element) return;
		let timer: ReturnType<typeof setTimeout>;
		const observer = new ResizeObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				const rect = element.getBoundingClientRect();
				if (rect.width && rect.height)
					connection.current?.send("/viewport", {
						width: Math.min(1600, Math.max(160, Math.round(rect.width))),
						height: Math.min(1200, Math.max(120, Math.round(rect.height))),
					});
			}, 100);
		});
		observer.observe(element);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
		};
	}, [open, ready]);
	const action = (name: string, value?: unknown) => {
		if (activeId) connection.current?.send(`/tabs/${activeId}/action`, { action: name, value });
	};
	const sendInput = (event: unknown) => {
		if (!activeId || !ready) return;
		connection.current?.send(`/tabs/${activeId}/input`, event);
	};
	const moveInput = (event: BrowserPointerMove) => {
		if (!activeId || !ready) return;
		connection.current?.move(`/tabs/${activeId}/input`, event);
	};
	const copy = () => {
		if (!activeId) return;
		void connection.current
			?.selection(activeId)
			.then(writeClipboard)
			.catch((failure: unknown) => setError(failureText(failure)));
	};
	const point = (x: number, y: number) => {
		const rect = surface.current?.getBoundingClientRect();
		if (!rect || !frame) return { x: 0, y: 0 };
		return {
			x: Math.max(0, Math.min(frame.width - 1, ((x - rect.left) / rect.width) * frame.width)),
			y: Math.max(0, Math.min(frame.height - 1, ((y - rect.top) / rect.height) * frame.height)),
		};
	};
	const pointer = (event: PointerEvent<HTMLDivElement>, phase: "down" | "move" | "up") => {
		if (!frame || frame.tabId !== activeId || !ready) return;
		if (phase === "down") {
			const previous = clicks.current;
			clicks.current = {
				at: Date.now(),
				x: event.clientX,
				y: event.clientY,
				button: event.button,
				count:
					Date.now() - previous.at < 500 &&
					Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 4 &&
					event.button === previous.button
						? (previous.count % 3) + 1
						: 1,
			};
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			if (input.current) {
				const rect = event.currentTarget.getBoundingClientRect();
				input.current.style.left = `${Math.max(0, event.clientX - rect.left)}px`;
				input.current.style.top = `${Math.max(0, event.clientY - rect.top)}px`;
				input.current.focus({ preventScroll: true });
			}
		}
		const position = point(event.clientX, event.clientY);
		const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
		if (phase === "move") moveInput({ kind: "pointer", phase, ...position, button, clicks: clicks.current.count });
		else sendInput({ kind: "pointer", phase, ...position, button, clicks: clicks.current.count });
	};
	const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		event.stopPropagation();
		if (event.nativeEvent.isComposing || composing.current || event.key === "Process") return;
		const route = browserKeyRoute(
			{
				key: event.key,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				altGraph: event.getModifierState("AltGraph"),
			},
			isMacPlatform(),
		);
		if (route.kind === "native") return;
		event.preventDefault();
		if (route.kind === "copy") copy();
		else if (route.kind === "key") sendInput(route);
	};
	const control = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
		<Tooltip content={t(label)}>
			<IconButton icon={icon} aria-label={t(label)} onClick={onClick} disabled={!ready || disabled} />
		</Tooltip>
	);
	return (
		<section
			className="embedded-browser"
			hidden={!open}
			aria-label={t("browserTitle")}
			onKeyDownCapture={(event) => {
				if (!(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
				// AltGr (Ctrl+Alt on Windows) prints characters; it is never a panel shortcut.
				if (event.altKey || event.getModifierState("AltGraph")) return;
				const shortcut = event.key.toLowerCase();
				if (!["l", "t", "w", "r"].includes(shortcut)) return;
				event.preventDefault();
				event.stopPropagation();
				if (shortcut === "l") addressInput.current?.focus();
				if (shortcut === "t" && ready) connection.current?.send("/tabs", {});
				if (shortcut === "w" && activeId) connection.current?.send(`/tabs/${activeId}`, undefined, "DELETE");
				if (shortcut === "r") action("reload");
			}}
		>
			<div className="browser-tabs" role="tablist" aria-label={t("browserTabs")}>
				{snapshot.tabs.map((tab) => (
					<div
						className={`browser-tab${activeId === tab.id ? " is-active" : ""}${tab.loading ? " is-loading" : ""}`}
						key={tab.id}
					>
						<Button
							role="tab"
							aria-selected={activeId === tab.id}
							onClick={() => connection.current?.send(`/tabs/${tab.id}/select`)}
							disabled={!ready}
						>
							<Icon name={tab.loading ? "loaderCircle" : "globe"} size="xs" />
							<span>{tab.title || (tab.url === "about:blank" ? t("browserNewTab") : tab.url)}</span>
						</Button>
						<Tooltip content={t("closeTab")}>
							<IconButton
								icon="closeSm"
								aria-label={`${t("closeTab")} ${tab.title || t("browserNewTab")}`}
								disabled={!ready}
								onClick={() => connection.current?.send(`/tabs/${tab.id}`, undefined, "DELETE")}
							/>
						</Tooltip>
					</div>
				))}
				{control("plus", "browserNewTab", () => connection.current?.send("/tabs", {}), snapshot.tabs.length >= 12)}
			</div>
			<form
				className="browser-navigation"
				onSubmit={(event) => {
					event.preventDefault();
					setError("");
					if (activeId) action("navigate", address);
					else connection.current?.send("/tabs", { url: address });
				}}
			>
				<div className="browser-nav-buttons">
					{control("chevronLeft", "browserBack", () => action("back"), !active?.canGoBack)}
					{control("chevronRight", "browserForward", () => action("forward"), !active?.canGoForward)}
					{control(
						active?.loading ? "stop" : "refresh",
						active?.loading ? "stopRun" : "reload",
						() => action(active?.loading ? "stop" : "reload"),
						!active,
					)}
				</div>
				<input
					ref={addressInput}
					className="browser-address"
					aria-label={t("browserAddress")}
					placeholder={t("browserAddress")}
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					disabled={!ready}
					onFocus={(event) => event.currentTarget.select()}
					spellCheck={false}
					autoComplete="off"
				/>
				<Tooltip content={t("go")}>
					<IconButton
						type="submit"
						icon="chevronRight"
						aria-label={t("go")}
						disabled={!ready || !address.trim()}
					/>
				</Tooltip>
			</form>
			{error ? (
				<div className="browser-error" role="alert">
					<span>{error}</span>
					<Tooltip content={t("browserReconnect")}>
						<IconButton
							icon="refresh"
							aria-label={t("browserReconnect")}
							onClick={() => {
								attempts.current = 0;
								setRetry((value) => value + 1);
							}}
						/>
					</Tooltip>
				</div>
			) : null}
			{active?.error ? (
				<p className="browser-error" role="alert">
					{active.error}
				</p>
			) : null}
			{active?.notice ? <output className="browser-notice">{t(`browserNotice.${active.notice}`)}</output> : null}
			<div
				ref={surface}
				className="browser-surface"
				role="application"
				aria-label={t("browserPage")}
				onPointerDown={(event) => pointer(event, "down")}
				onPointerMove={(event) => pointer(event, "move")}
				onPointerUp={(event) => pointer(event, "up")}
				onPointerCancel={(event) => pointer(event, "up")}
				onContextMenu={(event) => event.preventDefault()}
				onWheel={(event) => {
					event.stopPropagation();
					if (!activeId || !ready) return;
					connection.current?.wheel(`/tabs/${activeId}/input`, {
						...point(event.clientX, event.clientY),
						deltaX: Math.max(-4000, Math.min(4000, event.deltaX)),
						deltaY: Math.max(-4000, Math.min(4000, event.deltaY)),
					});
				}}
			>
				{frame && frame.tabId === activeId && active?.url !== "about:blank" ? (
					<img
						className="browser-frame"
						// Scale the captured surface so only its page area fills the panel; the unused strip
						// of a window wider than the viewport falls outside and is clipped.
						style={{
							width: `${((frame.surfaceWidth ?? frame.width) / frame.width) * 100}%`,
							height: `${((frame.surfaceHeight ?? frame.height) / frame.height) * 100}%`,
						}}
						src={`data:image/jpeg;base64,${frame.data}`}
						alt={active?.title || t("browserPage")}
						draggable={false}
					/>
				) : (
					<div className="browser-empty">
						<Icon name="globe" size="lg" />
						<span>{t(ready ? "browserNewTab" : error ? "browserNotConnected" : "browserConnecting")}</span>
					</div>
				)}
				<textarea
					ref={input}
					className="browser-input"
					aria-label={t("browserPageInput")}
					tabIndex={activeId && ready ? 0 : -1}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					onKeyDown={key}
					onKeyUp={(event) => event.stopPropagation()}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={(event) => {
						composing.current = false;
						if (event.data) sendInput({ kind: "text", text: event.data });
						event.currentTarget.value = "";
					}}
					onInputCapture={(event) => {
						if (!composing.current) {
							const text = event.currentTarget.value;
							event.currentTarget.value = "";
							if (text) sendInput({ kind: "text", text });
						}
					}}
				/>
			</div>
			<footer className="browser-footer">
				<output>
					{t(ready ? (active?.loading ? "browserLoading" : "browserConnected") : "browserDisconnected")}
				</output>
				{control("copy", "browserCopySelection", copy, !active)}
				{control(
					"circleMinus",
					"browserZoomOut",
					() => action("zoom", Math.max(0.5, (active?.zoom ?? 1) - 0.1)),
					!active || active.zoom <= 0.5,
				)}
				<Button
					className="browser-zoom"
					disabled={!ready || !active}
					onClick={() => action("zoom", 1)}
					aria-label={t("browserZoomReset")}
				>
					{Math.round((active?.zoom ?? 1) * 100)}%
				</Button>
				{control(
					"plus",
					"browserZoomIn",
					() => action("zoom", Math.min(2, (active?.zoom ?? 1) + 0.1)),
					!active || active.zoom >= 2,
				)}
				{control(
					"openExternal",
					"browserExternal",
					() => {
						if (active?.url.startsWith("http")) window.open(active.url, "_blank", "noopener,noreferrer");
					},
					!active?.url.startsWith("http"),
				)}
			</footer>
		</section>
	);
}
