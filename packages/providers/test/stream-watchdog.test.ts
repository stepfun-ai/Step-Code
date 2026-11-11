import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { withStreamIdleWatchdog } from "../src/utils/stream-watchdog.ts";

function shell(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stream idle watchdog", () => {
	it("ends a stalled stream with a retryable error and cancels the request", async () => {
		const source = createAssistantMessageEventStream();
		let cancelled = 0;
		const watched = withStreamIdleWatchdog(source, {
			idleTimeoutMs: 30,
			onTimeout: () => cancelled++,
			fallback: shell,
		});
		const partial = { ...shell(), content: [{ type: "thinking" as const, thinking: "only a little" }] };
		source.push({ type: "start", partial });
		source.push({ type: "thinking_delta", contentIndex: 0, delta: "only a little", partial });
		// No further events: a gateway that keeps the socket alive with pings looks like this.

		const result = await watched.result();
		expect(cancelled).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/stream idle timeout/);
		expect(result.content).toEqual(partial.content);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("uses the fallback shell when no event ever arrives", async () => {
		const watched = withStreamIdleWatchdog(createAssistantMessageEventStream(), {
			idleTimeoutMs: 20,
			onTimeout: () => {},
			fallback: shell,
		});
		const result = await watched.result();
		expect(result).toMatchObject({ provider: "faux", stopReason: "error", errorKind: "transient", content: [] });
	});

	it("does not interrupt a slow stream that keeps making progress", async () => {
		const source = createAssistantMessageEventStream();
		let cancelled = 0;
		const watched = withStreamIdleWatchdog(source, {
			idleTimeoutMs: 60,
			onTimeout: () => cancelled++,
			fallback: shell,
		});
		const events: string[] = [];
		const consume = (async () => {
			for await (const event of watched) events.push(event.type);
		})();
		const partial = shell();
		source.push({ type: "start", partial });
		for (let i = 0; i < 4; i++) {
			await sleep(30);
			source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
		}
		source.push({ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text: "xxxx" }] } });
		await consume;
		expect(cancelled).toBe(0);
		expect(events.at(-1)).toBe("done");
		expect((await watched.result()).stopReason).toBe("stop");
	});

	it("passes a provider abort through unchanged", async () => {
		const source = createAssistantMessageEventStream();
		const watched = withStreamIdleWatchdog(source, { idleTimeoutMs: 1_000, onTimeout: () => {}, fallback: shell });
		source.push({ type: "error", reason: "aborted", error: { ...shell(), stopReason: "aborted" } });
		expect((await watched.result()).stopReason).toBe("aborted");
	});

	it("returns the source unchanged when disabled", () => {
		const source = createAssistantMessageEventStream();
		expect(withStreamIdleWatchdog(source, { idleTimeoutMs: 0, onTimeout: () => {}, fallback: shell })).toBe(source);
	});
});
