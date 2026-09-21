/**
 * The first-run screen that offers to migrate other agents' MCP servers.
 *
 * Every recognised server gets its own row showing the name, where it came
 * from, and whether it can be imported, because the alternative — one row per
 * source with a count — asks the user to approve a list they cannot see. A
 * server that cannot be imported stays on screen with its reason instead of
 * being filtered out, so an omission reads as an explanation rather than a bug.
 */

import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@step-harness/pi-tui";
import { DynamicBorder } from "../render/dynamic-border.ts";
import { initTheme, theme } from "../theme/theme.ts";
import type { StepMcpImportCandidate, StepMcpImportSourceStatus } from "./mcp-import.ts";

export interface StepMcpImportViewCallbacks {
	/** Target names the user confirmed. Empty when nothing was checked. */
	onConfirm(targetNames: string[]): void;
	onCancel(): void;
	requestRender(): void;
}

const MAX_VISIBLE_ROWS = 12;
/** Breathing room between the name column and the reason that follows it. */
const LABEL_COLUMN_GAP = 2;

export class StepMcpImportView extends Container implements Component, Focusable {
	private readonly candidates: readonly StepMcpImportCandidate[];
	private readonly sources: readonly StepMcpImportSourceStatus[];
	private readonly callbacks: StepMcpImportViewCallbacks;
	private readonly selectList: SelectList;
	private readonly checked = new Set<string>();
	private focusedState = false;

	constructor(
		candidates: readonly StepMcpImportCandidate[],
		sources: readonly StepMcpImportSourceStatus[],
		callbacks: StepMcpImportViewCallbacks,
	) {
		super();
		try {
			theme.fg("text", "");
		} catch {
			initTheme("dark", false);
		}
		this.candidates = candidates;
		this.sources = sources;
		this.callbacks = callbacks;

		for (const candidate of candidates) {
			// Importable servers start checked: the user opened this prompt by
			// launching Step with those configs present, so "take them" is the
			// answer that needs the fewest keystrokes. Unchecking is one Space.
			if (candidate.config) this.checked.add(candidate.targetName);
		}

		// SelectList clamps its name column to 32 columns unless told otherwise,
		// which cuts a label like "[-] konva-documentation  Claude Code" mid-word
		// and leaves the user reading "Claud". Size the column to the widest label
		// we actually build; renderItem still re-clamps it to what the terminal
		// has, so a narrow window degrades instead of overflowing.
		const labelWidth = this.buildItems().reduce((widest, item) => Math.max(widest, visibleWidth(item.label)), 0);
		this.selectList = new SelectList(
			this.buildItems(),
			Math.min(MAX_VISIBLE_ROWS, Math.max(1, candidates.length)),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("muted", text),
				noMatch: (text) => theme.fg("muted", text),
			},
			{
				minPrimaryColumnWidth: labelWidth + LABEL_COLUMN_GAP,
				maxPrimaryColumnWidth: labelWidth + LABEL_COLUMN_GAP,
			},
		);
		this.selectList.onSelect = () => this.confirm();
		this.selectList.onCancel = () => this.callbacks.onCancel();
		this.rebuild();
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.toggle")) {
			this.toggleSelected();
			return;
		}
		this.selectList.handleInput(data);
		this.rebuild();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(20, Math.floor(width));
		return this.renderRows(safeWidth).map((row) => truncateToWidth(row, safeWidth, "", false));
	}

	private confirm(): void {
		this.callbacks.onConfirm(
			this.candidates
				.filter((candidate) => candidate.config && this.checked.has(candidate.targetName))
				.map((candidate) => candidate.targetName),
		);
	}

	private toggleSelected(): void {
		const candidate = this.candidates[this.selectList.getSelectedIndex()];
		// A blocked row is deliberately inert rather than absent: it explains an
		// omission the user would otherwise have to guess at.
		if (!candidate?.config) return;
		if (this.checked.has(candidate.targetName)) this.checked.delete(candidate.targetName);
		else this.checked.add(candidate.targetName);
		this.refreshItems();
	}

	private refreshItems(): void {
		const index = this.selectList.getSelectedIndex();
		this.selectList.setItems(this.buildItems());
		this.selectList.setSelectedIndex(index);
		this.rebuild();
	}

	private buildItems(): SelectItem[] {
		const nameWidth = this.candidates.reduce(
			(widest, candidate) => Math.max(widest, visibleWidth(candidate.name)),
			0,
		);
		return this.candidates.map((candidate) => {
			const glyph = this.selectionGlyph(candidate);
			const padded = candidate.name.padEnd(nameWidth, " ");
			return {
				value: candidate.targetName,
				label: `${glyph} ${padded}  ${candidate.sourceLabel}`,
				description: this.describeCandidate(candidate),
			};
		});
	}

	/**
	 * `[x]` read as "excluded" to more than one person, which is the opposite of
	 * what it meant. A green check is unambiguous, and the house glyph is the
	 * narrow U+2713 rather than the emoji variant: the emoji renders two columns
	 * wide in most terminals and would knock this list out of alignment.
	 *
	 * All three states are padded to one visible column so the name column starts
	 * at the same offset on every row.
	 */
	private selectionGlyph(candidate: StepMcpImportCandidate): string {
		if (!candidate.config) return theme.fg("muted", "-");
		if (this.checked.has(candidate.targetName)) return theme.fg("success", "✓");
		return theme.fg("muted", "○");
	}

	private describeCandidate(candidate: StepMcpImportCandidate): string {
		// A duplicate is not a failure: the server *is* being imported, just under
		// the row that claimed the name first. Saying "cannot import" there reads
		// as a loss the user needs to act on.
		if (candidate.blocked) {
			return candidate.blocked.kind === "duplicate"
				? candidate.blocked.detail
				: `cannot import — ${candidate.blocked.detail}`;
		}
		// A renamed target is the one thing the user cannot see anywhere else,
		// and it changes the tool names the model will call.
		if (candidate.targetName !== candidate.name) return `imports as '${candidate.targetName}' — ${candidate.summary}`;
		return candidate.summary;
	}

	private renderRows(width: number): string[] {
		const muted = (value: string) => theme.fg("muted", value);
		const selectable = this.candidates.filter((candidate) => candidate.config).length;
		const rows: string[] = [
			theme.fg("accent", theme.bold("Import MCP servers from your other agent CLIs")),
			"",
			"Step found MCP servers configured in your Codex and Claude Code. Confirm whether to migrate them to Step.",
			`If you confirm, they will be copied into ${muted("~/.stepcode/config.toml")}.`,
			"",
		];

		for (const source of this.sources) {
			rows.push(`  ${sourceLine(source, muted)}`);
		}
		rows.push("");

		if (this.candidates.length === 0) {
			rows.push(muted("  No importable servers were found."), "", muted("  Enter continue"));
			return rows;
		}

		rows.push(...this.selectList.render(Math.max(1, width - 2)));
		rows.push("");
		rows.push(
			muted(`  ${this.checked.size}/${selectable} selected · ↑/↓ move · Space toggle · Enter import · Esc skip`),
		);
		return rows;
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(this.renderRows(100).join("\n"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.callbacks.requestRender();
	}
}

function sourceLine(source: StepMcpImportSourceStatus, muted: (value: string) => string): string {
	switch (source.state) {
		case "ok":
			return `${source.label}: ${source.importable} of ${source.total} server(s) can be imported`;
		default:
			return muted(`${source.label}: ${source.detail ?? "nothing to import"}`);
	}
}
