import { describe, expect, it } from "vitest";
import type {
	SessionIndex,
	SessionIndexHitBatch,
	SessionIndexQuery,
	SessionListQuery,
} from "../../src/core/session-index/types.ts";
import {
	createSessionSearchService,
	parseSearchQueryParams,
	parseSessionListParams,
	SessionSearchRequestError,
} from "../../src/server/session-search-service.ts";

function fakeIndex(calls: { search: SessionIndexQuery[]; list: SessionListQuery[] }): SessionIndex {
	return {
		async *search(query) {
			calls.search.push(query);
			yield { hits: [], coverage: { indexed: 1, total: 2 } } satisfies SessionIndexHitBatch;
		},
		async listSessions(query) {
			calls.list.push(query);
			return {
				sessions: [
					{
						path: "/s/a.jsonl",
						id: "a",
						cwd: "/work",
						created: new Date(1000),
						modified: new Date(2000),
						messageCount: 1,
						firstMessage: "hi",
					},
				],
				nextCursor: "next",
			};
		},
		status: async () => ({ state: "ready", indexed: 1, total: 1, pending: 0, errors: 0 }),
		notifyPersisted() {},
		addRoot: async () => {},
		async *reindex() {},
		close: async () => {},
	};
}

async function all(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
	const items: unknown[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

describe("session search service params", () => {
	it("applies defaults and normalises cwd", () => {
		expect(parseSearchQueryParams({ q: "migration", cwd: "/work/app/../app" })).toEqual({
			text: "migration",
			limit: 20,
			cwd: "/work/app",
		});
		expect(parseSessionListParams(undefined)).toEqual({ limit: 50 });
	});

	it.each([
		[{}, /q must/u],
		[{ q: "  " }, /q must/u],
		[{ q: "x".repeat(501) }, /at most 500/u],
		[{ q: "x", limit: 0 }, /limit/u],
		[{ q: "x", limit: 101 }, /limit/u],
		[{ q: "x", cwd: "relative" }, /absolute/u],
		[{ q: "x", since: -1 }, /since/u],
		[{ q: "x", entryTypes: ["session"] }, /entryTypes/u],
		["text", /object/u],
	])("rejects invalid search params %#", (params, message) => {
		expect(() => parseSearchQueryParams(params)).toThrow(message);
	});

	it("rejects an empty cursor and an oversized list limit", () => {
		expect(() => parseSessionListParams({ cursor: "" })).toThrow(SessionSearchRequestError);
		expect(() => parseSessionListParams({ limit: 201 })).toThrow(/limit/u);
	});
});

describe("createSessionSearchService", () => {
	it("dispatches methods and returns JSON-safe results", async () => {
		const calls = { search: [] as SessionIndexQuery[], list: [] as SessionListQuery[] };
		const service = createSessionSearchService(fakeIndex(calls));

		const batches = await all(service.call("search.query", { q: "abc", entryTypes: ["message"], limit: 5 }));
		expect(batches).toEqual([{ hits: [], coverage: { indexed: 1, total: 2 } }]);
		expect(calls.search).toEqual([{ text: "abc", limit: 5, entryTypes: ["message"] }]);

		const [page] = await all(service.call("sessions.list", { cwd: "/work", cursor: "c1" }));
		expect(JSON.parse(JSON.stringify(page))).toEqual({
			sessions: [
				{
					path: "/s/a.jsonl",
					id: "a",
					cwd: "/work",
					created: 1000,
					modified: 2000,
					messageCount: 1,
					firstMessage: "hi",
				},
			],
			nextCursor: "next",
		});
		expect(calls.list).toEqual([{ limit: 50, cwd: "/work", cursor: "c1" }]);

		expect(await all(service.call("index.status", undefined))).toEqual([
			{ state: "ready", indexed: 1, total: 1, pending: 0, errors: 0 },
		]);
	});

	it("rejects unknown methods and bad params before touching the index", async () => {
		const calls = { search: [] as SessionIndexQuery[], list: [] as SessionListQuery[] };
		const service = createSessionSearchService(fakeIndex(calls));
		await expect(all(service.call("sessions.delete", {}))).rejects.toMatchObject({ code: "unknown_method" });
		await expect(all(service.call("search.query", { q: "" }))).rejects.toMatchObject({ code: "invalid_params" });
		expect(() => service.searchQuery({ limit: 1 })).toThrow(SessionSearchRequestError);
		expect(calls.search).toHaveLength(0);
	});
});
