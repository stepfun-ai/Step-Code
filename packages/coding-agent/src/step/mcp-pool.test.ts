import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepMcpPool, type StepMcpPoolAdapter, type StepMcpPoolConnection } from "./mcp-pool.ts";

interface FakeItem {
	name: string;
	fail?: boolean;
}

interface FakeConnection extends StepMcpPoolConnection {
	readonly name: string;
	readonly closed: AbortController;
	notify(): void;
}

function tool(name: string): McpTool {
	return { name, inputSchema: { type: "object" } };
}

function createAdapter() {
	const connections: FakeConnection[] = [];
	let catalog = [tool("a")];
	const adapter: StepMcpPoolAdapter<FakeItem, FakeConnection> & {
		connections: FakeConnection[];
		setCatalog(tools: McpTool[]): void;
		connect: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		/** When set, connect waits for it before finishing the handshake. */
		gate?: Promise<void>;
	} = {
		connections,
		setCatalog: (tools) => {
			catalog = tools;
		},
		key: (item) => item.name,
		connect: vi.fn(async (item: FakeItem, _signal: AbortSignal, onToolsChanged: () => void) => {
			if (adapter.gate) await adapter.gate;
			if (item.fail) throw new Error(`${item.name} failed`);
			const closed = new AbortController();
			const connection: FakeConnection = {
				name: item.name,
				closed,
				signal: closed.signal,
				tools: [...catalog],
				notify: onToolsChanged,
			};
			connections.push(connection);
			return connection;
		}),
		listTools: async () => [...catalog],
		close: vi.fn(async (connection: FakeConnection) => {
			connection.closed.abort();
		}),
	};
	return adapter;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("StepMcpPool", () => {
	it("shares one connection between concurrent leases", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const first = pool.acquire({ name: "docs" });
		const second = pool.acquire({ name: "docs" });
		const [a, b] = await Promise.all([first.ready(), second.ready()]);
		expect(a).toBe(b);
		expect(adapter.connect).toHaveBeenCalledTimes(1);
		expect(pool.snapshot()).toEqual([{ key: "docs", leases: 2, connected: true }]);
		await pool.closeAll();
	});

	it("keeps an idle connection for the next lease and closes it after the grace", async () => {
		vi.useFakeTimers();
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter, { idleMs: 1_000 });
		const lease = pool.acquire({ name: "docs" });
		const connection = await lease.ready();
		await lease.release();
		expect(adapter.close).not.toHaveBeenCalled();

		const next = pool.acquire({ name: "docs" });
		expect(await next.ready()).toBe(connection);
		await next.release();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(adapter.close).toHaveBeenCalledTimes(1);
		expect(pool.size).toBe(0);
	});

	it("closes at once on an immediate release with no other holder", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const kept = pool.acquire({ name: "docs" });
		const dropped = pool.acquire({ name: "docs" });
		await kept.ready();
		await dropped.release({ immediate: true });
		expect(adapter.close).not.toHaveBeenCalled();
		await kept.release({ immediate: true });
		expect(adapter.close).toHaveBeenCalledTimes(1);
		expect(pool.size).toBe(0);
	});

	it("does not keep a failed start for the next session", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		await expect(pool.acquire({ name: "docs", fail: true }).ready()).rejects.toThrow("docs failed");
		expect(pool.size).toBe(0);
		await expect(pool.acquire({ name: "docs" }).ready()).resolves.toMatchObject({ name: "docs" });
		expect(adapter.connect).toHaveBeenCalledTimes(2);
		await pool.closeAll();
	});

	it("tells every holder about catalog changes and an unexpected close", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const changes: string[][] = [];
		const closes: string[] = [];
		const one = pool.acquire(
			{ name: "docs" },
			{ onToolsChanged: (tools) => changes.push(tools.map((t) => t.name)), onClosed: () => closes.push("one") },
		);
		pool.acquire(
			{ name: "docs" },
			{ onToolsChanged: (tools) => changes.push(tools.map((t) => t.name)), onClosed: () => closes.push("two") },
		);
		const connection = await one.ready();

		adapter.setCatalog([tool("a"), tool("b")]);
		connection.notify();
		await vi.waitFor(() =>
			expect(changes).toEqual([
				["a", "b"],
				["a", "b"],
			]),
		);

		connection.closed.abort();
		expect(closes).toEqual(["one", "two"]);
		expect(pool.size).toBe(0);
	});

	it("does not report a deliberate close to its holders", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const onClosed = vi.fn();
		const lease = pool.acquire({ name: "docs" }, { onClosed });
		await lease.ready();
		await pool.closeAll();
		expect(onClosed).not.toHaveBeenCalled();
	});

	it("aborting a wait does not cancel the shared connection", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const waiting = new AbortController();
		const lease = pool.acquire({ name: "docs" });
		waiting.abort(new Error("stop waiting"));
		await expect(lease.ready(waiting.signal)).rejects.toThrow("stop waiting");
		await expect(pool.acquire({ name: "docs" }).ready()).resolves.toMatchObject({ name: "docs" });
		expect(adapter.connect).toHaveBeenCalledTimes(1);
		await pool.closeAll();
	});

	it("closeAll during a handshake waits for that connection to close", async () => {
		const adapter = createAdapter();
		let finishHandshake: () => void = () => undefined;
		const handshake = new Promise<void>((resolve) => {
			finishHandshake = resolve;
		});
		adapter.gate = handshake;
		const pool = new StepMcpPool(adapter);
		const lease = pool.acquire({ name: "docs" });
		const closing = pool.closeAll();
		finishHandshake();
		await closing;
		await expect(lease.ready()).rejects.toThrow("MCP connection released");
		expect(adapter.close).toHaveBeenCalledTimes(1);
		expect(adapter.connections[0]?.signal.aborted).toBe(true);
	});

	it("closeIdle closes only connections without a lease", async () => {
		const adapter = createAdapter();
		const pool = new StepMcpPool(adapter);
		const idle = pool.acquire({ name: "idle" });
		const held = pool.acquire({ name: "held" });
		await Promise.all([idle.ready(), held.ready()]);
		await idle.release();
		await pool.closeIdle();
		expect(pool.snapshot()).toEqual([{ key: "held", leases: 1, connected: true }]);
		expect(adapter.close).toHaveBeenCalledTimes(1);
		await pool.closeAll();
	});
});
