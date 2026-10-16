import {
	type AccountUsageState,
	type ExtensionCommandContext,
	stripAnsi,
	theme,
	type UsagePresentation,
} from "@step-harness/coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@step-harness/pi-tui";
import { renderStepDialogFrame } from "./step-dialog.ts";

const count = (n: number | bigint): string => new Intl.NumberFormat("en-US").format(n);
const dateTime = (ms: number | null): string =>
	ms === null
		? "Unknown"
		: new Intl.DateTimeFormat("en-US", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				timeZoneName: "shortOffset",
			}).format(ms);
const field = (name: string, value: string): string => `${name.padEnd(22)} ${value}`;
const safe = (text: string): string => stripAnsi(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "");

function remainingQuota(usedPercent: number | null): string {
	if (usedPercent === null) return "Remaining percentage unavailable";
	const remaining = 100 - usedPercent,
		filled = Math.round((remaining / 100) * 12);
	return `[${theme.fg("accent", "▆".repeat(filled))}${theme.fg("dim", "▁".repeat(12 - filled))}] ${remaining.toFixed(1)}% left`;
}

function accountRows(state: AccountUsageState, cached = false): string[] {
	const snapshot = state.snapshot,
		now = Date.now();
	const lines = [state.status === "loading" ? "Refreshing account…" : ""];
	if (state.message) lines.push(state.message);
	if (state.retryAt && state.retryAt > now) lines.push(`Retry in ${Math.ceil((state.retryAt - now) / 1000)}s`);
	if (!snapshot) {
		if (!state.message) lines.push(cached ? "Not cached · open /usage account" : "Account quota not cached.");
		return lines.filter(Boolean);
	}
	lines.push(
		`Plan · ${snapshot.plan.name ?? (snapshot.plan.state === "unavailable" ? "Name unavailable" : snapshot.plan.family.toUpperCase())}`,
	);
	lines.push(
		`${state.status === "stale" ? "Stale · " : cached ? "Cached · " : ""}Updated ${dateTime(snapshot.observed_at_ms)}`,
	);
	if (snapshot.plan.subscription?.expires_at_ms)
		lines.push(field("Plan expires:", dateTime(snapshot.plan.subscription.expires_at_ms)));
	if (snapshot.plan.family === "none") lines.push("No personal plan or credit buckets");
	for (const window of snapshot.quota.windows) {
		const name = window.id === "five_hour" ? "5-hour" : "Weekly";
		const expired =
			window.resets_at_ms !== null && window.resets_at_ms <= now && (state.receivedAt ?? 0) < window.resets_at_ms;
		if (expired) {
			lines.push(field(`${name} limit:`, "Snapshot expired · open /usage account"));
			continue;
		}
		if (!window.limited) {
			lines.push(field(`${name} limit:`, "Unlimited"));
			continue;
		}
		lines.push(field(`${name} limit:`, remainingQuota(window.used_percent)));
		lines.push(field("", `Resets ${dateTime(window.resets_at_ms)}`));
	}
	if (snapshot.quota.credit_buckets === null) lines.push("Credit bucket details temporarily unavailable");
	for (const [index, bucket] of (snapshot.quota.credit_buckets ?? []).entries()) {
		if (bucket.unsupported) {
			lines.push(`Unsupported bucket type: ${safe(bucket.type)}`);
			continue;
		}
		if (
			(bucket.expires_at_ms !== null && bucket.expires_at_ms <= now) ||
			(bucket.resets_at_ms !== null && bucket.resets_at_ms <= now && (state.receivedAt ?? 0) < bucket.resets_at_ms)
		) {
			lines.push(`Bucket ${index + 1}: snapshot expired · refresh account`);
			continue;
		}
		lines.push(
			field(
				bucket.type === "subscription" ? "Subscription Credits:" : `Top-up ${index + 1}:`,
				remainingQuota(bucket.used_percent),
			),
		);
		if (bucket.resets_at_ms !== null) lines.push(field("", `Resets ${dateTime(bucket.resets_at_ms)}`));
		lines.push(field("", `Expires ${dateTime(bucket.expires_at_ms)}`));
	}
	if (!cached) {
		lines.push(
			snapshot.quota.allowed
				? "Quota check: available"
				: `Quota check: restricted${snapshot.quota.reason ? ` (${snapshot.quota.reason})` : ""}`,
		);
		lines.push(
			"Account usage includes other projects and devices.",
			"Quota availability does not guarantee model access.",
		);
	}
	return lines.filter(Boolean);
}

function heatmap(model: UsagePresentation, width: number): string[] {
	const overview = model.overview;
	if (!overview) return [model.overviewError ?? "Scanning local activity…"];
	const days = overview.days,
		prefix = new Date(`${days[0].date}T12:00:00`).getDay();
	const weeks: (typeof days)[] = [];
	let week: typeof days = [];
	for (let i = 0; i < prefix; i++) week.push({ date: "", tokens: 0, chats: 0 });
	for (const day of days) {
		week.push(day);
		if (week.length === 7) {
			weeks.push(week);
			week = [];
		}
	}
	if (week.length) weeks.push(week);
	const visible = Math.max(1, Math.min(weeks.length, Math.floor((width - 8) / 2))),
		shown = weeks.slice(-visible),
		max = Math.max(1, ...days.map((day) => day.tokens));
	const rows = [`365 days · ${overview.scope === "all" ? "All projects" : "Current project"}`];
	const monthRow = Array<string>(visible * 2).fill(" ");
	let previousMonth = "";
	for (const [index, w] of shown.entries()) {
		const d = w.find((day) => day.date);
		if (!d) continue;
		const month = d.date.slice(0, 7);
		if (month !== previousMonth) {
			const label = new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${d.date}T12:00:00`));
			for (let j = 0; j < label.length && index * 2 + j < monthRow.length; j++) monthRow[index * 2 + j] = label[j];
			previousMonth = month;
		}
	}
	rows.push(`    ${monthRow.join("")}`);
	for (let row = 0; row < 7; row++)
		rows.push(
			`${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][row]}  ${shown
				.map((w) => {
					const d = w[row];
					if (!d?.date) return "  ";
					if (d.date === model.selectedDate) return theme.fg("accent", "▣ ");
					return d.tokens === 0
						? theme.fg("dim", "· ")
						: theme.fg("accent", `${["░", "▒", "▓", "█"][Math.min(3, Math.ceil((d.tokens / max) * 4) - 1)]} `);
				})
				.join("")}`,
		);
	rows.push(
		`    Less ${theme.fg("dim", "·")} ${theme.fg("accent", "░ ▒ ▓ █")} More · ${theme.fg("accent", "▣")} Selected day`,
	);
	if (visible < weeks.length) rows.push(`Showing the latest ${visible} weeks; totals cover the full year.`);
	const selected = days.find((d) => d.date === model.selectedDate) ?? days.at(-1)!;
	rows.push(
		`${selected.date} · ${count(selected.tokens)} tokens · ${selected.chats} chats`,
		"",
		"Activity insights",
		field("Total chats", count(overview.chats)),
		field("Active days", count(overview.activeDays)),
		field("Total tokens", count(overview.tokens)),
	);
	const knownReasoning = overview.reasoning.filter(([level]) => level !== "unknown"),
		calls = knownReasoning.reduce((n, [, total]) => n + total, 0);
	rows.push(
		field(
			"Most used reasoning",
			knownReasoning.length
				? `${knownReasoning[0][0]} · ${((knownReasoning[0][1] / calls) * 100).toFixed(0)}% of recorded calls`
				: "Not recorded",
		),
		field(
			"Skills discovered",
			overview.discoveredSkills === null ? "Not recorded" : count(overview.discoveredSkills),
		),
		field("Total skills used", overview.usedSkills === null ? "Not recorded" : count(overview.usedSkills)),
		"",
		"Most used plugins and skills",
	);
	rows.push(
		...(overview.topResources.length
			? overview.topResources.map(([name, runs]) => field(safe(name), `${runs} runs`))
			: ["Not recorded"]),
	);
	if (overview.limited.length) rows.push("", `Coverage: ${overview.limited.join(" · ")}`);
	rows.push("", "Local activity · fork/clone copies deduplicated", "P project scope · [ / ] select day");
	return rows;
}

export function usagePresentationRows(model: UsagePresentation, width = 100, details = false): string[] {
	const s = model.status;
	if (model.view === "status") {
		const rows = [
			`Step Code (${s.version})`,
			"",
			field("Model:", `${s.model} (reasoning ${s.reasoning})`),
			field("Model provider:", s.provider),
			field("Directory:", s.directory),
			field("Permissions:", `${s.permissions} · Project ${s.trusted ? "trusted" : "untrusted"}`),
			field("Agents.md:", s.agents.length ? s.agents.join("\n                       ") : "None"),
			field(
				"Account:",
				`${s.account.accountId ?? (s.account.presence === "present" ? "Identity unknown" : "Not signed in")}${s.account.region ? ` (${s.account.region})` : ""}`,
			),
			field("Collaboration mode:", s.collaboration),
			field("Session:", s.session),
			"",
			...accountRows(s.cached, true),
		];
		if (details)
			rows.push(
				"",
				"Details",
				field("State:", s.state),
				field("Context:", s.context),
				field("Model endpoint:", s.endpoint ?? "Not configured"),
				field("Credential:", `${s.account.presence} · ${s.account.source} · validity not checked`),
				field("Config source:", s.account.profile ?? "Unknown"),
			);
		rows.push("", "Local snapshot · no network request", "D details · Esc close");
		return rows;
	}
	const rows = ["Usage", model.view === "overview" ? "[1 Overview]   2 Account" : " 1 Overview   [2 Account]", ""];
	if (model.view === "overview") rows.push(...heatmap(model, width));
	else {
		rows.push(
			...accountRows(model.account),
			"",
			"Current main session · local",
			"Includes restored/inherited history · subagents excluded",
			field("Input:", count(model.session.input)),
			field("Cache read:", count(model.session.cacheRead)),
			field(
				"Cache hit:",
				model.session.cacheHit === null ? "Unknown" : `${(model.session.cacheHit * 100).toFixed(1)}%`,
			),
			field("Output:", count(model.session.output)),
			field("Total:", `${count(model.session.total)} tokens`),
		);
		if (model.session.invalid || model.session.missing)
			rows.push(`Usage coverage: ${model.session.invalid} invalid, ${model.session.missing} missing records`);
		if (s.provider !== "step") rows.push(`Step account quota · current model uses ${s.provider}`);
		rows.push("", "R refresh account");
	}
	rows.push("1/2 or ←/→ switch tab · ↑/↓ scroll · Esc close");
	return rows;
}

export class UsagePanel implements Component {
	private readonly model: UsagePresentation;
	private readonly redraw: () => void;
	private readonly close: () => void;
	private readonly rows: () => number;
	private offset = 0;
	private details = false;
	constructor(model: UsagePresentation, redraw: () => void, close: () => void, rows: () => number) {
		this.model = model;
		this.redraw = redraw;
		this.close = close;
		this.rows = rows;
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp))
			this.offset = Math.max(0, this.offset - (matchesKey(data, Key.pageUp) ? 10 : 1));
		else if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown))
			this.offset += matchesKey(data, Key.pageDown) ? 10 : 1;
		else if (this.model.view === "status") {
			if (data === "d" || data === "D") this.details = !this.details;
		} else if (data === "1" || data === "2" || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.offset = 0;
			this.model.select(
				data === "1"
					? "overview"
					: data === "2"
						? "account"
						: this.model.view === "overview"
							? "account"
							: "overview",
			);
		} else if (data === "r" || data === "R") this.model.refresh();
		else if ((data === "p" || data === "P") && this.model.view === "overview")
			this.model.selectScope(this.model.scope === "all" ? "project" : "all");
		else if (["[", "]"].includes(data) && this.model.view === "overview" && this.model.overview) {
			const days = this.model.overview.days,
				index = Math.max(
					0,
					days.findIndex((d) => d.date === this.model.selectedDate),
				);
			this.model.selectedDate = days[Math.max(0, Math.min(days.length - 1, index + (data === "]" ? 1 : -1)))].date;
		}
		this.redraw();
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - 4),
			rows = usagePresentationRows(this.model, inner, this.details).flatMap((row) => wrapTextWithAnsi(row, inner));
		const height = Math.max(5, this.rows() - 6);
		this.offset = Math.max(0, Math.min(this.offset, rows.length - height));
		return renderStepDialogFrame(
			rows.slice(this.offset, this.offset + height).map((row) => truncateToWidth(row, inner)),
			width,
		);
	}
}

export async function showUsagePanel(ctx: ExtensionCommandContext, model: UsagePresentation): Promise<void> {
	await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		model.onChange = () => tui.requestRender();
		model.onClose = () => done();
		const panel = new UsagePanel(
			model,
			() => tui.requestRender(),
			() => done(),
			() => tui.terminal.rows,
		);
		return Object.assign(panel, {
			dispose: () => {
				model.onChange = undefined;
				model.onClose = undefined;
			},
		});
	});
}
