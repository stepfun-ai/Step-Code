import { setKeybindings } from "@step-harness/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import type { SessionInfo } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { SessionSelectorComponent } from "../src/ui/view/dialogs/session-selector.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(id: string, firstMessage: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

describe("session selector child-agent filtering", () => {
	const keybindings = new KeybindingsManager();

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		initTheme("dark");
	});

	function createSelector(current: SessionInfo[], all: SessionInfo[]): SessionSelectorComponent {
		return new SessionSelectorComponent(
			async () => current,
			async () => all,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
	}

	it("hides subagent child sessions from the current-folder list", async () => {
		const selector = createSelector(
			[
				makeSession("subagent-1111-2222", "delegated task"),
				makeSession("11112222-3333-4444-5555-666677778888", "my own session"),
			],
			[],
		);
		await flushPromises();

		const rendered = stripAnsi(selector.getSessionList().render(120).join("\n"));
		expect(rendered).toContain("my own session");
		expect(rendered).not.toContain("delegated task");
	});

	it("hides workflow agent sessions from the current-folder list", async () => {
		const selector = createSelector(
			[makeSession("workflow-wf_abc123-wf_abc123-2", "workflow agent task"), makeSession("plain", "my own session")],
			[],
		);
		await flushPromises();

		const rendered = stripAnsi(selector.getSessionList().render(120).join("\n"));
		expect(rendered).toContain("my own session");
		expect(rendered).not.toContain("workflow agent task");
	});

	it("hides child agent sessions from the all-folders list", async () => {
		const selector = createSelector([], [makeSession("subagent-abcd-0", "parallel lane"), makeSession("plain", "kept")]);
		await flushPromises();

		selector.getSessionList().handleInput("\t");
		await flushPromises();

		const rendered = stripAnsi(selector.getSessionList().render(120).join("\n"));
		expect(rendered).toContain("kept");
		expect(rendered).not.toContain("parallel lane");
	});
});
