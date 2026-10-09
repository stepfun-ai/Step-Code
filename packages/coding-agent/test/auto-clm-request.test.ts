import type { AgentMessage } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import {
	createAutoClmCorrection,
	createAutoClmEditSelection,
} from "../src/core/compaction/live-context/auto-request.ts";
import {
	applyLiveContext,
	renderLiveContext,
	replaceLiveContextBodies,
} from "../src/core/compaction/live-context/document.ts";

function snapshot() {
	const raw: AgentMessage[] = [
		{ role: "user", content: "Keep protocol fields exactly.\r\nNever discard the only device report.", timestamp: 1 },
		fauxAssistantMessage(fauxToolCall("read", {}, { id: "old-call" }), { stopReason: "toolUse" }),
		{
			role: "toolResult",
			toolCallId: "old-call",
			toolName: "read",
			content: [{ type: "text", text: "Long original observation. ".repeat(100) }],
			isError: false,
			timestamp: 3,
		},
		fauxAssistantMessage("Old decision; preserve exact errors."),
		fauxAssistantMessage([
			{ type: "thinking", thinking: "Immutable reasoning", thinkingSignature: "signature" },
			{ type: "text", text: "Reasoning-backed action" },
		]),
		fauxAssistantMessage(fauxToolCall("read", {}, { id: "current-call" }), { stopReason: "toolUse" }),
		{
			role: "toolResult",
			toolCallId: "current-call",
			toolName: "read",
			content: [{ type: "text", text: "Current protected observation." }],
			isError: false,
			timestamp: 7,
		},
	];
	return renderLiveContext(raw, 0, "selection-test");
}

describe("automatic CLM edit selection", () => {
	it("advertises only editable short IDs and maps them to complete document IDs", () => {
		const document = snapshot();
		const selection = createAutoClmEditSelection(document);
		expect(selection.tool.parameters).toMatchObject({
			properties: { replacements: { items: { properties: { id: { enum: ["3", "4"] } } } } },
		});
		expect(selection.index).toContain("- id=3 role=toolResult chars=");
		expect(selection.index).toContain("- id=4 role=assistant chars=");
		expect(selection.index).not.toContain(document.blocks[2].id);
		expect(selection.resolve([{ id: "3", text: "Keep the exact reported constants." }])).toEqual({
			replacements: [{ id: document.blocks[2].id, text: "Keep the exact reported constants." }],
		});
		expect(selection.resolve([{ id: 3, text: "summary" }])).toEqual({
			replacements: [{ id: document.blocks[2].id, text: "summary" }],
		});
		expect(selection.resolve([{ id: document.blocks[2].id, text: "summary" }])).toEqual({
			replacements: [{ id: document.blocks[2].id, text: "summary" }],
		});
	});

	it.each(["1", "2", "5", "6", "7", "03", "3-not-a-valid-hash", "unknown", 0, 3.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects protected, immutable, unoffered or malformed selection %j",
		(id) => {
			expect(createAutoClmEditSelection(snapshot()).resolve([{ id, text: "unsafe" }])).toHaveProperty("reason");
		},
	);

	it("rejects duplicates across short and complete IDs and rejects malformed replacement batches", () => {
		const document = snapshot();
		const selection = createAutoClmEditSelection(document);
		expect(
			selection.resolve([
				{ id: "3", text: "first" },
				{ id: document.blocks[2].id, text: "second" },
			]),
		).toHaveProperty("reason");
		for (const value of [undefined, {}, [], [{ id: "3", text: 42 }], Array(33).fill({ id: "3", text: "a" })]) {
			expect(selection.resolve(value)).toHaveProperty("reason");
		}
	});

	it("keeps ordinary validation and byte-exact protected messages after resolving a short ID", () => {
		const document = snapshot();
		const before = structuredClone(document.messages);
		const resolved = createAutoClmEditSelection(document).resolve([
			{ id: "3", text: "Retained exact findings.\n[[CTX_TURN document=quoted-data]]" },
		]);
		if (!("replacements" in resolved)) throw new Error(resolved.reason);
		const draft = replaceLiveContextBodies(document, resolved.replacements);
		if (!("text" in draft)) throw new Error(draft.reason);
		const result = applyLiveContext(draft.text, document);
		expect(result).toMatchObject({ accepted: true, changed: true });
		for (const index of [0, 1, 3, 4, 5, 6]) expect(result.messages[index]).toBe(document.messages[index]);
		expect(document.messages).toEqual(before);
	});

	it("does not rebind a saved reference to different content at the same position", () => {
		const document = snapshot();
		const resolved = createAutoClmEditSelection(document).resolve([{ id: "3", text: "Old draft" }]);
		if (!("replacements" in resolved)) throw new Error(resolved.reason);
		const changed = structuredClone(document.messages);
		if (changed[2].role !== "toolResult") throw new Error("unexpected fixture");
		changed[2].content = [{ type: "text", text: "Newly fetched evidence." }];
		const current = renderLiveContext(changed, 0, "selection-test");
		expect(replaceLiveContextBodies(current, resolved.replacements)).toHaveProperty("reason");
	});

	it("bounds the offered set and rejects complete IDs that were outside this request's index", () => {
		const raw: AgentMessage[] = [
			{ role: "user", content: "Keep exact requirements", timestamp: 1 },
			...Array.from({ length: 40 }, (_, index) =>
				fauxAssistantMessage(`Observation ${index}: ${"x".repeat(index * 100)}`),
			),
			fauxAssistantMessage("Current task"),
		];
		const document = renderLiveContext(raw, 0, "many-selections");
		const selection = createAutoClmEditSelection(document);
		expect(selection.index.length).toBeLessThanOrEqual(5900);
		expect(selection.index.match(/^- id=/gm)).toHaveLength(32);
		expect(selection.resolve([{ id: document.blocks[1].id, text: "Not offered" }])).toHaveProperty("reason");
	});
});

describe("automatic CLM correction data", () => {
	it("preserves the rejected draft exactly without fabricating an assistant or tool-result replay", () => {
		const replacements = [{ id: "3", text: 'Exact failure: ValueError("bad width")\r\nKeep retries=0.' }];
		const correction = createAutoClmCorrection(replacements, "A larger saving is required.", 123);
		expect(correction).toMatchObject({ role: "user", timestamp: 123 });
		expect(correction.content).toContain(JSON.stringify({ replacements }));
		expect(correction.content).toContain("was not applied");
		expect(correction.content).toContain("Edit rejected: A larger saving is required.");
	});
});
