import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { Composer, ImagePreview, SelectionDialog, TextInputDialog } from "./features/composer";
import { ConversationStream, FeedbackModal, SessionHeader, StreamNav } from "./features/conversation";
import { FileTreePanel } from "./features/files";
import { BranchControl } from "./features/gitbranch";
import { RightPanel, RightToolRail } from "./features/inspector";
import { LoginGate } from "./features/login";
import { CronView, MarketView } from "./features/market";
import { SettingsView } from "./features/settings";
import { AuthBanner, ErrorToast, LogoutDialog, ShellEffects, SidebarShowButton, UserArea } from "./features/shell";
import { RenameSessionDialog, SearchModal, SidebarNav, SidebarResizer } from "./features/sidebar";
import { TerminalDock } from "./features/terminal";
import { RemoveWorkspaceModal, WorkspaceBrowserModal, WorkspaceControl } from "./features/workspace";
import { I18nProvider } from "./i18n";
import { cx } from "./lib/format";
import { activeRightPanel } from "./state/right-panel";
import { shallowEqual, useAppStore } from "./state/store";
import { IconSprite } from "./ui";

/**
 * The legacy page skeleton (public/index.html), one slot per feature at its
 * original DOM position:
 *
 *   svg.icon-sprite
 *   div.app[.sidebar-hidden][.right-panel-open][.resizing]  (--sidebar-width, --preview-width)
 *     aside.sidebar      sidebar nav | files tree | shell user area (account, remote control, settings gear)
 *     #sidebarResizer    sidebar
 *     main.main          shell show button | files show button | market cron/market views
 *                        | conversation #sessionHeader (title, project, status, more menu)
 *                        | conversation stream
 *                        | conversation stream-nav (locator rail over the stream's right edge)
 *                        | .composer-zone > composer form (workspace pill above the card)
 *                        | #terminalDock (terminal: resizable bottom dock with workspace tabs)
 *                        | shell toast + auth banner
 *     aside#rightPanel   floating Summary, or context/files/changes/child inspector / browser
 *     nav.right-tool-rail
 *   #settingsView      settings: full-window settings page (menu + page) over the workspace
 *   #feedbackModal, #searchModal, #workspaceBrowserModal, #removeWorkspaceModal, #renameSessionDialog (sidebar),
 *   #selectionDialog,
 *   #imagePreview (composer: enlarged image attachment), #logoutDialog (shell)
 *   #loginGate         login: sign-in (or bring your own key), above everything while no model can run
 *   #workspaceMenu, #sessionMenu, #tagPicker: rendered by their sidebar trigger, in a portal on body, only while open
 */
export function App() {
	const appRef = useRef<HTMLDivElement>(null);
	const [summarySpace, setSummarySpace] = useState(false);
	const layout = useAppStore(
		(state) => ({
			sidebarHidden: state.ui.sidebarHidden,
			sidebarWidth: state.ui.sidebarWidth,
			previewWidth: state.ui.previewWidth,
			resizing: state.ui.resizing,
			rightOpen: Boolean(activeRightPanel(state)),
			summaryOpen: activeRightPanel(state) === "summary",
			rightExpanded: state.ui.rightPanelExpanded,
		}),
		shallowEqual,
	);
	// The summary card floats; where the main pane is wide enough, the column slides aside instead of under it.
	useLayoutEffect(() => {
		const app = appRef.current;
		if (!app) return;
		const sidebar = app.querySelector<HTMLElement>(".sidebar");
		const measure = () => {
			const sidebarWidth = layout.sidebarHidden ? 0 : (sidebar?.getBoundingClientRect().width ?? 0);
			const railWidth = Number.parseFloat(getComputedStyle(app).getPropertyValue("--rail-width")) || 44;
			setSummarySpace(app.clientWidth - sidebarWidth - railWidth >= 1120);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(app);
		if (sidebar) observer.observe(sidebar);
		return () => observer.disconnect();
	}, [layout.sidebarHidden]);
	const style: Record<string, string> = {};
	if (layout.sidebarWidth !== null) style["--sidebar-width"] = `${layout.sidebarWidth}px`;
	if (layout.previewWidth !== null) style["--preview-width"] = `${layout.previewWidth}px`;
	return (
		<I18nProvider>
			<IconSprite />
			<div
				ref={appRef}
				className={cx(
					"app",
					layout.sidebarHidden && "sidebar-hidden",
					"has-right-rail",
					layout.rightOpen && "right-panel-open",
					layout.summaryOpen && "summary-open",
					layout.summaryOpen && summarySpace && "summary-docked",
					layout.rightExpanded && "right-panel-expanded",
					layout.resizing && "resizing",
				)}
				style={style as CSSProperties}
			>
				<aside className="sidebar">
					<SidebarNav />
					<FileTreePanel />
					<UserArea />
				</aside>
				<SidebarResizer />
				<main className="main">
					<SidebarShowButton />
					<CronView />
					<MarketView />
					<SessionHeader />
					<ConversationStream />
					<StreamNav />
					<div className="composer-zone">
						<Composer workspaceControl={<WorkspaceControl />} branchControl={<BranchControl />} />
					</div>
					<TerminalDock />
					<ErrorToast />
					<AuthBanner />
				</main>
				<RightPanel />
				<RightToolRail />
			</div>
			<SettingsView />
			<FeedbackModal />
			<SearchModal />
			<WorkspaceBrowserModal />
			<RemoveWorkspaceModal />
			<RenameSessionDialog />
			<SelectionDialog />
			<TextInputDialog />
			<ImagePreview />
			<LogoutDialog />
			<LoginGate />
			<ShellEffects />
		</I18nProvider>
	);
}
