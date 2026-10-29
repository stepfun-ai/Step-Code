import { useCallback, useRef, useSyncExternalStore } from "react";
import type {
	MigrationAcknowledgement,
	MigrationJob,
	MigrationKind,
	MigrationPlan,
	MigrationRecoveryPreview,
	MigrationScanResult,
	MigrationScope,
} from "../../state/types";
import type { MigrationDraft } from "./model";

export type MigrationOrigin = "onboarding" | "settings";
export interface MigrationState {
	readonly open: boolean;
	readonly origin: MigrationOrigin;
	readonly stage: "invitation" | "select" | "review" | "job";
	readonly kind: MigrationKind;
	readonly scanKinds: readonly MigrationKind[];
	readonly projectCwds: readonly string[];
	readonly mcpSourcePaths: Readonly<Partial<Record<"claude-code" | "codex", string>>>;
	readonly scan: MigrationScanResult | null;
	readonly sessionOptions: { range: "all" | "7" | "30" | "90"; limit: 30 | 50 | 100 | null };
	readonly scannedKinds: readonly MigrationKind[];
	readonly closeRequested: boolean;
	readonly closeWhenSettled: boolean;
	readonly scanning: boolean;
	readonly drafts: Readonly<Record<string, MigrationDraft>>;
	readonly defaultTargets: Readonly<Partial<Record<MigrationKind, MigrationScope>>>;
	readonly focusedId: string | null;
	readonly plan: MigrationPlan | null;
	readonly startKey: string | null;
	readonly busy: "selection" | "plan" | "start" | "cancel" | "recovery" | null;
	readonly job: MigrationJob | null;
	readonly jobs: readonly MigrationJob[];
	readonly historyLoading: boolean;
	readonly error: string | null;
	readonly pollError: string | null;
	readonly recovery: MigrationRecoveryPreview | null;
	readonly recoveryAcknowledged: readonly MigrationAcknowledgement[];
	readonly recovered: readonly string[];
}
let state: MigrationState = {
	open: false,
	origin: "settings",
	stage: "invitation",
	kind: "sessions",
	scanKinds: ["sessions", "mcp", "rules"],
	projectCwds: [],
	mcpSourcePaths: {},
	scan: null,
	sessionOptions: { range: "all", limit: 100 },
	scannedKinds: [],
	closeRequested: false,
	closeWhenSettled: false,
	scanning: false,
	drafts: {},
	defaultTargets: {},
	focusedId: null,
	plan: null,
	startKey: null,
	busy: null,
	job: null,
	jobs: [],
	historyLoading: false,
	error: null,
	pollError: null,
	recovery: null,
	recoveryAcknowledged: [],
	recovered: [],
};
const listeners = new Set<() => void>();
export function getMigrationState(): MigrationState {
	return state;
}
export function updateMigration(patch: Partial<MigrationState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function useMigrationStore<T>(selector: (value: MigrationState) => T): T {
	const selectorRef = useRef(selector);
	selectorRef.current = selector;
	const cached = useRef<{ state: MigrationState; selector: typeof selector; value: T } | null>(null);
	const snapshot = useCallback(() => {
		if (cached.current?.state === state && cached.current.selector === selectorRef.current)
			return cached.current.value;
		const value = selectorRef.current(state);
		cached.current = { state, selector: selectorRef.current, value };
		return value;
	}, []);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
