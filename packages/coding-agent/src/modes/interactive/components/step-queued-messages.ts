import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const MAX_PREVIEW_ENTRIES = 3;
const MAX_PREVIEW_LINES = 2;

export interface StepQueuedMessages {
	steering: readonly string[];
	followUp: readonly string[];
}

/**
 * The old Step queue block, backed by Pi's native steering/follow-up queues.
 * This component deliberately has no input handling; dequeue and submission
 * remain owned by InteractiveMode and the native editor keybindings.
 */
export class StepQueuedMessagesComponent implements Component {
	private steering: readonly string[] = [];
	private followUp: readonly string[] = [];

	setMessages(messages: StepQueuedMessages): void {
		this.steering = messages.steering;
		this.followUp = messages.followUp;
	}

	invalidate(): void {
		// Rendering is derived directly from the current queue snapshot.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const messages = [...this.steering, ...this.followUp];
		if (messages.length === 0) return [];

		const preview = messages.slice(0, MAX_PREVIEW_ENTRIES);
		const lines: string[] = [];
		for (const [index, message] of preview.entries()) {
			const rows = wrapQueueText(message, Math.max(12, safeWidth - 6));
			const [first = "(empty prompt)", ...rest] = rows;
			lines.push(`${theme.fg("muted", `${index + 1}. `)}${first}`);
			for (const row of rest) lines.push(`${theme.fg("muted", "   ")}${theme.fg("dim", row)}`);
		}

		const hidden = messages.length - preview.length;
		if (hidden > 0) lines.push(theme.fg("dim", `+${hidden} more`));
		lines.push(`${theme.fg("accent", "alt+↑")}${theme.fg("dim", " edit last queued message")}`);
		lines.push(theme.fg("dim", "─".repeat(Math.max(1, safeWidth))));

		return lines.map((line) => (visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "")));
	}
}

function wrapQueueText(value: string, width: number): string[] {
	const text = value.trim() || "(attachments only)";
	const rows: string[] = [];
	for (const source of text.split(/\r\n|\r|\n/u)) {
		if (source.length === 0) {
			rows.push("");
			continue;
		}
		let rest = source;
		while (visibleWidth(rest) > width) {
			const part = truncateToWidth(rest, width, "", false);
			if (part.length === 0) break;
			rows.push(part);
			rest = rest.slice(part.length);
		}
		rows.push(rest);
	}
	if (rows.length <= MAX_PREVIEW_LINES) return rows;
	const last = rows[MAX_PREVIEW_LINES - 1] ?? "";
	return [...rows.slice(0, MAX_PREVIEW_LINES - 1), `${truncateToWidth(last, Math.max(1, width - 1), "", false)}…`];
}
