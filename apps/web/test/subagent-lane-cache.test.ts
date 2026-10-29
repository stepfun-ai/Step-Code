import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { SubagentLaneSnapshot } from "@step-harness/coding-agent";
import { retainSubagentLane } from "../src/subagent-lane-cache.ts";

function snapshot(laneId: string, status: SubagentLaneSnapshot["status"], updatedAt: number): SubagentLaneSnapshot {
	return { laneId, status, details: { mode: "single", agentScope: "user", userAgentsDir: "/fixture", projectAgentsDir: null, agentId: laneId, results: [], updatedAt } };
}

test("cache keeps running lanes and the most recently finished outcomes, not insertion order", () => {
	const cache = new Map<string, SubagentLaneSnapshot>();
	retainSubagentLane(cache, snapshot("long-running", "running", 1));
	for (let index = 0; index < 18; index++) retainSubagentLane(cache, snapshot(`short-${index}`, "completed", 10 + index));
	assert.ok(cache.has("long-running"));
	assert.equal(cache.size, 17);
	retainSubagentLane(cache, snapshot("long-running", "completed", 100));
	assert.ok(cache.has("long-running"));
	assert.equal(cache.size, 16);
	assert.ok(!cache.has("short-2"));
});

test("OpenAPI publishes lane frames, reconnect state and durable completed-response fields", async () => {
	// The fixture is the repository's published document; only its relevant schema paths are inspected.
	const document = parse(await readFile(new URL("../openapi.yaml", import.meta.url), "utf8")) as {
		components: { schemas: Record<string, unknown> };
		paths: Record<string, { get: { responses: Record<string, { description: string; content?: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }>;
	};
	assert.ok(document.components.schemas.SubagentLaneSnapshot);
	assert.ok(document.components.schemas.CompletedSubagentResponse);
	assert.match(document.paths["/api/v1/sessions/{id}/events"].get.responses["200"].description, /subagent_lane/);
	assert.ok(document.paths["/api/v1/sessions/{id}"].get.responses["200"].content?.["application/json"].schema.properties.subagentLanes);
});
