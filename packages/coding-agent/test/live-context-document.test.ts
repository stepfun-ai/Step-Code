import type { AgentMessage } from "@step-harness/agent-core";
import type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, Usage } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import {
	applyLiveContext,
	digestMessages,
	isLiveContextNote,
	type LiveContextDocument,
	renderLiveContext,
	renderLiveContextIndex,
} from "../src/core/compaction/live-context/document.ts";
import type { CustomMessage } from "../src/core/messages.ts";

function usage(): Usage {
	return {
		input: 20,
		output: 10,
		cacheRead: 3,
		cacheWrite: 2,
		totalTokens: 35,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	};
}

function assistant(content: AssistantMessage["content"], timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		responseId: `response-${timestamp}`,
		usage: usage(),
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function call(id: string, name = "read"): ToolCall {
	return { type: "toolCall", id, name, arguments: { path: `${id}.ts` }, thoughtSignature: `signature-${id}` };
}

function result(id: string, text: string, timestamp = 3): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		isError: true,
		content: [{ type: "text", text, textSignature: `text-${id}` }],
		details: { path: `${id}.ts`, nested: { keep: true } },
		usage: usage(),
		addedToolNames: ["discovered-tool"],
		timestamp,
	};
}

function note(text: string, timestamp = 4): CustomMessage {
	return { role: "custom", customType: "live-context-note", display: false, content: text, timestamp };
}

function conversation(): AgentMessage[] {
	return [
		{ role: "user", content: "Fix the parser.", timestamp: 1 },
		assistant([{ type: "text", text: "Inspect both files." }, call("a"), call("b")]),
		// Parallel results may arrive in a different order from the calls.
		result("b", "Verbose output from b.", 3),
		result("a", "Verbose output from a.", 4),
		assistant([{ type: "text", text: "Old conclusion.", textSignature: "assistant-text-id" }], 5),
		{ role: "user", content: "Preserve the public API.", timestamp: 6 },
		{
			role: "custom",
			customType: "plan-mode-control",
			content: "Do not execute until approved.",
			display: false,
			details: { source: "policy", mode: "plan" },
			timestamp: 7,
		},
		{ role: "compactionSummary", summary: "Prior context.", tokensBefore: 1000, timestamp: 8 },
		{ role: "branchSummary", summary: "Other branch.", fromId: "branch-1", timestamp: 9 },
		note("An old working note.", 10),
		assistant([call("current")], 11),
		result("current", "The current tool result.", 12),
		note("A note following the current assistant.", 13),
		{ role: "user", content: "Now add a regression test.", timestamp: 14 },
	];
}

function snapshot(messages = conversation(), revision = 7, seed = "session-a"): LiveContextDocument {
	return renderLiveContext(messages, revision, seed);
}

function blockText(document: LiveContextDocument, index: number): string {
	const block = document.blocks[index];
	return `${block.header}\n${block.body}`;
}

/** Assemble edits through the public framing rather than an implementation parser. */
function editDocument(document: LiveContextDocument, blocks: string[]): string {
	const firstHeader = document.text.indexOf(document.blocks[0].header);
	return document.text.slice(0, firstHeader) + blocks.join("\n\n");
}

function replaceBody(document: LiveContextDocument, index: number, body: string): string {
	return editDocument(
		document,
		document.blocks.map((block, i) => (i === index ? `${block.header}\n${body}` : blockText(document, i))),
	);
}

function removeBlocks(document: LiveContextDocument, indexes: number[]): string {
	return editDocument(
		document,
		document.blocks.flatMap((_, i) => (indexes.includes(i) ? [] : [blockText(document, i)])),
	);
}

function newNote(document: LiveContextDocument, text: string, id = "new-summary", role = "notes"): string {
	return `[[CTX_TURN document=${document.documentId} index=0 role=${role} id=${id} protected=false]]\n${text}`;
}

function insertNote(document: LiveContextDocument, before: number, text = "Remember the invariant."): string {
	const blocks = document.blocks.map((_, i) => blockText(document, i));
	blocks.splice(before, 0, newNote(document, text));
	return editDocument(document, blocks);
}

function expectRejected(text: string, document: LiveContextDocument, reason: RegExp): void {
	const applied = applyLiveContext(text, document);
	expect(applied.accepted).toBe(false);
	expect(applied.changed).toBe(false);
	expect(applied.reason).toMatch(reason);
	expect(applied.diff).toBe("");
	expect(applied.messages).toEqual(document.messages);
	expect(applied.sourceIndexes).toEqual(document.messages.map((_, index) => index));
	for (const [index, message] of applied.messages.entries()) expect(message).toBe(document.messages[index]);
}

describe("live context snapshots", () => {
	it("round trips original message objects, content, signatures, usage, and control metadata", () => {
		const messages = conversation();
		const document = snapshot(messages);
		const before = structuredClone(messages);
		const applied = applyLiveContext(document.text, document);
		expect(applied).toMatchObject({ accepted: true, changed: false, diff: "" });
		expect(applied.messages).toEqual(before);
		expect(applied.sourceIndexes).toEqual(messages.map((_, index) => index));
		for (const [index, message] of applied.messages.entries()) expect(message).toBe(messages[index]);
		expect(messages).toEqual(before);
	});

	it("uses a deterministic nonce for the session and revision as messages arrive", () => {
		const first = snapshot();
		const grown = snapshot([...first.messages, { role: "user", content: "More context.", timestamp: 15 }]);
		expect(snapshot()).toEqual(first);
		expect(grown.documentId).toBe(first.documentId);
		expect(grown.blocks[0].header).toBe(first.blocks[0].header);
		expect(grown.baselineDigest).not.toBe(first.baselineDigest);
		expect(snapshot(first.messages, 8).documentId).not.toBe(first.documentId);
		expect(snapshot(first.messages, 7, "session-b").documentId).not.toBe(first.documentId);
		expect(first.text).toMatch(
			/^\[\[LIVE_CONTEXT version=1 revision=7 document=[a-f0-9]{64} baseline=[a-f0-9]{64}\]\]/,
		);
	});

	it("hashes nested JSON canonically while retaining array order and hidden metadata", () => {
		const left: AgentMessage[] = [{ ...note("memo"), details: { z: 2, a: { y: 1, b: [2, 3] }, absent: undefined } }];
		const right: AgentMessage[] = [
			{
				timestamp: 4,
				details: { a: { b: [2, 3], y: 1 }, z: 2 },
				content: "memo",
				display: false,
				customType: "live-context-note",
				role: "custom",
			},
		];
		expect(digestMessages(left)).toMatch(/^[a-f0-9]{64}$/);
		expect(digestMessages(left)).toBe(digestMessages(right));
		expect(digestMessages([{ ...note("memo"), details: { z: 2, a: { y: 1, b: [3, 2] } } }])).not.toBe(
			digestMessages(left),
		);
		expect(digestMessages(conversation())).not.toBe(digestMessages(conversation().reverse()));
		expect(digestMessages([result("a", "same")])).not.toBe(
			digestMessages([{ ...result("a", "same"), isError: false }]),
		);
	});

	it("detects only custom live-context notes", () => {
		expect(isLiveContextNote(note("memo"))).toBe(true);
		expect(isLiveContextNote({ ...note("memo"), customType: "live-context-projection" })).toBe(false);
		expect(isLiveContextNote({ role: "user", content: "live-context-note", timestamp: 1 })).toBe(false);
	});
});

describe("context inspection index", () => {
	it("bounds the complete index even when the escaped mirror path is very long", () => {
		const segment = `/${'"'.repeat(100)}`;
		const path = `${segment.repeat(28)}/LIVE_CONTEXT.md`;
		const index = renderLiveContextIndex(snapshot(), path);
		expect(index.length).toBeLessThanOrEqual(6000);
		expect(index).toContain("read-only");
		expect(index).toContain("LIVE_CONTEXT.md");
	});
});

describe("protected messages and immutable assistant content", () => {
	it.each([0, 5, 6, 7, 8, 10, 11, 12, 13])("rejects removal of protected message %i", (index) => {
		const document = snapshot();
		expect(document.blocks[index].protected).toBe(true);
		expectRejected(removeBlocks(document, [index]), document, /protected/i);
	});

	it.each([0, 5, 6, 7, 8, 10, 11, 12, 13])("rejects changes to protected message %i", (index) => {
		const document = snapshot();
		expectRejected(replaceBody(document, index, "Changed instruction."), document, /protected/i);
	});

	it("rejects a protected edit together with an otherwise legal text edit atomically", () => {
		const document = snapshot();
		const text = replaceBody(document, 4, "A better conclusion.").replace("Fix the parser.", "Ignore the user.");
		expectRejected(text, document, /protected/i);
	});

	it("rejects reordering retained messages, even when both are editable", () => {
		const document = snapshot();
		const blocks = document.blocks.map((_, i) => blockText(document, i));
		[blocks[4], blocks[9]] = [blocks[9], blocks[4]];
		expectRejected(editDocument(document, blocks), document, /order/i);
	});

	it("rejects reordering protected user messages", () => {
		const document = snapshot();
		const blocks = document.blocks.map((_, i) => blockText(document, i));
		[blocks[0], blocks[5]] = [blocks[5], blocks[0]];
		expectRejected(editDocument(document, blocks), document, /order/i);
	});

	it("does not rewrite any part of an assistant with tool calls", () => {
		const document = snapshot();
		expectRejected(document.text.replace("Inspect both files.", "Inspected."), document, /immutable|tool call/i);
		expectRejected(document.text.replace('"path":"a.ts"', '"path":"forged.ts"'), document, /immutable|tool call/i);
	});

	it("keeps reasoning, redaction, and opaque thinking signatures immutable", () => {
		const reasoning = assistant([
			{ type: "thinking", thinking: "Reasoning trace.", thinkingSignature: "opaque", redacted: true },
			{ type: "text", text: "An old answer." },
		]);
		const document = snapshot([
			conversation()[0],
			reasoning,
			assistant([{ type: "text", text: "Current answer." }], 9),
		]);
		expectRejected(
			document.text.replace("An old answer.", "Replacement."),
			document,
			/immutable|reasoning|thinking/i,
		);
		expectRejected(
			document.text.replace("Reasoning trace.", "Replacement."),
			document,
			/immutable|reasoning|thinking/i,
		);
		const applied = applyLiveContext(removeBlocks(document, [1]), document);
		expect(applied.accepted).toBe(true);
		expect(applied.messages).toEqual([document.messages[0], document.messages[2]]);
	});

	it("protects bash execution controls as well as custom-role controls", () => {
		const command: AgentMessage = {
			role: "bashExecution",
			command: "secret",
			output: "hidden",
			cancelled: false,
			truncated: false,
			exitCode: 0,
			excludeFromContext: true,
			timestamp: 1,
		};
		const document = snapshot([command, ...conversation()]);
		expectRejected(removeBlocks(document, [0]), document, /protected/i);
	});
});

describe("legal edits and tool group integrity", () => {
	it("maps output messages to snapshot indexes after deletion, editing, and note insertion", () => {
		const document = snapshot();
		const blocks = document.blocks.flatMap((block, index) => {
			if ([1, 2, 3].includes(index)) return [];
			if (index === 4) {
				return [newNote(document, "Remember the deleted group's findings."), `${block.header}\nEdited conclusion.`];
			}
			return [blockText(document, index)];
		});
		const applied = applyLiveContext(editDocument(document, blocks), document);
		expect(applied).toMatchObject({ accepted: true, changed: true });
		expect(applied.sourceIndexes).toEqual([0, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
		expect(applied.sourceIndexes).toHaveLength(applied.messages.length);
		expect(applied.messages[0]).toBe(document.messages[0]);
		expect(isLiveContextNote(applied.messages[1])).toBe(true);
		expect(applied.messages[2]).toMatchObject({ role: "assistant", content: [{ text: "Edited conclusion." }] });
	});

	it("allows a growing old assistant text replacement and preserves its metadata", () => {
		const document = snapshot();
		const replacement = "A longer conclusion with additional useful context. ".repeat(20);
		const applied = applyLiveContext(replaceBody(document, 4, replacement), document);
		expect(applied).toMatchObject({ accepted: true, changed: true });
		expect(applied.messages[4]).toEqual({
			...document.messages[4],
			content: [{ type: "text", text: replacement, textSignature: "assistant-text-id" }],
		});
		expect(applied.diff).toContain("-Old conclusion.");
		expect(applied.diff).toContain("+A longer conclusion");
		expect(document.blocks[4].body).toBe("Old conclusion.");
	});

	it("edits a real parallel tool result without losing its role, linkage, usage, or details", () => {
		const document = snapshot();
		const applied = applyLiveContext(replaceBody(document, 2, "Concise b result."), document);
		expect(applied).toMatchObject({ accepted: true, changed: true });
		expect(applied.messages[2]).toEqual({
			...document.messages[2],
			content: [{ type: "text", text: "Concise b result.", textSignature: "text-b" }],
		});
		const changed = applied.messages[2] as ToolResultMessage;
		const original = document.messages[2] as ToolResultMessage;
		expect(changed.usage).toBe(original.usage);
		expect(changed.details).toBe(original.details);
		expect(changed.addedToolNames).toBe(original.addedToolNames);
		for (const i of [0, 1, 3, 4, 10, 11]) expect(applied.messages[i]).toBe(document.messages[i]);
	});

	it("allows empty tool-result text while retaining the paired result message", () => {
		const document = snapshot();
		const applied = applyLiveContext(replaceBody(document, 2, ""), document);
		expect(applied.accepted).toBe(true);
		expect(applied.messages[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "b",
			content: [{ type: "text", text: "" }],
		});
		expect(applied.messages).toHaveLength(document.messages.length);
	});

	it("deletes a complete old parallel call/result group", () => {
		const document = snapshot();
		const applied = applyLiveContext(removeBlocks(document, [1, 2, 3]), document);
		expect(applied).toMatchObject({ accepted: true, changed: true });
		expect(applied.messages).toEqual(document.messages.filter((_, i) => ![1, 2, 3].includes(i)));
		expect(applied.messages[0]).toBe(document.messages[0]);
		expect(applied.messages[1]).toBe(document.messages[4]);
	});

	it.each([[1], [2], [3], [2, 3], [1, 2]])(
		"rejects partial group deletion %j without repairing or flattening",
		(...indexes) => {
			const document = snapshot();
			expectRejected(removeBlocks(document, indexes), document, /tool|call|result|group/i);
		},
	);

	it("matches every parallel result ID once, not merely the result count", () => {
		const messages = conversation();
		messages[3] = result("b", "Duplicate result.", 4);
		const document = snapshot(messages);
		expectRejected(replaceBody(document, 4, "Changed conclusion."), document, /duplicate|missing|tool.*result/i);
	});

	it("rejects a result with the wrong tool name", () => {
		const messages = conversation();
		messages[2] = { ...result("b", "Wrong tool."), toolName: "bash" };
		const document = snapshot(messages);
		expectRejected(replaceBody(document, 4, "Changed conclusion."), document, /tool.*name|name.*match/i);
	});

	it.each([2, 3, 11])("rejects new notes inserted into a tool sequence at %i", (before) => {
		const document = snapshot();
		expectRejected(insertNote(document, before), document, /tool|call|result|group/i);
	});

	it("adds notes at a complete group boundary as hidden custom messages, deterministically", () => {
		const document = snapshot();
		const text = insertNote(document, 4);
		const applied = applyLiveContext(text, document);
		expect(applied).toMatchObject({ accepted: true, changed: true });
		expect(applied.messages[4]).toMatchObject({
			role: "custom",
			customType: "live-context-note",
			display: false,
			content: "Remember the invariant.",
		});
		expect(isLiveContextNote(applied.messages[4])).toBe(true);
		expect(applied.messages.filter((message) => message.role === "user")).toEqual(
			document.messages.filter((message) => message.role === "user"),
		);
		expect(applyLiveContext(text, document)).toEqual(applied);
	});

	it("allows editing or dropping an old live-context note", () => {
		const document = snapshot();
		expect(document.blocks[9].role).toBe("notes");
		const applied = applyLiveContext(replaceBody(document, 9, "Revised memo."), document);
		expect(applied.accepted).toBe(true);
		expect(applied.messages[9]).toEqual({ ...document.messages[9], content: "Revised memo." });
		expect(applyLiveContext(removeBlocks(document, [9]), document).accepted).toBe(true);
	});
});

describe("interrupted assistant tool calls", () => {
	function withUnexecutedCall(stopReason: AssistantMessage["stopReason"]): LiveContextDocument {
		const messages = conversation();
		messages.splice(5, 0, {
			...assistant(
				[
					{ type: "thinking", thinking: "Partial reasoning.", thinkingSignature: "partial-signature" },
					call("unexecuted"),
				],
				5,
			),
			stopReason,
			errorMessage: "Stream interrupted before tool execution.",
		});
		return snapshot(messages);
	}

	describe.each(["error", "aborted"] as const)("%s assistant", (stopReason) => {
		it("allows an old normal edit while preserving the failed record and actual users/tools", () => {
			const document = withUnexecutedCall(stopReason);
			const applied = applyLiveContext(replaceBody(document, 4, "Updated normal finding."), document);
			expect(applied).toMatchObject({ accepted: true, changed: true });
			expect(applied.sourceIndexes).toEqual(document.messages.map((_, index) => index));
			expect(applied.messages[4]).toMatchObject({ content: [{ text: "Updated normal finding." }] });
			for (const [index, message] of document.messages.entries()) {
				if (index !== 4) expect(applied.messages[index]).toBe(message);
			}
		});

		it("preserves the failed record and all metadata on a no-op", () => {
			const document = withUnexecutedCall(stopReason);
			const before = structuredClone(document.messages);
			const applied = applyLiveContext(document.text, document);
			expect(applied).toMatchObject({ accepted: true, changed: false, diff: "" });
			expect(applied.sourceIndexes).toEqual(document.messages.map((_, index) => index));
			expect(applied.messages).toEqual(before);
			for (const [index, message] of document.messages.entries()) expect(applied.messages[index]).toBe(message);
		});

		it("allows removal of an old failed assistant without manufacturing a result", () => {
			const document = withUnexecutedCall(stopReason);
			const applied = applyLiveContext(removeBlocks(document, [5]), document);
			expect(applied).toMatchObject({ accepted: true, changed: true });
			expect(applied.messages).toEqual(document.messages.filter((_, index) => index !== 5));
			expect(applied.sourceIndexes).toEqual(document.messages.flatMap((_, index) => (index === 5 ? [] : [index])));
			expect(applied.messages[5]).toBe(document.messages[6]);
		});

		it("still rejects rewriting the failed assistant's tool calls or reasoning", () => {
			const document = withUnexecutedCall(stopReason);
			expectRejected(replaceBody(document, 5, "Rewritten failed call."), document, /immutable/i);
		});

		it.each(["unexecuted", "unrelated"])("still rejects a real orphan result for %s", (toolCallId) => {
			const messages = withUnexecutedCall(stopReason).messages;
			messages.splice(6, 0, result(toolCallId, "Actual result with no successful caller.", 6));
			const document = snapshot(messages);
			expectRejected(replaceBody(document, 4, "Updated normal finding."), document, /orphan.*tool result/i);
		});
	});

	it.each(["toolUse", "stop", "length", "pending", "deferred"] as const)(
		"still requires results for an assistant whose stop reason is %s",
		(stopReason) => {
			const document = withUnexecutedCall(stopReason);
			expectRejected(replaceBody(document, 4, "Updated normal finding."), document, /incomplete tool group/i);
		},
	);
});

describe("images and structural-line escaping", () => {
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8taW1hZ2U=" };

	function withImage(): LiveContextDocument {
		const messages = conversation();
		messages[2] = {
			...result("b", "unused"),
			content: [
				{ type: "text", text: "Before image.", textSignature: "before" },
				image,
				{ type: "text", text: "After image." },
			],
		};
		return snapshot(messages);
	}

	it("edits text around an image while keeping the image and text block metadata", () => {
		const document = withImage();
		expect(document.text).not.toContain(image.data);
		const applied = applyLiveContext(document.text.replace("Before image.", "Image summary."), document);
		expect(applied.accepted).toBe(true);
		const edited = applied.messages[2] as ToolResultMessage;
		expect(edited.content).toEqual([
			{ type: "text", text: "Image summary.", textSignature: "before" },
			image,
			{ type: "text", text: "After image." },
		]);
		expect(edited.content[1]).toBe(image);
	});

	it("rejects altered, removed, or duplicated image placeholders", () => {
		const document = withImage();
		const placeholder = document.blocks[2].body.split("\n").find((line) => line.includes("CTX_IMAGE"));
		expect(placeholder).toBeDefined();
		for (const replacement of ["[image removed]", "", `${placeholder}\n${placeholder}`]) {
			expectRejected(
				document.text.replace(placeholder!, replacement),
				document,
				/image|placeholder|content.*marker/i,
			);
		}
	});

	it("preserves adjacent text block boundaries and signatures on a text edit", () => {
		const messages = conversation();
		messages[2] = {
			...result("b", "unused"),
			content: [
				{ type: "text", text: "Part one.", textSignature: "one" },
				{ type: "text", text: "Part two.", textSignature: "two" },
			],
		};
		const document = snapshot(messages);
		const applied = applyLiveContext(document.text.replace("Part two.", "Short second part."), document);
		expect(applied.accepted).toBe(true);
		expect((applied.messages[2] as ToolResultMessage).content).toEqual([
			{ type: "text", text: "Part one.", textSignature: "one" },
			{ type: "text", text: "Short second part.", textSignature: "two" },
		]);
	});

	it("escapes quoted live metadata, active headers, and already escaped structural lines", () => {
		const first = snapshot();
		const quoted = `File output:\n${first.text.split("\n")[0]}\n${first.blocks[0].header}\n\\${first.blocks[1].header}\n  ${first.blocks[4].header}`;
		const messages = conversation();
		messages[2] = result("b", quoted);
		const document = snapshot(messages);
		expect(document.documentId).toBe(first.documentId);
		expect(document.blocks[2].body).toContain(`\\${first.blocks[0].header}`);
		expect(document.blocks[2].body).toContain(`\\\\${first.blocks[1].header}`);
		const applied = applyLiveContext(document.text.replace("File output:", "Short output:"), document);
		expect(applied.accepted).toBe(true);
		expect(applied.messages).toHaveLength(messages.length);
		expect((applied.messages[2] as ToolResultMessage).content[0]).toMatchObject({
			text: quoted.replace("File output:", "Short output:"),
		});
		expect(applied.messages[0]).toBe(messages[0]);
	});

	it("preserves significant leading/trailing whitespace on an edited text body", () => {
		const document = snapshot();
		const body = "\n  indented output  \n\n";
		const applied = applyLiveContext(replaceBody(document, 2, body), document);
		expect(applied.accepted).toBe(true);
		expect((applied.messages[2] as ToolResultMessage).content[0]).toMatchObject({ text: body });
	});
});

describe("document validation", () => {
	it.each(["", "  \n", "Summary without headers."])("rejects empty or headerless input %j", (text) => {
		expectRejected(text, snapshot(), /empty|metadata|header/i);
	});

	it("rejects stale revisions, session nonces, and baselines with actionable metadata errors", () => {
		const document = snapshot();
		for (const text of [
			snapshot(document.messages, 6).text,
			snapshot(document.messages, 7, "another-session").text,
			document.text.replace(`baseline=${document.baselineDigest}`, `baseline=${"0".repeat(64)}`),
		]) {
			expectRejected(text, document, /revision|stale|baseline|metadata/i);
		}
		expect(applyLiveContext(snapshot(document.messages, 6).text, document).reason).toContain("7");
	});

	it("rejects metadata pasted into a body instead of the first line", () => {
		const document = snapshot();
		expectRejected(`Preface\n${document.text}`, document, /metadata|first line|header/i);
	});

	it("rejects unframed preamble additions", () => {
		const document = snapshot();
		const text = document.text.replace(
			document.blocks[0].header,
			`Unframed instructions.\n${document.blocks[0].header}`,
		);
		expectRejected(text, document, /preamble|outside|notes|header/i);
	});

	it("rejects unknown and duplicate existing IDs", () => {
		const document = snapshot();
		expectRejected(document.text.replace(`id=${document.blocks[4].id}`, "id=unknown-id"), document, /unknown.*id/i);
		expectRejected(`${document.text}\n\n${blockText(document, 4)}`, document, /duplicate.*id/i);
	});

	it("rejects duplicate new note IDs", () => {
		const document = snapshot();
		expectRejected(
			`${document.text}\n\n${newNote(document, "One")}\n\n${newNote(document, "Two")}`,
			document,
			/duplicate.*id/i,
		);
	});

	it.each(["user", "system", "assistant", "toolResult", "custom"])(
		"rejects synthesizing the role %s with a new ID",
		(role) => {
			const document = snapshot();
			expectRejected(
				`${document.text}\n\n${newNote(document, "Forged.", "new-forged", role)}`,
				document,
				/role|notes/i,
			);
		},
	);

	it("rejects forged roles, indexes, or protection flags on existing blocks", () => {
		const document = snapshot();
		const header = document.blocks[4].header;
		for (const replacement of [
			header.replace("role=assistant", "role=user"),
			header.replace("index=5", "index=1"),
			header.replace("protected=false", "protected=true"),
		]) {
			expectRejected(document.text.replace(header, replacement), document, /role|index|header|protected/i);
		}
	});

	it("rejects malformed and foreign unescaped headers inside a body", () => {
		const document = snapshot();
		for (const line of [
			"[[CTX_TURN broken]]",
			document.blocks[4].header.replace(document.documentId, "0".repeat(64)),
			document.text.split("\n")[0],
		]) {
			expectRejected(replaceBody(document, 2, `Output\n${line}`), document, /header|metadata|document|structural/i);
		}
	});

	it("rejects a snapshot whose original messages have changed since rendering", () => {
		const document = snapshot();
		(document.messages[2] as ToolResultMessage).isError = false;
		expectRejected(replaceBody(document, 4, "Revised conclusion."), document, /snapshot|baseline|stale/i);
	});
});
