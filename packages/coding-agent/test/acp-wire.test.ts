import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	convertAcpMcpServers,
	extractTurnError,
	mapAssistantEventToSessionUpdate,
	normalizePrompt,
	parseElicitationResult,
	parseJsonRpcLine,
	parseRequestPermissionResult,
	toSessionNotification,
	validateForkSessionParams,
	validateInitializeParams,
	validateListSessionsParams,
	validateLoadSessionParams,
	validateNewSessionParams,
	validatePromptParams,
	validateReadTextFileParams,
	validateResumeSessionParams,
	validateSetSessionConfigOptionParams,
	validateSetSessionModelParams,
	validateSetSessionModeParams,
	validateTerminalCreateParams,
	validateTerminalKillParams,
	validateTerminalOutputParams,
	validateTerminalReleaseParams,
	validateTerminalWaitForExitParams,
	validateWriteTextFileParams,
} from "../src/modes/acp/acp-wire.ts";

describe("acp wire parsing", () => {
	test("parses a JSON-RPC request", () => {
		const parsed = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}');
		expect(parsed.error).toBeUndefined();
		expect(parsed.request).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1 },
		});
	});

	test("parses a JSON-RPC response without treating it as a request", () => {
		const parsed = parseJsonRpcLine('{"jsonrpc":"2.0","id":"abc","result":{"outcome":{"outcome":"cancelled"}}}');
		expect(parsed.error).toBeUndefined();
		expect(parsed.request).toBeUndefined();
		expect(parsed.response).toEqual({
			jsonrpc: "2.0",
			id: "abc",
			result: { outcome: { outcome: "cancelled" } },
		});
	});

	test("reports invalid JSON", () => {
		expect(parseJsonRpcLine("{").error).toMatchObject({ code: -32700 });
	});
});

describe("acp parameter validation", () => {
	test("accepts initialize params", () => {
		expect(validateInitializeParams({ protocolVersion: 1 }).ok).toBe(true);
		expect(validateInitializeParams({}).ok).toBe(false);
	});

	test("requires an absolute cwd for session lifecycle requests", () => {
		expect(validateNewSessionParams({ cwd: "/repo", mcpServers: [] }).ok).toBe(true);
		expect(validateNewSessionParams({ cwd: "repo", mcpServers: [] }).ok).toBe(false);
		expect(validateLoadSessionParams({ sessionId: "s1", cwd: "/repo", mcpServers: [] }).ok).toBe(true);
		expect(validateLoadSessionParams({ sessionId: "s1", cwd: "repo", mcpServers: [] }).ok).toBe(false);
		expect(validateResumeSessionParams({ sessionId: "s1", cwd: "/repo", mcpServers: [] }).ok).toBe(true);
		expect(validateResumeSessionParams({ sessionId: "s1", cwd: "repo", mcpServers: [] }).ok).toBe(false);
		// Fork was the one lifecycle method that took a relative cwd. It writes the
		// new session under that path and matches it against the source session's
		// stored cwd, so a relative one resolves against wherever the agent happens
		// to run and then fails somewhere the client never named.
		expect(validateForkSessionParams({ sessionId: "s1", cwd: "/repo" }).ok).toBe(true);
		expect(validateForkSessionParams({ sessionId: "s1", cwd: "repo" }).ok).toBe(false);
		expect(validateListSessionsParams({ cwd: "/repo" }).ok).toBe(true);
		expect(validateListSessionsParams({ cwd: "repo" }).ok).toBe(false);
	});

	test("validates client-side file requests", () => {
		expect(validateReadTextFileParams({ sessionId: "s1", path: "/repo/a.ts" }).ok).toBe(true);
		expect(validateReadTextFileParams({ sessionId: "s1" }).ok).toBe(false);
		expect(validateReadTextFileParams({ path: "/repo/a.ts" }).ok).toBe(false);
		const ranged = validateReadTextFileParams({ sessionId: "s1", path: "/repo/a.ts", line: 10, limit: 5 });
		expect(ranged.ok && ranged.value).toMatchObject({ line: 10, limit: 5 });

		expect(validateWriteTextFileParams({ sessionId: "s1", path: "/repo/a.ts", content: "x" }).ok).toBe(true);
		expect(validateWriteTextFileParams({ sessionId: "s1", path: "/repo/a.ts" }).ok).toBe(false);
		expect(validateWriteTextFileParams({ sessionId: "s1", path: "/repo/a.ts", content: 1 }).ok).toBe(false);
	});

	test("validates terminal requests and drops malformed env and args", () => {
		expect(validateTerminalCreateParams({ sessionId: "s1", command: "npm" }).ok).toBe(true);
		expect(validateTerminalCreateParams({ sessionId: "s1" }).ok).toBe(false);
		const created = validateTerminalCreateParams({
			sessionId: "s1",
			command: "npm",
			args: ["test", 3, null],
			env: [{ name: "A", value: "1" }, { name: "B" }, "junk"],
			cwd: "/repo",
			outputByteLimit: 1024,
		});
		expect(created.ok && created.value).toEqual({
			sessionId: "s1",
			command: "npm",
			args: ["test"],
			env: [{ name: "A", value: "1" }],
			cwd: "/repo",
			outputByteLimit: 1024,
		});

		for (const validate of [
			validateTerminalOutputParams,
			validateTerminalWaitForExitParams,
			validateTerminalReleaseParams,
			validateTerminalKillParams,
		]) {
			expect(validate({ sessionId: "s1", terminalId: "t1" }).ok).toBe(true);
			expect(validate({ sessionId: "s1" }).ok).toBe(false);
			expect(validate({ terminalId: "t1" }).ok).toBe(false);
		}
	});

	test("validates the two methods outside the v1 schema", () => {
		expect(validateForkSessionParams({ sessionId: "s1", cwd: "/repo" }).ok).toBe(true);
		expect(validateForkSessionParams({ sessionId: "s1" }).ok).toBe(false);
		const forked = validateForkSessionParams({
			sessionId: "s1",
			cwd: "/repo",
			mcpServers: [],
			additionalDirectories: [],
		});
		expect(forked.ok && forked.value).toMatchObject({ sessionId: "s1", cwd: "/repo", mcpServers: [] });

		expect(validateSetSessionModelParams({ sessionId: "s1", modelId: "step/step-3" }).ok).toBe(true);
		expect(validateSetSessionModelParams({ sessionId: "s1" }).ok).toBe(false);
		expect(validateSetSessionModelParams({ sessionId: "s1", modelId: "" }).ok).toBe(false);
	});

	test("validates additionalDirectories the same way on every session-entry method", () => {
		const base = { sessionId: "s1", cwd: "/repo", mcpServers: [] };
		const bad: unknown[] = [["/repo", ""], ["", "/repo"], 42, "nope", { root: "/repo" }];
		for (const additionalDirectories of bad) {
			expect(validateNewSessionParams({ ...base, additionalDirectories }).ok).toBe(false);
			expect(validateLoadSessionParams({ ...base, additionalDirectories }).ok).toBe(false);
			expect(validateResumeSessionParams({ ...base, additionalDirectories }).ok).toBe(false);
		}
		// Absent normalizes to an empty list rather than staying undefined, so a
		// caller never has to branch on whether the client sent the field.
		const empty = (parsed: unknown): unknown =>
			parsed && typeof parsed === "object" && "value" in parsed
				? (parsed as { value: { additionalDirectories?: unknown } }).value.additionalDirectories
				: (parsed as { additionalDirectories?: unknown }).additionalDirectories;
		for (const validate of [validateNewSessionParams, validateLoadSessionParams, validateResumeSessionParams]) {
			const parsed = validate(base);
			expect(parsed.ok).toBe(true);
			expect(empty(parsed)).toEqual([]);
		}
		const withRoots = validateNewSessionParams({ ...base, additionalDirectories: ["/repo/packages"] });
		expect(withRoots.ok && withRoots.additionalDirectories).toEqual(["/repo/packages"]);
	});

	test("accepts baseline prompt content and rejects unsupported blocks", () => {
		const valid = validatePromptParams({
			sessionId: "s1",
			prompt: [
				{ type: "text", text: "hello" },
				{ type: "resource_link", name: "file", uri: "file:///repo/file" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			],
		});
		expect(valid.ok).toBe(true);
		expect(validatePromptParams({ sessionId: "s1", prompt: [{ type: "audio" }] }).ok).toBe(false);
	});
});

describe("acp prompt normalization", () => {
	test("joins text and resource links and keeps images", () => {
		const normalized = normalizePrompt([
			{ type: "text", text: "first" },
			{ type: "resource_link", name: "file", uri: "file:///repo/file" },
			{ type: "text", text: "second" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
		expect(normalized.text).toBe("first\n[[file]](file:///repo/file)\nsecond");
		expect(normalized.images).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
	});

	test("preserves binary embedded resources in a lossless base64 envelope", () => {
		const normalized = normalizePrompt([
			{
				type: "resource",
				resource: { uri: "file:///report.bin?a=1&b=2", mimeType: "application/octet-stream", blob: "AAEC" },
			},
		]);
		expect(normalized.text).toBe(
			'<resource uri="file:///report.bin?a=1&amp;b=2" mimeType="application/octet-stream" encoding="base64">AAEC</resource>',
		);
		expect(normalized.images).toEqual([]);
	});

	test("uses an explicit fallback MIME type for embedded blobs without metadata", () => {
		const normalized = normalizePrompt([
			{ type: "resource", resource: { uri: "file:///inline.bin", blob: "YmluYXJ5" } },
		]);
		expect(normalized.text).toContain('mimeType="application/octet-stream"');
		expect(normalized.text).toContain(">YmluYXJ5</resource>");
	});
});

describe("acp session updates", () => {
	test("maps streamed text and thinking deltas", () => {
		const textEvent = {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} },
		} as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(textEvent)).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hello" },
		});

		const thinkingEvent = {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think", partial: {} },
		} as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(thinkingEvent)).toEqual({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "think" },
		});
	});

	test("maps tool execution lifecycle and redacts obvious secrets", () => {
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "echo hi", apiToken: "secret" },
		} as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(start)).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "call-1",
			title: "bash echo hi",
			name: "bash",
			kind: "execute",
			status: "pending",
			content: [],
			rawInput: { command: "echo hi", apiToken: "[redacted]" },
		});

		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: "boom",
			isError: true,
		} as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(end)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "failed",
			rawOutput: { error: "boom" },
		});
	});

	test("reports a running tool as in_progress instead of skipping to its outcome", () => {
		const update = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
			partialResult: "half a line",
		} as unknown as AgentSessionEvent;
		// The protocol asks for in_progress once the tool runs, and this is the
		// only event between start and end. Without it the client watches a call
		// sit at pending and then jump to its outcome.
		expect(mapAssistantEventToSessionUpdate(update)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "in_progress",
			content: [{ type: "content", content: { type: "text", text: "half a line" } }],
		});

		// A tool that reports no partial output still gets the status.
		const silent = { ...update, partialResult: undefined } as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(silent)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "in_progress",
		});

		// null renders as the string "null" if it is treated as a value, so it
		// has to be filtered the same way undefined is.
		const nullish = { ...update, partialResult: null } as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(nullish)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "in_progress",
		});

		// A streaming tool can emit a large chunk, and this is the path a long
		// running command floods the client through, so the same ceiling applies.
		const verbose = { ...update, partialResult: "y".repeat(9000) } as unknown as AgentSessionEvent;
		const streamed = (
			mapAssistantEventToSessionUpdate(verbose) as {
				content: Array<{ content: { text: string } }>;
			}
		).content[0].content.text;
		expect(streamed.length).toBeLessThan(9000);
		expect(streamed).toContain("[truncated, 9000 characters total]");
	});

	test("reports what a completed tool produced", () => {
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "file body",
			isError: false,
		} as unknown as AgentSessionEvent;
		// Success used to carry nothing, so a client could show that a tool
		// finished but never what it did, which is the case it most needs.
		expect(mapAssistantEventToSessionUpdate(end)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "file body" } }],
		});

		// A structured result is rendered rather than dropped.
		const structured = { ...end, result: { lines: 3 } } as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(structured)).toMatchObject({
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: '{"lines":3}' } }],
		});

		// Nothing to report stays absent rather than becoming an empty block.
		const empty = { ...end, result: undefined } as unknown as AgentSessionEvent;
		expect(mapAssistantEventToSessionUpdate(empty)).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "completed",
		});
	});

	test("bounds the tool arguments it sends, not only the result", () => {
		// `write` puts the whole file in `content`, so an unbounded `rawInput`
		// is the same flood the result ceiling exists to stop, arriving on the
		// way in instead of the way out.
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
			args: { path: "notes/big.md", content: "x".repeat(9000) },
		} as unknown as AgentSessionEvent;
		const call = mapAssistantEventToSessionUpdate(start) as {
			rawInput: { path: string; content: string };
		};
		expect(call.rawInput.path).toBe("notes/big.md");
		expect(call.rawInput.content.length).toBeLessThan(9000);
		expect(call.rawInput.content).toContain("[truncated, 9000 characters total]");

		// Nested and array values are bounded too, and the call keeps its shape.
		const nested = {
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "edit",
			args: { edits: [{ before: "y".repeat(8000), after: "z" }], meta: { note: "n".repeat(7000) } },
		} as unknown as AgentSessionEvent;
		const shaped = mapAssistantEventToSessionUpdate(nested) as {
			rawInput: { edits: Array<{ before: string; after: string }>; meta: { note: string } };
		};
		expect(shaped.rawInput.edits[0].before.length).toBeLessThan(8000);
		expect(shaped.rawInput.edits[0].after).toBe("z");
		expect(shaped.rawInput.meta.note.length).toBeLessThan(7000);

		// A short call is passed through untouched, marker included only when cut.
		const small = {
			type: "tool_execution_start",
			toolCallId: "call-3",
			toolName: "read",
			args: { path: "a.ts" },
		} as unknown as AgentSessionEvent;
		expect((mapAssistantEventToSessionUpdate(small) as { rawInput: unknown }).rawInput).toEqual({
			path: "a.ts",
		});
	});

	test("bounds aggregate arguments when many small fields add up", () => {
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, "x".repeat(100)])),
		} as unknown as AgentSessionEvent;
		const rawInput = (mapAssistantEventToSessionUpdate(start) as { rawInput: unknown }).rawInput;
		expect(typeof rawInput).toBe("string");
		expect((rawInput as string).length).toBeLessThan(11_000);
		expect(rawInput).toContain("[truncated,");
	});

	test("stops walking arguments nested past the depth ceiling", () => {
		// Arguments are model-generated JSON, so the walk is bounded rather than
		// trusted. A payload nested deeper than the ceiling must not be recursed
		// into, and must not be silently dropped either.
		let args: Record<string, unknown> = { leaf: "bottom" };
		for (let i = 0; i < 200; i++) args = { nested: args };
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args,
		} as unknown as AgentSessionEvent;
		const rawInput = (mapAssistantEventToSessionUpdate(start) as { rawInput: Record<string, unknown> }).rawInput;
		let node: unknown = rawInput;
		let depth = 0;
		const walkable = (v: unknown): v is Record<string, unknown> =>
			typeof v === "object" && v !== null && !Array.isArray(v);
		while (walkable(node) && "nested" in node) {
			node = node.nested;
			depth++;
		}
		expect(depth).toBeLessThan(200);
		expect(node).toBe("[nested too deep to display]");
	});

	test("still redacts credential-shaped keys while bounding the rest", () => {
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: {
				API_TOKEN: "t".repeat(9000),
				password: "hunter2",
				api_key: "sk-live-1",
				authorization: "Bearer abc",
				command: "echo hi",
			},
		} as unknown as AgentSessionEvent;
		const rawInput = (mapAssistantEventToSessionUpdate(start) as { rawInput: Record<string, string> }).rawInput;
		// Redaction wins over bounding: a cut secret is still a leaked secret.
		expect(rawInput.API_TOKEN).toBe("[redacted]");
		expect(rawInput.password).toBe("[redacted]");
		// The original list covered token/secret/password only, so these two
		// credential-bearing keys reached the client in cleartext.
		expect(rawInput.api_key).toBe("[redacted]");
		expect(rawInput.authorization).toBe("[redacted]");
		expect(rawInput.command).toBe("echo hi");
	});

	test("bounds the tool output it sends so one call cannot flood the client", () => {
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "x".repeat(5000),
			isError: false,
		} as unknown as AgentSessionEvent;
		const update = mapAssistantEventToSessionUpdate(end);
		const text = (update as { content?: Array<{ content: { text: string } }> }).content?.[0]?.content.text ?? "";
		// Truncated, and says so, so a client does not present a partial read as
		// the whole result. The model still receives the untruncated text.
		expect(text.length).toBeLessThan(5000);
		expect(text).toContain("[truncated, 5000 characters total]");
	});

	test("cuts at a code-point boundary so an emoji is not split in half", () => {
		// `slice` counts UTF-16 code units, so a cut can land between the two
		// halves of a surrogate pair and leave a lone high surrogate, which
		// serializes as an unpaired escape and renders as a replacement char.
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: `${"a".repeat(3999)}\u{1F600}${"b".repeat(10)}`,
			isError: false,
		} as unknown as AgentSessionEvent;
		const update = mapAssistantEventToSessionUpdate(end) as {
			content: Array<{ content: { text: string } }>;
		};
		const body = update.content[0].content.text.split("\n")[0];
		// The half that could not be completed is dropped, so the text ends on a
		// whole character instead of a lone surrogate.
		expect(body.length).toBe(3999);
		expect(body.charCodeAt(body.length - 1)).toBe(0x61);
	});

	test("bounds a failed tool call's error output too", () => {
		// An error carries whatever the tool printed before it gave up, so a
		// failure is a flood path in its own right. The success branch goes
		// through the content ceiling; the failure branch must not bypass it.
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: "stderr line\n".repeat(50000),
			isError: true,
		} as unknown as AgentSessionEvent;
		const update = mapAssistantEventToSessionUpdate(end) as { rawOutput: { error: string } };
		expect(update.rawOutput.error.length).toBeLessThan(5000);
		expect(update.rawOutput.error).toContain("[truncated,");
	});

	test("does not turn a missing error result into the word null", () => {
		// Bounding must not change what the tool reported. An error with no
		// result stays null; only text is subject to the ceiling.
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: null,
			isError: true,
		} as unknown as AgentSessionEvent;
		const update = mapAssistantEventToSessionUpdate(end) as { rawOutput: { error: unknown } };
		expect(update.rawOutput.error).toBeNull();
	});

	test("wraps updates in a session notification", () => {
		const event = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "/repo/file" },
		} as unknown as AgentSessionEvent;
		expect(toSessionNotification("session-1", event)).toEqual({
			sessionId: "session-1",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "read /repo/file",
				name: "read",
				kind: "read",
				status: "pending",
				content: [],
				rawInput: { path: "/repo/file" },
			},
		});
	});
});

describe("acp permission results", () => {
	test("parses selected and cancelled outcomes", () => {
		expect(parseRequestPermissionResult({ outcome: { outcome: "cancelled" } })).toEqual({
			outcome: { outcome: "cancelled" },
		});
		expect(parseRequestPermissionResult({ outcome: { outcome: "selected", optionId: "allow_once" } })).toEqual({
			outcome: { outcome: "selected", optionId: "allow_once" },
		});
		expect(parseRequestPermissionResult({ outcome: {} })).toBeNull();
		// The parser stays a pass-through: it does not know which option ids the
		// mode offers, so a whitelist here would silently drop a new one.
		expect(parseRequestPermissionResult({ outcome: { outcome: "selected", optionId: "allow_always" } })).toEqual({
			outcome: { outcome: "selected", optionId: "allow_always" },
		});
		expect(parseRequestPermissionResult({ outcome: { outcome: "selected", optionId: "reject_always" } })).toEqual({
			outcome: { outcome: "selected", optionId: "reject_always" },
		});
	});
});

describe("acp mcp server conversion", () => {
	test("keeps stdio servers with their env and args", () => {
		const { declarations, rejected } = convertAcpMcpServers([
			{
				name: "filesystem",
				command: "/usr/bin/mcp-server",
				args: ["--root", "/repo"],
				env: [
					{ name: "TOKEN", value: "secret" },
					{ name: "MODE", value: "rw" },
				],
			},
		]);
		expect(declarations).toEqual({
			filesystem: {
				command: "/usr/bin/mcp-server",
				args: ["--root", "/repo"],
				env: { TOKEN: "secret", MODE: "rw" },
			},
		});
		expect(rejected).toEqual([]);
	});

	test("keeps http and sse servers with headers and drops only the unstable transport", () => {
		const { declarations, rejected } = convertAcpMcpServers([
			{ name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Key", value: "k" }] },
			{ name: "legacy", type: "sse", url: "https://mcp.example.com/sse" },
			{ name: "unstable", type: "acp" },
		]);
		expect(declarations).toEqual({
			remote: { url: "https://mcp.example.com/mcp", http_headers: { "X-Key": "k" } },
			legacy: { transport: "sse", url: "https://mcp.example.com/sse" },
		});
		expect(rejected).toEqual(["unstable"]);
	});

	test("marks an sse server with its transport and keeps its headers", () => {
		const { declarations, rejected } = convertAcpMcpServers([
			{ name: "legacy", type: "sse", url: "https://mcp.example.com/sse", headers: [{ name: "X-Key", value: "k" }] },
		]);
		expect(rejected).toEqual([]);
		// The transport has to travel with the declaration: the connector picks
		// the client class from it, and an SSE URL is indistinguishable from a
		// streamable-HTTP one.
		expect(declarations).toEqual({
			legacy: { transport: "sse", url: "https://mcp.example.com/sse", http_headers: { "X-Key": "k" } },
		});
	});

	test("rejects a url server that never named its transport", () => {
		const { declarations, rejected } = convertAcpMcpServers([{ name: "remote", url: "https://mcp.example.com/mcp" }]);
		// ACP v1 discriminates the union on `type`, so a `url` without one is not
		// a stdio server either. Reporting it beats spawning a bogus command.
		expect(declarations).toEqual({});
		expect(rejected).toEqual(["remote"]);
	});

	test("reports an sse server that names no url instead of dropping it", () => {
		const { declarations, rejected } = convertAcpMcpServers([
			{ name: "legacy", type: "sse" },
			{ name: "empty-legacy", type: "sse", url: "" },
		]);
		expect(declarations).toEqual({});
		expect(rejected).toEqual(["legacy", "empty-legacy"]);
	});

	test("reports entries that cannot start instead of dropping them silently", () => {
		const { declarations, rejected } = convertAcpMcpServers([
			{ name: "no-command" },
			{ name: "http-without-url", type: "http" },
			{ command: "/usr/bin/mcp" },
			"not-an-object",
		]);
		expect(declarations).toEqual({});
		expect(rejected).toEqual(["no-command", "http-without-url", "<unnamed>", "<invalid>"]);
	});

	test("treats a missing or non-array list as no servers", () => {
		expect(convertAcpMcpServers(undefined)).toEqual({ declarations: {}, rejected: [] });
		expect(convertAcpMcpServers([])).toEqual({ declarations: {}, rejected: [] });
		expect(convertAcpMcpServers("nope")).toEqual({ declarations: {}, rejected: [] });
	});

	test("rejects a non-array mcpServers field in session requests", () => {
		expect(validateNewSessionParams({ cwd: "/repo", mcpServers: {} }).ok).toBe(false);
		expect(validateLoadSessionParams({ sessionId: "s1", cwd: "/repo", mcpServers: {} }).ok).toBe(false);
		expect(validateNewSessionParams({ cwd: "/repo", mcpServers: [{ name: "a", command: "b" }] }).ok).toBe(true);
	});
});

describe("acp prompt normalization with embedded resources", () => {
	test("inlines text resources and preserves binary ones", () => {
		const normalized = normalizePrompt([
			{ type: "text", text: "look at this" },
			{ type: "resource", resource: { uri: "file:///repo/a.ts", mimeType: "text/plain", text: "const a = 1;" } },
			{ type: "resource", resource: { uri: "file:///repo/b.png", blob: "AAAA" } },
		]);
		expect(normalized.text).toBe(
			'look at this\n[[resource file:///repo/a.ts]]\nconst a = 1;\n<resource uri="file:///repo/b.png" mimeType="application/octet-stream" encoding="base64">AAAA</resource>',
		);
		expect(normalized.images).toEqual([]);
	});

	test("accepts embedded resource blocks and rejects empty ones", () => {
		expect(
			validatePromptParams({
				sessionId: "s1",
				prompt: [{ type: "resource", resource: { uri: "file:///repo/a.ts", text: "body" } }],
			}).ok,
		).toBe(true);
		expect(
			validatePromptParams({
				sessionId: "s1",
				prompt: [{ type: "resource", resource: { uri: "file:///repo/a.ts" } }],
			}).ok,
		).toBe(false);
	});
});

describe("acp elicitation responses", () => {
	test("reads an accepted answer with content", () => {
		expect(parseElicitationResult({ action: "accept", content: { value: "hello" } })).toEqual({
			action: "accept",
			content: { value: "hello" },
		});
	});

	test("treats decline and cancel as contentless", () => {
		expect(parseElicitationResult({ action: "decline" })).toEqual({ action: "decline" });
		expect(parseElicitationResult({ action: "cancel" })).toEqual({ action: "cancel" });
	});

	test("rejects an unknown action and a non-object accept payload", () => {
		expect(parseElicitationResult({ action: "maybe" })).toBeUndefined();
		expect(parseElicitationResult({ action: "accept", content: "text" })).toBeUndefined();
		expect(parseElicitationResult(null)).toBeUndefined();
	});
});

describe("acp mode and config option validation", () => {
	test("requires sessionId plus the value being set", () => {
		expect(validateSetSessionModeParams({ sessionId: "s1", modeId: "ask" }).ok).toBe(true);
		expect(validateSetSessionModeParams({ sessionId: "s1" }).ok).toBe(false);
		expect(validateSetSessionModeParams({ modeId: "ask" }).ok).toBe(false);
	});

	test("reads a string config value by default and a boolean when typed", () => {
		expect(validateSetSessionConfigOptionParams({ sessionId: "s1", optionId: "model", value: "step/x" })).toEqual({
			ok: true,
			value: { sessionId: "s1", optionId: "model", value: "step/x" },
		});
		expect(
			validateSetSessionConfigOptionParams({ sessionId: "s1", optionId: "flag", type: "boolean", value: true }).ok,
		).toBe(true);
	});

	test("rejects a mismatched value type and an unknown type", () => {
		expect(validateSetSessionConfigOptionParams({ sessionId: "s1", optionId: "model", value: true }).ok).toBe(false);
		expect(
			validateSetSessionConfigOptionParams({ sessionId: "s1", optionId: "flag", type: "boolean", value: "yes" }).ok,
		).toBe(false);
		expect(
			validateSetSessionConfigOptionParams({ sessionId: "s1", optionId: "flag", type: "number", value: 1 }).ok,
		).toBe(false);
	});
});

describe("acp initialize validation", () => {
	test("returns the client capabilities the mode branches on", () => {
		const parsed = validateInitializeParams({
			protocolVersion: 1,
			clientCapabilities: { elicitation: { form: {} }, auth: { terminal: true } },
		});
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && parsed.value.clientCapabilities?.elicitation?.form).toEqual({});
		expect(parsed.ok && parsed.value.clientCapabilities?.auth?.terminal).toBe(true);
	});

	test("rejects a malformed capability bag", () => {
		expect(validateInitializeParams({ protocolVersion: 1, clientCapabilities: [] }).ok).toBe(false);
		expect(validateInitializeParams({ protocolVersion: 1, clientCapabilities: { fs: 3 } }).ok).toBe(false);
	});
});

describe("acp turn error extraction", () => {
	/** Minimal shape of the assistant messages a turn leaves behind. */
	const messages = (list: unknown[]) => list as Parameters<typeof extractTurnError>[0];

	test("returns the error message of the last assistant message when the turn failed", () => {
		expect(
			extractTurnError(
				messages([
					{ role: "user", content: [] },
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "404: gone" },
				]),
			),
		).toBe("404: gone");
	});

	test("returns undefined for a turn that ended normally", () => {
		expect(
			extractTurnError(
				messages([
					{ role: "user", content: [] },
					{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				]),
			),
		).toBeUndefined();
	});

	test("does not replay an older failed turn onto a later successful one", () => {
		expect(
			extractTurnError(
				messages([
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
					{ role: "user", content: [] },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
				]),
			),
		).toBeUndefined();
	});

	test("falls back to a generic message when the engine recorded no detail", () => {
		expect(extractTurnError(messages([{ role: "assistant", content: [], stopReason: "error" }]))).toBe(
			"The turn ended with an error.",
		);
	});

	test("returns undefined when no assistant message exists yet", () => {
		expect(extractTurnError(messages([{ role: "user", content: [] }]))).toBeUndefined();
		expect(extractTurnError(messages([]))).toBeUndefined();
	});
});
