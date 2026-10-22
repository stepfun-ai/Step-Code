import { describe, expect, it } from "vitest";
import { RoomBindingStore } from "../src/features/step-room/index.ts";

describe("room binding table", () => {
	it("routes a bound chat to its session", () => {
		const store = new RoomBindingStore();
		store.bind("oc_a", "session-1");
		expect(store.resolve("oc_a")).toEqual({
			action: "deliver",
			delivery: { chatId: "oc_a", sessionId: "session-1" },
		});
	});

	it("drops an unbound chat and counts it without delivering", () => {
		const store = new RoomBindingStore();
		expect(store.resolve("oc_stranger")).toEqual({ action: "drop", reason: "unbound" });
		store.resolve("oc_stranger");
		expect(store.dropCounts()).toEqual([{ chatId: "oc_stranger", count: 2 }]);
		expect(store.chatsFor("session-1")).toEqual([]);
	});

	it("refuses to rebind a chat to another session", () => {
		const store = new RoomBindingStore();
		store.bind("oc_a", "session-1");
		expect(() => store.bind("oc_a", "session-2")).toThrow("chat already bound to another session");
		expect(store.sessionFor("oc_a")).toBe("session-1");
	});

	it("treats rebinding the same session as a no-op", () => {
		const store = new RoomBindingStore();
		store.bind("oc_a", "session-1");
		expect(() => store.bind("oc_a", "session-1")).not.toThrow();
		expect(store.chatsFor("session-1")).toEqual(["oc_a"]);
	});

	it("enforces the phase-one one-chat-per-session limit", () => {
		const store = new RoomBindingStore();
		store.bind("oc_a", "session-1");
		expect(() => store.bind("oc_b", "session-1")).toThrow("session chat limit reached");
	});

	it("allows several chats per session once the limit is raised", () => {
		const store = new RoomBindingStore({ maxChatsPerSession: 2 });
		store.bind("oc_a", "session-1");
		store.bind("oc_b", "session-1");
		expect([...store.chatsFor("session-1")].sort()).toEqual(["oc_a", "oc_b"]);
		expect(store.resolve("oc_b")).toEqual({
			action: "deliver",
			delivery: { chatId: "oc_b", sessionId: "session-1" },
		});
	});

	it("unbinds a chat and forgets an empty session", () => {
		const store = new RoomBindingStore();
		store.bind("oc_a", "session-1");
		expect(store.unbind("oc_a")).toBe(true);
		expect(store.unbind("oc_a")).toBe(false);
		expect(store.sessionFor("oc_a")).toBeUndefined();
		expect(store.chatsFor("session-1")).toEqual([]);
		expect(store.resolve("oc_a")).toEqual({ action: "drop", reason: "unbound" });
	});

	it("rejects invalid configuration instead of guessing", () => {
		expect(() => new RoomBindingStore({ maxChatsPerSession: 0 })).toThrow("positive integer");
		const store = new RoomBindingStore();
		expect(() => store.bind("", "session-1")).toThrow("required");
	});

	it("restores bindings from persisted state", () => {
		const store = new RoomBindingStore({ bindings: [{ chatId: "oc_a", sessionId: "session-1" }] });
		expect(store.sessionFor("oc_a")).toBe("session-1");
	});
});
