import { fauxAssistantMessage, type ToolResultMessage } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { renderLiveContext } from "../src/core/compaction/live-context/document.ts";
import {
	createLiveContextReadView,
	LIVE_CONTEXT_READ_MAX_BYTES,
} from "../src/core/compaction/live-context/read-view.ts";

function snapshot() {
	return renderLiveContext(
		[
			{ role: "user", content: "Preserve precise protocol values", timestamp: 1 },
			...Array.from({ length: 35 }, () => fauxAssistantMessage("重复的历史记录😀\n".repeat(500))),
			fauxAssistantMessage("Current protected state"),
		],
		0,
		"read-view",
	);
}

describe("CLM read view", () => {
	it("uses a byte bound for a large Unicode index and preserves non-text output", () => {
		const document = snapshot();
		const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
		const content: ToolResultMessage["content"] = [{ type: "text", text: document.text }, image];
		const view = createLiveContextReadView({
			document,
			mirrorPath: "/tmp/LIVE_CONTEXT.md",
			isMirrorPath: true,
			toolName: "read",
			args: {},
			content,
			isError: false,
		})!;
		expect(view.kind).toBe("index");
		const text = view.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(LIVE_CONTEXT_READ_MAX_BYTES);
		expect(text).toContain("Working context index");
		expect(view.content[1]).toBe(image);
		expect(content[0]).toMatchObject({ text: document.text });
	});
	it("leaves framing from another session untouched", () => {
		const document = snapshot();
		const other = renderLiveContext(document.messages, 0, "another-session");
		expect(
			createLiveContextReadView({
				document,
				mirrorPath: "/tmp/LIVE_CONTEXT.md",
				isMirrorPath: false,
				toolName: "read",
				args: {},
				content: [{ type: "text", text: other.text }],
				isError: false,
			}),
		).toBeUndefined();
	});
	it("quotes short framing excerpts and replaces an oversized selected line by an index", () => {
		const document = snapshot();
		const base = {
			document,
			mirrorPath: "/tmp/LIVE_CONTEXT.md",
			isMirrorPath: true,
			toolName: "read",
			args: { offset: 3, limit: 1 },
			isError: false,
		};
		const short = createLiveContextReadView({
			...base,
			content: [{ type: "text", text: document.blocks[0].header }],
		})!;
		expect(short.kind).toBe("excerpt");
		const text = short.content[0];
		expect(text.type === "text" && /^\[\[CTX_TURN/m.test(text.text)).toBe(false);
		expect(createLiveContextReadView({ ...base, content: [{ type: "text", text: "😀".repeat(1500) }] })?.kind).toBe(
			"index",
		);
	});
	it("leaves a short atomic edit status alone", () => {
		const document = snapshot();
		expect(
			createLiveContextReadView({
				document,
				mirrorPath: "/tmp/LIVE_CONTEXT.md",
				isMirrorPath: true,
				toolName: "bash",
				args: {},
				content: [{ type: "text", text: "Edit saved" }],
				isError: false,
			}),
		).toBeUndefined();
	});
});
