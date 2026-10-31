import { afterEach, expect, test, vi } from "vitest";
import { ClientTerminalRegistry, envRecordToPairs, UnknownTerminalError } from "../src/modes/acp/client-terminal.ts";

type Recorded = { method: string; params: Record<string, unknown> };

function fakeClient(responder: (method: string, params: Record<string, unknown>) => unknown = () => ({})) {
	const calls: Recorded[] = [];
	const request = vi.fn(async (method: string, params: unknown) => {
		const record = { method, params: params as Record<string, unknown> };
		calls.push(record);
		return responder(method, record.params);
	});
	return { calls, request };
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("create forwards the request and records the terminal", async () => {
	const client = fakeClient(() => ({ terminalId: "term-7" }));
	const registry = new ClientTerminalRegistry(client.request, () => "sess-1");

	const record = await registry.create({ command: "npm", args: ["test"], cwd: "/repo" });

	expect(record.terminalId).toBe("term-7");
	expect(record.sessionId).toBe("sess-1");
	expect(client.calls).toEqual([
		{ method: "terminal/create", params: { command: "npm", args: ["test"], cwd: "/repo", sessionId: "sess-1" } },
	]);
	expect(registry.size).toBe(1);
});

test("a client that returns no terminal id is an error, not a silent no-op", async () => {
	const client = fakeClient(() => ({}));
	const registry = new ClientTerminalRegistry(client.request, () => "sess-1");

	await expect(registry.create({ command: "npm" })).rejects.toThrow("no terminalId");
	expect(registry.size).toBe(0);
});

test("output, wait, kill and release all forward the terminal id", async () => {
	const client = fakeClient(() => ({ terminalId: "term-1" }));
	const registry = new ClientTerminalRegistry(client.request, () => "sess-1");
	await registry.create({ command: "npm" });

	await registry.output("term-1");
	await registry.waitForExit("term-1");
	await registry.kill("term-1");
	client.calls.length = 0;
	await registry.release("term-1");

	expect(client.calls.map((call) => call.method)).toEqual(["terminal/release"]);
	expect(client.calls[0]?.params).toEqual({ sessionId: "sess-1", terminalId: "term-1" });
	// Released means forgotten, so a second release is an unknown id.
	expect(registry.size).toBe(0);
});

test("an unknown terminal id is rejected before any request is sent", async () => {
	const client = fakeClient();
	const registry = new ClientTerminalRegistry(client.request, () => "sess-1");

	await expect(registry.output("nope")).rejects.toBeInstanceOf(UnknownTerminalError);
	await expect(registry.kill("nope")).rejects.toBeInstanceOf(UnknownTerminalError);
	expect(client.calls).toHaveLength(0);
});

test("a terminal cannot be used after the session moved on", async () => {
	const client = fakeClient(() => ({ terminalId: "term-1" }));
	let sessionId = "sess-1";
	const registry = new ClientTerminalRegistry(client.request, () => sessionId);
	await registry.create({ command: "npm" });

	sessionId = "sess-2";
	client.calls.length = 0;

	await expect(registry.output("term-1")).rejects.toBeInstanceOf(UnknownTerminalError);
	expect(client.calls).toHaveLength(0);
});

test("releaseAll clears every terminal and swallows failures", async () => {
	let failNext = true;
	const client = fakeClient((method) => {
		if (method === "terminal/create") return { terminalId: `term-${Math.random()}` };
		if (method === "terminal/release" && failNext) {
			failNext = false;
			throw new Error("client gone");
		}
		return {};
	});
	const registry = new ClientTerminalRegistry(client.request, () => "sess-1");
	await registry.create({ command: "a" });
	await registry.create({ command: "b" });

	// Runs on the way out, where there is nobody left to report a failure to.
	await expect(registry.releaseAll()).resolves.toBeUndefined();
	expect(registry.size).toBe(0);
	const releases = client.calls.filter((call) => call.method === "terminal/release");
	expect(releases).toHaveLength(2);
});

test("env record to pairs drops nothing and keeps order", () => {
	expect(envRecordToPairs({ A: "1", B: "2" })).toEqual([
		{ name: "A", value: "1" },
		{ name: "B", value: "2" },
	]);
	expect(envRecordToPairs({})).toEqual([]);
});
