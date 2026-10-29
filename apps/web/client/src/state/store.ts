import { useRef, useSyncExternalStore } from "react";
import type { Locale, TagColor } from "../i18n/messages";
import type { AttachedFile } from "../lib/attached-files";
import { readStorage, STORAGE_KEYS } from "../lib/storage";
import { isDesktopHost } from "../platform/host";
import type { PerformanceRun } from "./performance";
import { readSessionPreferences } from "./session-order";
import type {
	AccountReport,
	Attachment,
	DirectoryListing,
	DraftModels,
	LoginReport,
	NoticeItem,
	PolicyPreset,
	SelectionRequest,
	SessionSnapshot,
	SessionStatus,
	SessionSummary,
	TagGroup,
	TimelineItem,
	TreeEntry,
	WebWorkspace,
	WorkspaceFile,
} from "./types";

/* ── Tiny external store ─────────────────────────────────────────────────── */

export type Listener = () => void;
export type StateUpdater<S> = Partial<S> | ((state: S) => Partial<S>);

export interface Store<S> {
	getState(): S;
	/**
	 * Shallow-merge a patch into the state. The patch (or the updater's result)
	 * must be built immutably: never mutate a Map/Set/array/object that is
	 * already in the state — replace it. Listeners run synchronously.
	 */
	setState(updater: StateUpdater<S>): void;
	subscribe(listener: Listener): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
	let state = initial;
	const listeners = new Set<Listener>();
	return {
		getState: () => state,
		setState(updater) {
			const patch = typeof updater === "function" ? updater(state) : updater;
			if (!patch || patch === state) return;
			let changed = false;
			for (const key of Object.keys(patch) as Array<keyof S>) {
				if (!Object.is(patch[key], state[key])) {
					changed = true;
					break;
				}
			}
			if (!changed) return;
			state = { ...state, ...patch };
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/* ── App state (legacy app.js `state`, lines 1-53) ───────────────────────── */

export type ThemeChoice = "system" | "light" | "dark" | "violet";
export type ConversationView = "project" | "group";
export type ModeId = "goal" | "plan" | "ultraloop";
export type DirectoryPickerMode = "native" | "browse";
export type RightPanelId = "summary" | "context" | "changes" | "files" | "subagent" | "browser";

/** Lazy file tree of one workspace (legacy `state.tree`). */
export interface TreeState {
	readonly cwd: string;
	readonly children: ReadonlyMap<string, readonly TreeEntry[]>;
	readonly expanded: ReadonlySet<string>;
	readonly loading: ReadonlySet<string>;
	readonly truncated: ReadonlySet<string>;
	readonly errors: ReadonlyMap<string, string>;
	/** Server-side name search results; null when not searching. */
	readonly results: readonly TreeEntry[] | null;
	readonly resultsTruncated: boolean;
}

/** A file open in the preview rail. */
export interface FilePreviewTab {
	readonly kind: "file";
	readonly cwd: string;
	readonly path: string;
	/** Present when the file lives outside the workspace; `path` is then absolute. */
	readonly scope?: "local";
	readonly file: WorkspaceFile | null;
	readonly error: string;
	readonly loading: boolean;
	/** Markdown shown rendered rather than as source. */
	readonly rendered: boolean;
}

/**
 * A `/btw` answer in the same tab strip as files: a side question has its own
 * thread, so it gets its own tab and the conversation stays untouched.
 * Process memory, like the terminal's side-answer history.
 */
export interface SideAnswerTab {
	readonly kind: "btw";
	readonly id: string;
	readonly question: string;
	readonly text: string;
	readonly model?: string;
	readonly unavailable?: boolean;
	readonly createdAt: number;
	/**
	 * Waiting for the model. The tab opens as soon as the question is sent, so
	 * the reader sees where the answer will appear instead of watching the
	 * conversation for it.
	 */
	readonly pending?: boolean;
}

export type PreviewTab = FilePreviewTab | SideAnswerTab;

/** The preview panel's turn-changes view (features/files/ChangesView). */
export interface ChangesViewState {
	/** User entry id of the turn shown. */
	readonly turnId: string;
	/** Shown paths whose diff is unfolded. */
	readonly expanded: ReadonlySet<string>;
	/** Path to scroll into view, and a counter so asking twice scrolls twice. */
	readonly focus: string | null;
	readonly focusSeq: number;
}

export interface PreviewState {
	/** `files` shows the tabs; `changes` the turn-changes view. */
	readonly mode: "files" | "changes";
	readonly changes: ChangesViewState | null;
	readonly tabs: readonly PreviewTab[];
	/** Index into `tabs`, -1 when there are none. */
	readonly active: number;
	readonly open: boolean;
	readonly wrap: boolean;
}

/** Pages of the settings view, in menu order. */
export type SettingsPage = "general" | "account" | "appearance" | "models" | "plugins" | "mcp" | "skills";

/**
 * What a settings editor edits. `mcp` with a name edits that server, without one
 * creates a server; `json` opens it on the JSON tab (the "import" entry).
 */
export type SettingsEditor =
	| { readonly kind: "mcp"; readonly name?: string; readonly json?: boolean }
	| { readonly kind: "model"; readonly id?: string }
	| { readonly kind: "skill" };

/**
 * Cross-feature UI flags. Legacy code toggled `hidden` / classes on fixed
 * elements from anywhere; here the owning feature renders from these flags and
 * any feature (or the shell's Escape chain) can flip them.
 */
export interface UiState {
	readonly rightPanel: RightPanelId | null;
	readonly rightPanelExpanded: boolean;
	readonly rightPanelMenu: boolean;
	/** `#terminalDock` below the conversation; independent of the right panel. Never restored on reload. */
	readonly terminalOpen: boolean;
	/** `.app.sidebar-hidden` */
	readonly sidebarHidden: boolean;
	/** Inline `--sidebar-width` on `.app` in px; null leaves the CSS default. */
	readonly sidebarWidth: number | null;
	/** Inline `--preview-width` on `.app` in px; null leaves the CSS default. */
	readonly previewWidth: number | null;
	/** `.app.resizing` while a resize handle is dragged. */
	readonly resizing: boolean;
	/** `#fileTree.open` */
	readonly fileTreeOpen: boolean;
	/** `#searchModal` visible */
	readonly searchOpen: boolean;
	/** `#workspacePopover` visible */
	readonly workspacePopoverOpen: boolean;
	/** `#accountMenu`: the sidebar footer's account popover */
	readonly accountMenuOpen: boolean;
	/** `#branchPopover` visible: the composer's branch switcher. */
	readonly branchPopoverOpen: boolean;
	/** `#branchCreateDialog` visible: creating a branch from the switcher. */
	readonly branchCreateOpen: boolean;
	/** `#workspaceBrowserModal` visible */
	readonly workspaceBrowserOpen: boolean;
	readonly workspaceRemoval: { readonly path: string; readonly pending: boolean } | null;
	/** `#settingsView`: the open settings page, or null while the workspace shows. */
	readonly settingsPage: SettingsPage | null;
	/** Full-width editor inside a settings page (new or edited MCP server, new skill). */
	readonly settingsEditor: SettingsEditor | null;
	/** Dialog above the settings view: add a marketplace, import a skill folder. */
	readonly settingsDialog: "marketplace" | "skillImport" | null;
	/** `#workspaceMenu`, open below the overflow button of the project in `cwd`. */
	readonly workspaceMenu: { readonly cwd: string } | null;
	/** `#sessionMenu`, open below the more button of a session row. */
	readonly sessionMenu: { readonly sessionId: string } | null;
	/** `#streamMenu`, open below the more button of the conversation header strip. */
	readonly streamMenu: boolean;
	/** `#tagPicker`, open below the tag button of a session row. `sessionId` is the legacy `state.tagTarget`. */
	readonly tagPicker: { readonly sessionId: string } | null;
	/** `#authBanner` visible (a request returned 401). */
	readonly authExpired: boolean;
	/**
	 * `#renameSessionDialog`: naming one session. `name` seeds the field; `pending` while the rename request runs.
	 * An in-page dialog, because the desktop host (Electron) does not implement `window.prompt`.
	 */
	readonly renameSession: { readonly sessionId: string; readonly name: string; readonly pending: boolean } | null;
	/** `#logoutDialog`: confirming Log out; `pending` while `POST /api/v1/logout` runs. */
	readonly logoutConfirm: { readonly pending: boolean } | null;
	/** `#loginGate` visible: no model can run yet (no Step credential, no custom model), and the app waits behind it. */
	readonly loginRequired: boolean;
	/** Incremented to ask the composer to focus `#prompt` (legacy `$("#prompt").focus()`). */
	readonly promptFocusRequest: number;
	/** The user message being rewritten in place: its entry, the fork point, and its text. */
	readonly editingPrompt: { readonly entryId: string; readonly before?: string; readonly text: string } | null;
	/** A message's text loaded back into the prompt for rewriting; `seq` re-fires for the same text. */
	readonly promptDraftRequest?: { readonly text: string; readonly seq: number };
	/** Mid-pane view covering the conversation: `#cronView` or `#marketView` (`.market-view.open`). */
	readonly midView: "cron" | "market" | null;
	/** Session whose snapshot is loading after a pick: its row highlights and the stream shows progress at once. */
	readonly openingSession: string | null;
	/**
	 * Workspace of a conversation the user just started with a "new conversation" control, listed as a
	 * placeholder sidebar row until its session exists (it is created on the first send). Null otherwise.
	 */
	readonly draftRow: string | null;
	/** Open menu of the changes view: `turn`, `more`, or `file:<shown path>`. */
	readonly changesMenu: string | null;
	/** The composer's slash menu: matching commands, or the MCP server list picked from it. */
	readonly slashMenu: "commands" | "mcp" | null;
	/** `#fileCompletionMenu`: workspace @path candidates; Escape closes it without interrupting a turn. */
	readonly fileCompletionOpen: boolean;
	/**
	 * A page another feature asked the embedded browser to show (a delivered HTML file's preview URL). `seq`
	 * re-fires the same URL; the browser panel handles each request once, after its connection is ready.
	 */
	readonly browserOpenRequest: { readonly url: string; readonly seq: number } | null;
	/**
	 * A search hit to scroll to once its session is shown; cleared when done.
	 * `behavior`/`block` let a caller ask for a smooth scroll or a top-aligned
	 * one (the stream locator); the instant centred jump stays as it was.
	 */
	readonly revealEntry: {
		readonly sessionId: string;
		readonly entryId: string;
		readonly behavior?: ScrollBehavior;
		readonly block?: ScrollLogicalPosition;
	} | null;
	/** `#childAgentView`: a child agent's read-only transcript covering the conversation of `parentId`. */
	readonly childView: ChildView | null;
	/** `#imagePreview`: a staged image attachment shown enlarged; `src` is its data URL. */
	readonly imagePreview: { readonly src: string; readonly name: string } | null;
}

export interface ChildView {
	readonly parentId: string;
	/** The child shown; null until a workflow run's agent list has loaded. */
	readonly childId: string | null;
	/** Set when opened from a workflow call: the view lists that run's agents. */
	readonly workflowRun?: string;
	readonly label: string;
	/** Stable selection into the parent's live task projection, including tasks without a child session yet. */
	readonly toolItemId?: string;
	readonly taskIndex?: number;
}

export interface ToastState {
	readonly message: string;
	readonly tone: "danger" | "neutral";
	/** Distinguishes two identical consecutive messages. */
	readonly seq: number;
}

export interface PendingTurn {
	readonly text: string;
	/** Files the message names; the host appends their content, so the echoed message has them too. */
	readonly files?: readonly AttachedFile[];
	/** Data URLs of the message's images, shown before the host echoes the message. */
	readonly images?: readonly string[];
	/** User messages in the timeline when it was sent; one more means the host has recorded it. */
	readonly userCount: number;
}

export interface AppState {
	readonly sessions: readonly SessionSummary[];
	readonly current: SessionSnapshot | null;
	/** Current selection's locally observed run; cleared on replacement or stream interruption. */
	readonly performanceRun: PerformanceRun | null;
	/**
	 * The open session's context fill, from the inspector read the composer's
	 * performance bar already polls; the right rail's context ring draws it.
	 * Keyed by session so a switch never shows the previous session's fill.
	 */
	readonly contextFill: { readonly sessionId: string; readonly percent: number } | null;
	readonly timelineItems: readonly TimelineItem[];
	/** `ui.notify` output for this page load, shown after the timeline and never persisted. */
	readonly notices: readonly NoticeItem[];
	/** The kernel is compacting the context right now (host event, mirrored by the snapshot). */
	readonly compacting: boolean;
	/**
	 * A message sent but not yet in the session entries. The composer sets it on
	 * Enter so the stream shows the message and a thinking indicator at once,
	 * instead of after session creation, `agent_start` and the first token.
	 */
	readonly pendingTurn: PendingTurn | null;
	readonly bootstrapCwd: string;
	/**
	 * The host's default workspace: where a new conversation starts when no
	 * workspace is on offer. It is the launch folder unless that folder was
	 * removed from workspace navigation, in which case the host reports the home
	 * fallback — a removed folder must not become the target of new work.
	 */
	readonly defaultCwd: string;
	/**
	 * `defaultCwd` is the home fallback because the launch folder was removed,
	 * so the page names it "默认项目" instead of the last path segment.
	 */
	readonly defaultCwdFallback: boolean;
	/**
	 * The first bootstrap pass finished: a session or a draft has been chosen.
	 * Until then the pane is still loading, not an empty new conversation.
	 */
	readonly booted: boolean;
	readonly draftCwd: string;
	readonly draftPolicy: string;
	/**
	 * The Full Access risk question a draft asks itself when Full Access is
	 * picked before its session exists (the host can only ask a live session).
	 */
	readonly draftSelection: SelectionRequest | null;
	/**
	 * The answer the user gave `draftSelection`, verbatim. The new session's
	 * kernel asks the same question when the draft's tier is applied, and
	 * receives this answer instead of a second dialog.
	 */
	readonly draftFullAccessAnswer: string;
	/**
	 * The user picked a tier in this draft. Until then the draft follows the
	 * tier the Step settings name for its folder (`draftModels.permissionPreset`),
	 * so the first send does not overwrite a tier chosen elsewhere (the CLI).
	 */
	readonly draftPolicyPicked: boolean;
	/** `${provider}\u0000${modelId}` the user picked for a new session, or "" for the server's default. */
	readonly draftModel: string;
	/** Thinking level the user picked for a new session, or "" for the server's default. */
	readonly draftThinking: string;
	/** The server's prediction for a new session in `draftCwd` (`GET /api/v1/models`); null until loaded. */
	readonly draftModels: DraftModels | null;
	readonly statusById: ReadonlyMap<string, SessionStatus>;
	readonly unreadById: ReadonlyMap<string, boolean>;
	readonly foldedProjects: ReadonlySet<string>;
	/** Workspace groups showing every conversation instead of the first few (`features/sidebar/collapse.ts`). */
	readonly expandedProjects: ReadonlySet<string>;
	readonly groups: readonly TagGroup[];
	/** session id -> tag colour */
	readonly tags: ReadonlyMap<string, TagColor>;
	/** Session ids pinned in the sidebar, most recently pinned first: a pinned row leads the list it belongs to. */
	readonly pinnedSessions: readonly string[];
	/** Session ids in the order the user dragged them into the sidebar (see `state/session-order.ts`). */
	readonly sessionOrder: readonly string[];
	readonly currentView: ConversationView;
	readonly currentFilter: TagColor | null;
	readonly login: LoginReport | null;
	/** The signed-in account's name and avatar; null until the host answers. */
	readonly account: AccountReport | null;
	/** The in-page workspace browser (legacy workspaceBrowserPath/Parent, workspaceDirectories). */
	readonly workspaceBrowser: DirectoryListing;
	readonly directoryPicker: DirectoryPickerMode;
	/**
	 * The running build's identity, as the host reported it in the bootstrap
	 * payload: the product version and, for an installed build, when it was made.
	 * Settings shows it so anyone can tell which build a window is running.
	 */
	readonly build: { readonly version?: string; readonly madeAt?: string };
	/** The system folder chooser request is pending (`#addWorkspace[aria-busy]`). */
	readonly pickingFolder: boolean;
	readonly tree: TreeState;
	/** Expanded folders remembered per workspace for this page load. */
	readonly treeExpandedByCwd: ReadonlyMap<string, ReadonlySet<string>>;
	readonly workspaces: readonly WebWorkspace[];
	readonly preview: PreviewState;
	readonly showArchived: boolean;
	readonly policiesCache: readonly PolicyPreset[];
	readonly modes: Readonly<Record<ModeId, boolean>>;
	readonly attachments: readonly Attachment[];
	readonly theme: ThemeChoice;
	readonly locale: Locale;
	readonly ui: UiState;
	readonly toast: ToastState | null;
}

export function emptyTree(cwd = ""): TreeState {
	return {
		cwd,
		children: new Map(),
		expanded: new Set(),
		loading: new Set(),
		truncated: new Set(),
		errors: new Map(),
		results: null,
		resultsTruncated: false,
	};
}

function initialTheme(): ThemeChoice {
	const stored = readStorage(STORAGE_KEYS.theme);
	return stored === "light" || stored === "dark" || stored === "violet" ? stored : "system";
}

/**
 * A stored choice wins. Without one, Desktop follows the operating system's
 * language (Chromium reports it as `navigator.language`): Chinese stays
 * Chinese, anything else is English. A plain browser keeps the zh-CN default.
 */
function initialLocale(): Locale {
	const stored = readStorage(STORAGE_KEYS.locale);
	if (stored === "en-US" || stored === "zh-CN") return stored;
	if (!isDesktopHost() || typeof navigator === "undefined") return "zh-CN";
	const system = navigator.languages?.[0] ?? navigator.language ?? "";
	return system.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function createInitialState(): AppState {
	const arrangement = readSessionPreferences();
	return {
		sessions: [],
		current: null,
		performanceRun: null,
		contextFill: null,
		timelineItems: [],
		notices: [],
		compacting: false,
		pendingTurn: null,
		bootstrapCwd: "",
		defaultCwd: "",
		defaultCwdFallback: false,
		booted: false,
		draftCwd: "",
		draftPolicy: "approve-for-me",
		draftSelection: null,
		draftFullAccessAnswer: "",
		draftPolicyPicked: false,
		draftModel: "",
		draftThinking: "",
		draftModels: null,
		statusById: new Map(),
		unreadById: new Map(),
		foldedProjects: new Set(),
		expandedProjects: new Set(),
		groups: [],
		tags: new Map(),
		pinnedSessions: arrangement.pinnedSessions,
		sessionOrder: arrangement.sessionOrder,
		currentView: "project",
		currentFilter: null,
		login: null,
		account: null,
		workspaceBrowser: { path: "", parent: "", directories: [] },
		directoryPicker: "browse",
		build: {},
		pickingFolder: false,
		tree: emptyTree(),
		treeExpandedByCwd: new Map(),
		workspaces: [],
		preview: {
			mode: "files",
			changes: null,
			tabs: [],
			active: -1,
			open: false,
			wrap: readStorage(STORAGE_KEYS.previewWrap) !== "0",
		},
		showArchived: false,
		policiesCache: [],
		modes: { goal: false, plan: false, ultraloop: false },
		attachments: [],
		theme: initialTheme(),
		locale: initialLocale(),
		ui: {
			// Every inspector, Summary included, starts closed; the rail or session activity opens one.
			rightPanel: null,
			rightPanelExpanded: false,
			rightPanelMenu: false,
			terminalOpen: false,
			// `?sb=0` starts with the sidebar collapsed (legacy bootstrap).
			sidebarHidden: typeof location !== "undefined" && location.search.includes("sb=0"),
			sidebarWidth: null,
			previewWidth: null,
			resizing: false,
			fileTreeOpen: false,
			searchOpen: false,
			workspacePopoverOpen: false,
			accountMenuOpen: false,
			branchPopoverOpen: false,
			branchCreateOpen: false,
			workspaceBrowserOpen: false,
			workspaceRemoval: null,
			settingsPage: null,
			settingsEditor: null,
			settingsDialog: null,
			workspaceMenu: null,
			sessionMenu: null,
			streamMenu: false,
			tagPicker: null,
			authExpired: false,
			renameSession: null,
			logoutConfirm: null,
			loginRequired: false,
			promptFocusRequest: 0,
			editingPrompt: null,
			midView: null,
			openingSession: null,
			draftRow: null,
			changesMenu: null,
			slashMenu: null,
			fileCompletionOpen: false,
			browserOpenRequest: null,
			revealEntry: null,
			childView: null,
			imagePreview: null,
		},
		toast: null,
	};
}

export const appStore: Store<AppState> = createStore(createInitialState());

export const getState = (): AppState => appStore.getState();
export const setState = (updater: StateUpdater<AppState>): void => appStore.setState(updater);

/** Merge a patch into `state.ui`. */
export function setUi(updater: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
	appStore.setState((state) => {
		const patch = typeof updater === "function" ? updater(state.ui) : updater;
		const unchanged = (Object.keys(patch) as Array<keyof UiState>).every((key) =>
			Object.is(patch[key], state.ui[key]),
		);
		return unchanged ? {} : { ui: { ...state.ui, ...patch } };
	});
}

/** Replace `state.tree` with the updater's result (return the same object to skip). */
export function setTree(updater: (tree: TreeState) => TreeState): void {
	appStore.setState((state) => ({ tree: updater(state.tree) }));
}

/** Replace `state.preview` with the updater's result. */
export function setPreview(updater: (preview: PreviewState) => PreviewState): void {
	appStore.setState((state) => ({ preview: updater(state.preview) }));
}

/* ── Immutable collection helpers ────────────────────────────────────────── */

export function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
	const next = new Map(map);
	next.set(key, value);
	return next;
}

export function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): Map<K, V> {
	const next = new Map(map);
	next.delete(key);
	return next;
}

export function setWith<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	next.add(value);
	return next;
}

export function setWithout<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	next.delete(value);
	return next;
}

export function setToggled<T>(set: ReadonlySet<T>, value: T, include = !set.has(value)): Set<T> {
	return include ? setWith(set, value) : setWithout(set, value);
}

/* ── React binding ───────────────────────────────────────────────────────── */

export function shallowEqual<T>(left: T, right: T): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	return leftKeys.every((key) =>
		Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
	);
}

/**
 * Subscribe a component to a slice of the app state.
 *
 * The selector may build a fresh object/array: the previous value is reused
 * when `isEqual` (default `Object.is`; pass `shallowEqual` for object slices)
 * says nothing changed, which keeps useSyncExternalStore from looping.
 */
export function useAppStore<T>(
	selector: (state: AppState) => T,
	isEqual: (left: T, right: T) => boolean = Object.is,
): T {
	const cache = useRef<{ state: AppState; selector: (state: AppState) => T; value: T } | null>(null);
	const getSnapshot = (): T => {
		const state = appStore.getState();
		const cached = cache.current;
		if (cached && cached.state === state && cached.selector === selector) return cached.value;
		const value = selector(state);
		if (cached && isEqual(cached.value, value)) {
			cache.current = { state, selector, value: cached.value };
			return cached.value;
		}
		cache.current = { state, selector, value };
		return value;
	};
	return useSyncExternalStore(appStore.subscribe, getSnapshot, getSnapshot);
}
