import { t } from "../i18n";
import { STORAGE_KEYS } from "../lib/storage";
import {
	parseTagGroupCloseAttempt,
	parseTagGroupData,
	type StepcodeDesktopBridge,
	type TagGroupData,
} from "../platform/desktop-bridge";
import { getDesktopBridge } from "../platform/host";
import { showError } from "./session";
import { getState, setState } from "./store";
import { readBrowserTagGroups, type TagGroupState } from "./tag-groups";

type GroupEdit = (state: TagGroupState) => Partial<TagGroupState>;
const GROUP_WAIT_MS = 10000;
function snapshot(state: TagGroupState): TagGroupData {
	return parseTagGroupData({ version: 1, groups: state.groups, tags: [...state.tags] });
}
function report(error: unknown, operation: "tagGroupsLoadFailed" | "tagGroupsSaveFailed"): void {
	const detail = error instanceof Error ? error.message : String(error);
	const message = t(operation, { detail });
	setState(operation === "tagGroupsLoadFailed" ? { tagGroupsLoadError: message } : { tagGroupsSaveError: message });
	showError(message);
}
function commit(data: TagGroupData, pruneFilter = true): void {
	// Only group fields belong to this write; unrelated UI changes during IPC must survive.
	setState((state) => ({
		groups: data.groups,
		tags: new Map(data.tags),
		...(pruneFilter
			? {
					currentFilter: data.groups.some((group) => group.key === state.currentFilter)
						? state.currentFilter
						: null,
				}
			: {}),
	}));
}
/** Bounds waiting, not the underlying idempotent request; late reads cannot publish after expiry. */
function bounded<T>(promise: Promise<T>, milliseconds = GROUP_WAIT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(t("tagGroupsTimeout"))), Math.max(0, milliseconds));
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

/** Recovery, projected unconfirmed edits and close preparation for one bridge/document lifetime. */
class DesktopGroupPersistence {
	private readonly bridge: StepcodeDesktopBridge;
	private ready = false;
	private loading: Promise<boolean> | undefined;
	private edits: GroupEdit[] = [];
	private writes: Promise<void> = Promise.resolve();
	private queued = 0;
	private pending: TagGroupData | undefined;
	private pendingReconcile: (() => TagGroupData) | undefined;
	private writeError: unknown;
	private saving = false;
	private validationError: unknown;
	private frozen = false;
	private permit = false;
	private closing: Promise<void> | undefined;
	constructor(bridge: StepcodeDesktopBridge) {
		this.bridge = bridge;
	}

	load(): Promise<boolean> {
		if (this.ready) return Promise.resolve(true);
		if (this.loading) return this.loading;
		this.loading = bounded(this.bridge.readTagGroups())
			.then((raw) => {
				if (desktop !== this) return false;
				commit(raw === null ? { version: 1, groups: [], tags: [] } : parseTagGroupData(raw));
				setState({ tagGroupsLoadError: null });
				this.ready = true;
				for (const edit of this.edits.splice(0)) this.enqueue(edit);
				return true;
			})
			.catch((error: unknown) => {
				if (desktop === this) report(error, "tagGroupsLoadFailed");
				return false;
			})
			.finally(() => {
				this.loading = undefined;
			});
		return this.loading;
	}
	edit(edit: GroupEdit, maintenance: boolean): void {
		if (this.frozen || (maintenance && this.pending && this.writeError !== undefined)) return;
		if (this.ready) this.enqueue(edit, maintenance);
		else {
			this.edits.push(edit);
			void this.load();
		}
	}
	private enqueue(edit: GroupEdit, maintenance = false): void {
		this.queued++;
		this.writes = this.writes
			.catch(() => {
				// Failure remains in pending projection; subsequent valid edits include it in their full snapshot.
			})
			.then(async () => {
				if (desktop !== this) return;
				const confirmed = getState();
				const pending = this.pendingReconcile?.() ?? this.pending;
				if (pending) this.pending = pending;
				const state = pending ? { ...confirmed, groups: pending.groups, tags: new Map(pending.tags) } : confirmed;
				let data: TagGroupData;
				let patch: Partial<TagGroupState>;
				try {
					patch = edit(state);
					data = snapshot({ ...state, ...patch });
				} catch (error) {
					this.validationError = error;
					showError(error instanceof Error ? error.message : String(error));
					throw error;
				}
				this.validationError = undefined;
				if (JSON.stringify(data) === JSON.stringify(snapshot(state))) {
					if (!this.pending) commit(data, patch.currentFilter !== undefined);
					return;
				}
				this.pending = data;
				// Retain the unpruned source while a list-derived write is in flight or waiting for retry.
				this.pendingReconcile = maintenance ? () => snapshot({ ...state, ...edit(state) }) : undefined;
				await this.save(data, patch.currentFilter !== undefined, this.pendingReconcile);
			})
			.finally(() => {
				this.queued--;
			});
		void this.writes.catch(() => {
			// flush and the save/validation owner observe the failure.
		});
	}
	private async save(data: TagGroupData, pruneFilter: boolean, reconcile?: () => TagGroupData): Promise<void> {
		this.saving = true;
		try {
			for (;;) {
				await this.bridge.saveTagGroups(data);
				if (desktop !== this) return;
				const current = reconcile?.();
				if (!current || JSON.stringify(current) === JSON.stringify(data)) break;
				// The previous IPC cannot be unsent. Correct it before publishing or permitting close.
				data = current;
				this.pending = data;
			}
			this.pending = undefined;
			this.pendingReconcile = undefined;
			this.writeError = undefined;
			setState({ tagGroupsSaveError: null });
			commit(data, pruneFilter);
		} catch (error) {
			this.writeError = error;
			if (desktop === this) report(error, "tagGroupsSaveFailed");
			throw error;
		} finally {
			this.saving = false;
		}
	}
	async flush(): Promise<void> {
		if (!(await this.load())) throw new Error(getState().tagGroupsLoadError ?? t("tagGroupsTimeout"));
		await this.writes;
		if (this.writeError !== undefined) throw this.writeError;
		if (this.validationError !== undefined) throw this.validationError;
	}
	private dirty(): boolean {
		return this.edits.length > 0 || this.queued > 0 || this.pending !== undefined;
	}
	beforeUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">): void {
		if (this.permit) {
			this.permit = false;
			return;
		}
		if (!this.dirty()) return;
		event.preventDefault();
		event.returnValue = "";
		if (this.closing) return;
		this.frozen = true;
		this.closing = this.prepareClose().finally(() => {
			// A successful native completion schedules its unload after the invoke reply; admit no edit in that gap.
			if (!this.permit) this.frozen = false;
			this.closing = undefined;
		});
	}
	private async prepareClose(): Promise<void> {
		let attempt: ReturnType<typeof parseTagGroupCloseAttempt> = null;
		const deadline = Date.now() + GROUP_WAIT_MS;
		try {
			attempt = parseTagGroupCloseAttempt(await bounded(this.bridge.beginTagGroupClose(), deadline - Date.now()));
			const drain = async () => {
				// Retry a retained failed snapshot only on a new close, never duplicate an in-flight invoke.
				if (!this.saving && this.queued === 0 && this.pending && this.writeError !== undefined) {
					this.pending = this.pendingReconcile?.() ?? this.pending;
					this.writes = this.save(this.pending, true, this.pendingReconcile);
					void this.writes.catch(() => {});
				}
				if (!(await this.load())) throw new Error(getState().tagGroupsLoadError ?? t("tagGroupsTimeout"));
				try {
					await this.writes;
				} catch (error) {
					if (this.dirty()) throw error;
				}
				if (this.writeError !== undefined) throw this.writeError;
			};
			const expiresAt = attempt ? Math.min(deadline, attempt.expiresAt) : deadline;
			await bounded(drain(), expiresAt - Date.now());
			if (desktop !== this) return;
			if (attempt) {
				this.permit = true;
				const completed: unknown = await bounded(
					this.bridge.completeTagGroupClose(attempt.attemptId, "saved"),
					expiresAt - Date.now(),
				);
				if (completed !== true) {
					this.permit = false;
					throw new Error(t("tagGroupsTimeout"));
				}
			}
		} catch (error) {
			this.permit = false;
			if (attempt) {
				// Do not freeze editing while waiting for cancellation transport; main independently expires the token.
				void this.bridge.completeTagGroupClose(attempt.attemptId, "failed").catch(() => {});
			}
			if (desktop === this)
				showError(t("tagGroupsCloseFailed", { detail: error instanceof Error ? error.message : String(error) }));
		}
	}
	waitForClose(): Promise<void> {
		return this.closing ?? Promise.resolve();
	}
}

let desktop: DesktopGroupPersistence | undefined;
let desktopBridge: StepcodeDesktopBridge | undefined;
let browserLoadError: unknown;
let browserWriteError: unknown;
function owner(): DesktopGroupPersistence | undefined {
	const bridge = getDesktopBridge();
	if (bridge !== desktopBridge) {
		desktopBridge = bridge;
		desktop = bridge ? new DesktopGroupPersistence(bridge) : undefined;
	}
	return desktop;
}

/** Recovery gates group pruning, not session-list fetching or bootstrap. */
export function restoreTagGroups(): Promise<boolean> {
	const persistence = owner();
	if (persistence) return persistence.load();
	try {
		commit(readBrowserTagGroups() ?? { version: 1, groups: [], tags: [] });
		browserLoadError = undefined;
		setState({ tagGroupsLoadError: null });
		return Promise.resolve(true);
	} catch (error) {
		browserLoadError = error;
		report(error, "tagGroupsLoadFailed");
		return Promise.resolve(false);
	}
}
/** All accepted mutations persist before publishing. Maintenance cannot repair an unrelated failed edit. */
export function updateTagGroups(edit: GroupEdit, maintenance = false): void {
	const persistence = owner();
	if (persistence) {
		persistence.edit(edit, maintenance);
		return;
	}
	try {
		const data = readBrowserTagGroups();
		if (browserLoadError !== undefined) commit(data ?? { version: 1, groups: [], tags: [] });
		browserLoadError = undefined;
		setState({ tagGroupsLoadError: null });
	} catch (error) {
		browserLoadError = error;
		report(error, "tagGroupsLoadFailed");
		return;
	}
	try {
		const state = getState();
		const patch = edit(state);
		const data = snapshot({ ...state, ...patch });
		if (JSON.stringify(data) !== JSON.stringify(snapshot(state))) {
			localStorage.setItem(STORAGE_KEYS.tagGroups, JSON.stringify(data));
			browserWriteError = undefined;
			setState({ tagGroupsSaveError: null });
		}
		commit(data, patch.currentFilter !== undefined);
	} catch (error) {
		browserWriteError = error;
		report(error, "tagGroupsSaveFailed");
	}
}
/** Await acknowledged operations. Pure failed validation is observable but is not accepted dirty work. */
export async function flushTagGroups(): Promise<void> {
	const persistence = owner();
	if (persistence) await persistence.flush();
	else {
		if (!(await restoreTagGroups())) throw browserLoadError;
		if (browserWriteError !== undefined) throw browserWriteError;
	}
}
/** The synchronous shell veto never starts recovery for a clean page. */
export function handleTagGroupBeforeUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">): void {
	owner()?.beforeUnload(event);
}
/** Joins the actual hook-owned attempt; also provides an offline lifecycle test seam. */
export function waitForTagGroupClose(): Promise<void> {
	return owner()?.waitForClose() ?? Promise.resolve();
}
