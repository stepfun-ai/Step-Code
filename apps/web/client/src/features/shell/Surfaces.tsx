/**
 * Shell surfaces outside the settings menu: the sidebar show button, the error
 * toast, the connection-lost banner and the logged-out overlay. They stay
 * mounted and toggle the native `hidden` attribute.
 */

import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { IconButton, Toast } from "../../ui";
import { toggleSidebar } from "./actions";

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
	return (
		<Toast
			id="errorToast"
			className="error-toast"
			message={toast?.message ?? groupError}
			tone={toast?.tone ?? "danger"}
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
