import type { AgentMessage } from "@step-harness/agent-core";
import { describe, expect, it } from "vitest";
import { StableContextNotices } from "../src/core/compaction/live-context/stable-notices.ts";

const user = (content: string, timestamp = 1): AgentMessage => ({ role: "user", content, timestamp });
const notice = (content: string): AgentMessage => ({
	role: "custom",
	customType: "live-context-status",
	display: false,
	content,
	timestamp: 123,
});

describe("stable request context notices", () => {
	it("retains a one-shot notice before the newly appended conversation", () => {
		const state = new StableContextNotices();
		const raw = [user("read A")];
		const notification = notice("pressure");
		const first = state.project(raw, [notification]);
		const next = state.project([...raw, user("continue", 2)], []);
		expect(next.slice(0, first.length)).toEqual(first);
		expect(next).toEqual([...raw, notification, user("continue", 2)]);
		expect(raw).toEqual([user("read A")]);
	});

	it("keeps multiple notifications in order and does not duplicate them on retries", () => {
		const state = new StableContextNotices();
		const raw = [user("read A")];
		const a = notice("accepted");
		const b = notice("pressure");
		const first = state.project(raw, [a, b]);
		expect(state.project(structuredClone(raw), [])).toEqual(first);
		const extended = [...raw, user("continue", 2)];
		const c = notice("another tier");
		const second = state.project(extended, [c]);
		expect(second).toEqual([...raw, a, b, extended[1], c]);
		expect(state.project(extended, [])).toEqual(second);
	});

	it.each(["edit", "shrink", "branch"])("drops stale notices on a %s context change", (change) => {
		const state = new StableContextNotices();
		const raw = [user("old"), user("tail", 2)];
		state.project(raw, [notice("old pressure")]);
		const changed = change === "shrink" ? raw.slice(0, 1) : [user(change), raw[1]];
		const fresh = notice("new epoch");
		expect(state.project(changed, [fresh])).toEqual([...changed, fresh]);
		expect(state.project([...changed, user("continue", 3)], [])).toEqual([...changed, fresh, user("continue", 3)]);
	});

	it("returns the original view when no notification has been issued", () => {
		const raw = [user("continue")];
		expect(new StableContextNotices().project(raw, [])).toBe(raw);
	});
});
