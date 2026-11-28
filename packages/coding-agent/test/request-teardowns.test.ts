import { describe, expect, it } from "vitest";
import { RequestTeardowns } from "../src/core/request-teardowns.ts";

describe("request teardowns", () => {
	it("returns at once when nothing is registered", async () => {
		const teardowns = new RequestTeardowns();
		const started = performance.now();
		await teardowns.settle(5_000);
		expect(performance.now() - started).toBeLessThan(20);
	});

	it("waits for registered work", async () => {
		const teardowns = new RequestTeardowns();
		let done = false;
		teardowns.register(
			new Promise<void>((resolve) =>
				setTimeout(() => {
					done = true;
					resolve();
				}, 30),
			),
		);
		await teardowns.settle(5_000);
		expect(done).toBe(true);
	});

	it("gives up on hanging work at the limit, and a rejection is not an error", async () => {
		const teardowns = new RequestTeardowns();
		teardowns.register(new Promise(() => {}));
		teardowns.register(Promise.reject(new Error("unreachable")));
		const started = performance.now();
		await teardowns.settle(100);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(90);
		expect(elapsed).toBeLessThan(1_000);
	});

	it("forgets work once it settles", async () => {
		const teardowns = new RequestTeardowns();
		teardowns.register(Promise.resolve());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const started = performance.now();
		await teardowns.settle(5_000);
		expect(performance.now() - started).toBeLessThan(20);
	});
});
