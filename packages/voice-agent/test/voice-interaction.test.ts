import type { AgentEventListener, AgentSessionHandle, Unsubscribe } from "@step-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { createVoiceInteraction } from "../src/index.ts";

/** In-memory host session handle — voice attaches to this, it never creates one. */
function fakeSession(): AgentSessionHandle {
	const listeners = new Set<AgentEventListener>();
	return {
		sessionId: "test-session",
		send: async () => {},
		steer: async () => {},
		interrupt: async () => {},
		subscribe(listener): Unsubscribe {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close: async () => {},
	};
}

describe("voice interaction (S6-3 mock acceptance)", () => {
	it("has the voice id and a compile-time toolCall:false policy", () => {
		const voice = createVoiceInteraction();
		expect(voice.id).toBe("voice");
		expect(voice.modelPolicy.toolCall).toBe(false);
	});

	it("attaches to an existing session (never creates one) and stop() resolves + unsubscribes", async () => {
		const session = fakeSession();
		const subscribeSpy = vi.spyOn(session, "subscribe");
		const voice = createVoiceInteraction();

		const handle = await voice.attach(session);
		expect(subscribeSpy).toHaveBeenCalledTimes(1);

		await expect(handle.stop()).resolves.toBeUndefined();
	});
});
