import type { AgentMessage } from "@step-harness/agent-core";

/** Keeps request-only notices at their original boundary during append-only turns. */
export class StableContextNotices {
	private previous: string[] = [];
	private notices: { index: number; message: AgentMessage }[] = [];

	project(messages: AgentMessage[], added: AgentMessage[]): AgentMessage[] {
		const fingerprints = messages.map((message) => JSON.stringify(message));
		// A branch switch, compaction or edited projection starts a new context epoch.
		// Never replay notices belonging to a different history into that epoch.
		if (this.previous.some((value, index) => fingerprints[index] !== value)) {
			this.notices = [];
		}
		this.previous = fingerprints;
		for (const message of added) this.notices.push({ index: messages.length, message });
		if (this.notices.length === 0) return messages;

		const result: AgentMessage[] = [];
		let start = 0;
		for (const notice of this.notices) {
			result.push(...messages.slice(start, notice.index), notice.message);
			start = notice.index;
		}
		result.push(...messages.slice(start));
		return result;
	}
}
