/**
 * Shell surfaces outside the settings menu: the sidebar show button, the error
 * toast, the connection-lost banner and the logged-out overlay. They stay
 * mounted and toggle the native `hidden` attribute.
 */

import { type CSSProperties, useLayoutEffect, useState } from "react";
import { useT } from "../../i18n";
import { dismissToast } from "../../state/session";
import { useAppStore } from "../../state/store";
import { IconButton, Toast } from "../../ui";
import { toggleSidebar } from "./actions";

/** Gap between the conversation header (or the column's top edge) and the toast. */
const TOAST_GAP = 12;

/**
 * Where the toast sits while the workspace is on screen: centred on the main
 * column, just under its session header, so it reads as the conversation's
 * message rather than the window's. Re-measured while shown, as the sidebar,
 * the right panel and the window resize the column. Null leaves the Toast's own
 * window-centred placement (used over the full-window settings page).
 */
function useConversationAnchor(active: boolean): CSSProperties | undefined {
	const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		const main = active ? document.querySelector<HTMLElement>(".main") : null;
		if (!main) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const column = main.getBoundingClientRect();
			const header = main.querySelector<HTMLElement>("#sessionHeader");
			const headerBox = header?.getBoundingClientRect();
			const top = headerBox && headerBox.height > 0 ? headerBox.bottom : column.top;
			setAnchor({ left: column.left + column.width / 2, top: top + TOAST_GAP });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(main);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [active]);
	return anchor ? { left: `${anchor.left}px`, top: `${anchor.top}px` } : undefined;
}

/**
 * `#sidebarShow`, visible only while the sidebar is collapsed (CSS
 * `.app.sidebar-hidden .sidebar-show`). Legacy index.html 786-796 hard-coded
 * its title and label in Chinese; click toggles the sidebar (app.js 3386-3388).
 */
export function SidebarShowButton() {
	return (
		<IconButton
			className="sidebar-show"
			id="sidebarShow"
			icon="sidebar"
			title="展开侧边栏 ⌘B"
			aria-label="展开侧边栏"
			onClick={toggleSidebar}
		/>
	);
}

/**
 * `#errorToast`, filled by `showError` (legacy app.js 3184-3193; index.html
 * 1011). The look and placement are `ui/Toast`'s; `.error-toast` stays as the
 * element's public class.
 */
export function ErrorToast() {
	const toast = useAppStore((state) => state.toast);
	const groupError = useAppStore((state) => state.tagGroupsLoadError ?? state.tagGroupsSaveError);
	const action = toast?.action;
	const message = toast?.message ?? groupError;
	const settingsOpen = useAppStore((state) => state.ui.settingsPage !== null);
	const anchor = useConversationAnchor(Boolean(message) && !settingsOpen);
	return (
		<Toast
			id="errorToast"
			className="error-toast"
			message={message}
			style={anchor}
			tone={toast?.tone ?? "danger"}
			actionLabel={action?.label}
			onAction={
				action && toast
					? () => {
							dismissToast(toast.seq);
							action.run();
						}
					: undefined
			}
		/>
	);
}

/**
 * `#authBanner`, shown when a request returns 401 or the launch-token exchange
 * fails (legacy index.html 1012-1025). Reload re-runs the page (app.js 3389).
 */
export function AuthBanner() {
	const t = useT();
	const open = useAppStore((state) => state.ui.authExpired);
	return (
		<div className="auth-banner" id="authBanner" role="alert" hidden={!open}>
			<strong>{t("authExpiredTitle")}</strong>
			<span>{t("authExpiredBody")}</span>
			<button className="auth-banner-reload" id="authBannerReload" type="button" onClick={() => location.reload()}>
				{t("reload")}
			</button>
		</div>
	);
}
