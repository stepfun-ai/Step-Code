import { describe, expect, it } from "vitest";
import { RoomSequencer } from "../src/features/step-room/index.ts";

const T0 = 1_700_000_000_000;

function event(id: string, createdAt: number) {
	return { id, createdAt };
}

describe("room event sequencing", () => {
	it("emits in create-time order even when delivery is reversed", () => {
		const sequencer = new RoomSequencer({ holdMs: 100 });
		expect(sequencer.accept(event("b", T0 + 20), 0)).toEqual({ action: "hold", id: "b" });
		expect(sequencer.accept(event("a", T0 + 10), 0)).toEqual({ action: "hold", id: "a" });
		// The older of two queued events is safe to release; the newest keeps its hold window.
		expect(sequencer.drain(0).map((step) => (step.action === "emit" ? step.event.id : step.action))).toEqual(["a"]);
		expect(sequencer.drain(100).map((step) => (step.action === "emit" ? step.event.id : step.action))).toEqual(["b"]);
	});

	it("holds a lone event until its window elapses", () => {
		const sequencer = new RoomSequencer({ holdMs: 100 });
		sequencer.accept(event("a", T0), 0);
		expect(sequencer.drain(99)).toEqual([]);
		expect(sequencer.pendingCount()).toBe(1);
		const steps = sequencer.drain(100);
		expect(steps).toHaveLength(1);
	});

	it("drops duplicate deliveries by message id", () => {
		const sequencer = new RoomSequencer({ holdMs: 100 });
		sequencer.accept(event("a", T0), 0);
		sequencer.drain(100);
		expect(sequencer.accept(event("a", T0), 200)).toEqual({ action: "duplicate", id: "a" });
	});

	it("refuses a duplicate that is still pending", () => {
		const sequencer = new RoomSequencer({ holdMs: 100 });
		sequencer.accept(event("a", T0), 0);
		expect(sequencer.accept(event("a", T0 + 1), 0)).toEqual({ action: "hold", id: "a" });
		expect(sequencer.pendingCount()).toBe(1);
	});

	it("reports a gap when a hole exceeds the threshold", () => {
		const sequencer = new RoomSequencer({ holdMs: 100, gapMs: 500 });
		sequencer.accept(event("a", T0), 0);
		sequencer.drain(100);
		sequencer.accept(event("c", T0 + 5_000), 200);
		const [step] = sequencer.drain(300);
		expect(step.action).toBe("emit");
		if (step.action !== "emit") throw new Error("expected emit");
		expect(step.gaps).toEqual([{ after: T0, before: T0 + 5_000 }]);
	});

	it("reports no gap for a normal cadence", () => {
		const sequencer = new RoomSequencer({ holdMs: 100, gapMs: 500 });
		sequencer.accept(event("a", T0), 0);
		sequencer.drain(100);
		sequencer.accept(event("b", T0 + 400), 200);
		const [step] = sequencer.drain(300);
		if (step.action !== "emit") throw new Error("expected emit");
		expect(step.gaps).toEqual([]);
	});

	it("emits a late straggler without reordering earlier output", () => {
		const sequencer = new RoomSequencer({ holdMs: 100 });
		sequencer.accept(event("b", T0 + 100), 0);
		sequencer.drain(100);
		const step = sequencer.accept(event("a", T0 + 50), 200);
		expect(step.action).toBe("emit");
	});

	it("flushes pending events on shutdown", () => {
		const sequencer = new RoomSequencer({ holdMs: 10_000 });
		sequencer.accept(event("a", T0), 0);
		expect(sequencer.flush()).toHaveLength(1);
		expect(sequencer.pendingCount()).toBe(0);
	});

	it("rejects an event without an id or usable timestamp", () => {
		const sequencer = new RoomSequencer();
		expect(() => sequencer.accept({ id: "", createdAt: T0 })).toThrow("needs an id and create time");
		expect(() => sequencer.accept({ id: "a", createdAt: Number.NaN })).toThrow("needs an id and create time");
	});

	it("bounds retained ids so a long session cannot grow without limit", () => {
		const sequencer = new RoomSequencer({ holdMs: 0, maxSeen: 2 });
		for (let index = 0; index < 5; index++) {
			sequencer.accept(event(`m${index}`, T0 + index), 0);
			sequencer.drain(0);
		}
		// The oldest id was evicted, so a redelivery of it is accepted again rather than ballooning memory.
		expect(sequencer.accept(event("m0", T0 + 10), 0).action).toBe("hold");
		expect(sequencer.accept(event("m4", T0 + 10), 0).action).toBe("duplicate");
	});
});
