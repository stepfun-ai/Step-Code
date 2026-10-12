import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import { createStepToolProfile } from "../../src/step/tool-profile.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const finding = "DEVICE REPORT FINAL: magic_hex=d371; byte_order=little; checksum=xor8";
const history = `${`${"completed diagnostic check; no new failure; ".repeat(4)}\n`.repeat(1100)}${finding}\n`;
const MAX_VIEW_BYTES = 4096;
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

async function setup(
	options: { large?: boolean; oldText?: string; extensions?: HarnessOptions["extensionFactories"] } = {},
) {
	const h = await createHarness({
		models: [{ id: "mirror-read", contextWindow: 64000, maxTokens: 8192 }],
		settings: {
			compaction: {
				contextProjection: "clm-v1",
				reserveTokens: 8192,
				keepRecentTokens: 20000,
				autoClm: { enabled: false },
			},
		},
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
			...(options.extensions ?? []),
		],
	});
	harnesses.push(h);
	const initial: AgentMessage[] = [
		{ role: "user", content: "Implement the exact reported protocol. Preserve user requirements.\r\n", timestamp: 1 },
		fauxAssistantMessage(options.oldText ?? (options.large === false ? "old finding" : history), { timestamp: 2 }),
		fauxAssistantMessage("Investigation complete; implementation remains", { timestamp: 3 }),
	];
	for (const message of initial)
		if (message.role === "user" || message.role === "assistant") h.sessionManager.appendMessage(message);
	h.session.agent.state.messages = initial;
	return h;
}

async function execute(h: Harness, tool: string, args: () => Record<string, unknown>) {
	let next: Context | undefined;
	h.setResponses([
		() => fauxAssistantMessage(fauxToolCall(tool, args()), { stopReason: "toolUse" }),
		(context) => {
			next = context;
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("Verify the existing evidence before continuing");
	expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	const result = [...h.session.messages].reverse().find((message) => message.role === "toolResult");
	expect(result).toBeDefined();
	return { result: result!, next };
}

describe("bounded session-owned context reads", () => {
	it("replaces a whole mirror read with a small index before it enters history", async () => {
		const h = await setup();
		const { result, next } = await execute(h, "read", () => ({ path: h.session.getLiveContextStatus()!.path }));
		const text = getMessageText(result);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
		expect(text).toContain("Working context index");
		expect(text).not.toContain("[[CTX_TURN");
		expect(text).not.toContain("Use offset=");
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(next!.messages.some((message) => getMessageText(message) === history)).toBe(true);
		expect(
			h.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && getMessageText(entry.message) === history),
		).toBe(true);
	});

	it("bounds a large middle range through a symlink to the active mirror", async () => {
		const h = await setup();
		const { result } = await execute(h, "read", () => {
			const link = join(h.tempDir, "alias.md");
			symlinkSync(h.session.getLiveContextStatus()!.path, link);
			return { path: link, offset: 100, limit: 1000 };
		});
		expect(Buffer.byteLength(getMessageText(result))).toBeLessThanOrEqual(MAX_VIEW_BYTES);
		expect(getMessageText(result)).toContain("Working context index");
	});

	it("allows a short quoted evidence range without inviting whole-file pagination", async () => {
		const h = await setup();
		const { result } = await execute(h, "read", () => {
			const path = h.session.getLiveContextStatus()!.path;
			const line = readFileSync(path, "utf8").split("\n").indexOf(finding);
			return { path, offset: line + 1, limit: 1 };
		});
		const text = getMessageText(result);
		expect(text).toContain(finding);
		expect(text).toContain("excerpt");
		expect(text).not.toContain("Use offset=");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
	});

	it("supports the actual Step read_file start_line/end_line range", async () => {
		const h = await setup({
			extensions: [
				(pi) => {
					pi.registerTool(createStepToolProfile(process.cwd()).find((tool) => tool.name === "read_file")!);
				},
			],
		});
		const { result } = await execute(h, "read_file", () => {
			const path = h.session.getLiveContextStatus()!.path;
			const line = readFileSync(path, "utf8").split("\n").indexOf(finding) + 1;
			return { path, start_line: line, end_line: line, max_chars: 2000 };
		});
		expect(getMessageText(result)).toContain(finding);
		expect(getMessageText(result)).toContain("excerpt");
		expect(Buffer.byteLength(getMessageText(result))).toBeLessThanOrEqual(MAX_VIEW_BYTES);
	});

	it("does not present a Step character-truncated line as complete evidence", async () => {
		const longLine = `LONG_EVIDENCE ${"x".repeat(3000)}`;
		const h = await setup({
			oldText: longLine,
			extensions: [
				(pi) => {
					pi.registerTool(createStepToolProfile(process.cwd()).find((tool) => tool.name === "read_file")!);
				},
			],
		});
		const { result } = await execute(h, "read_file", () => {
			const path = h.session.getLiveContextStatus()!.path;
			const line = readFileSync(path, "utf8").split("\n").indexOf(longLine) + 1;
			return { path, start_line: line, end_line: line, max_chars: 200 };
		});
		expect(getMessageText(result)).toContain("Working context index");
		expect(getMessageText(result)).not.toContain("Output truncated to 200");
	});

	it("also bounds a large current-mirror echo produced by the shell", async () => {
		const h = await setup();
		const { result } = await execute(h, "bash", () => ({
			command: `cat '${h.session.getLiveContextStatus()!.path.replace(/'/g, "'\\''")}'`,
		}));
		expect(Buffer.byteLength(getMessageText(result))).toBeLessThanOrEqual(MAX_VIEW_BYTES);
		expect(getMessageText(result)).toContain("Working context index");
		expect(result).toMatchObject({ role: "toolResult", isError: false });
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("keeps an unrelated project file with the same basename on the normal read path", async () => {
		const h = await setup({ large: false });
		const path = join(h.tempDir, "LIVE_CONTEXT.md");
		const contents = "ordinary project document\n".repeat(1000);
		writeFileSync(path, contents);
		const { result } = await execute(h, "read", () => ({ path }));
		expect(getMessageText(result)).toBe(contents);
		expect(Buffer.byteLength(getMessageText(result))).toBeGreaterThan(MAX_VIEW_BYTES);
	});

	it("retains a blocked read error rather than returning successful context content", async () => {
		const h = await setup({
			large: false,
			extensions: [
				(pi) => {
					pi.on("tool_call", (event) =>
						event.toolName === "read" ? { block: true, reason: "Read denied by test policy" } : undefined,
					);
				},
			],
		});
		const { result } = await execute(h, "read", () => ({ path: h.session.getLiveContextStatus()!.path }));
		expect(result).toMatchObject({ role: "toolResult", isError: true });
		expect(getMessageText(result)).toContain("Read denied");
		expect(getMessageText(result)).not.toContain("Working context index");
	});

	it("bounds extension-replaced mirror output while preserving details and tool usage", async () => {
		let h: Harness;
		const usage = {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		h = await setup({
			extensions: [
				(pi) => {
					pi.on("tool_result", (event) =>
						event.toolName === "read"
							? {
									content: [
										{ type: "text", text: readFileSync(h.session.getLiveContextStatus()!.path, "utf8") },
									],
									details: { customMarker: "retained" },
									usage,
								}
							: undefined,
					);
				},
			],
		});
		const path = join(h.tempDir, "project.txt");
		writeFileSync(path, "ordinary content");
		const { result } = await execute(h, "read", () => ({ path }));
		expect(Buffer.byteLength(getMessageText(result))).toBeLessThanOrEqual(MAX_VIEW_BYTES);
		expect(result).toMatchObject({
			isError: false,
			usage,
			details: { customMarker: "retained", liveContextRead: { kind: "index" } },
		});
	});
});
