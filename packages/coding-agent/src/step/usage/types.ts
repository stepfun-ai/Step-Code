export type UsageView = "overview" | "account";
export interface UsageWindow {
	id: "five_hour" | "weekly";
	limited: boolean;
	used_percent: number | null;
	resets_at_ms: number | null;
}
export interface CreditBucket {
	type: string;
	total: string;
	remaining: string;
	used_percent: number | null;
	resets_at_ms: number | null;
	expires_at_ms: number | null;
	unsupported?: boolean;
}
export interface PlanUsageSnapshot {
	schema_version: 1;
	observed_at_ms: number;
	scope: "personal_account";
	account: { id: string };
	plan: {
		state: "known" | "unavailable";
		family: "coding" | "token" | "none";
		name: string | null;
		subscription: { id: string; expires_at_ms: number | null } | null;
	};
	quota: {
		state: "known" | "partial";
		allowed: boolean;
		reason: string | null;
		windows: UsageWindow[];
		credit_buckets: CreditBucket[] | null;
	};
}
export interface LocalPlanAccount {
	presence: "present" | "missing";
	eligible: boolean;
	source: string;
	profile?: string;
	region?: string;
	accountId?: string;
	endpoint?: string;
	reason?: string;
}
/** Private controller input. Never pass it to a renderer, log or telemetry. */
export interface PlanAccountContext {
	projection: LocalPlanAccount;
	key?: string;
	identity: string;
}
export interface AccountUsageState {
	status: "idle" | "loading" | "ready" | "stale" | "error" | "unsupported";
	account: LocalPlanAccount;
	snapshot?: PlanUsageSnapshot;
	message?: string;
	receivedAt?: number;
	retryAt?: number;
}

import type { SessionUsage } from "../../core/usage-totals.ts";

export type { SessionUsage } from "../../core/usage-totals.ts";
export interface OverviewDay {
	date: string;
	tokens: number;
	chats: number;
}
export interface UsageOverview {
	days: OverviewDay[];
	tokens: number;
	chats: number;
	activeDays: number;
	reasoning: [string, number][];
	discoveredSkills: number | null;
	usedSkills: number | null;
	topResources: [string, number][];
	limited: string[];
	scope: "all" | "project";
}
export interface UsageStatus {
	model: string;
	provider: string;
	reasoning: string;
	directory: string;
	permissions: string;
	trusted: boolean;
	agents: string[];
	collaboration: string;
	session: string;
	state: string;
	context: string;
	account: LocalPlanAccount;
	cached: AccountUsageState;
	version: string;
	endpoint?: string;
}
export interface UsagePresentation {
	view: UsageView | "status";
	session: SessionUsage;
	status: UsageStatus;
	account: AccountUsageState;
	overview?: UsageOverview;
	overviewError?: string;
	scope: "all" | "project";
	selectedDate: string;
	onChange?: () => void;
	onClose?: () => void;
	select(view: UsageView): void;
	refresh(): void;
	selectScope(scope: "all" | "project"): void;
}

export interface UsageResources {
	agents: string[];
	skills: { name: string; filePath: string }[];
}
