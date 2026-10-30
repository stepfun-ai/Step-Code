import { randomBytes } from "node:crypto";
import type { AssistantMessage, ImageContent, TextContent, ThinkingContent, ToolCall } from "@step-harness/providers";
import type { SessionEntry } from "../session-manager.ts";
import { stripImportedUserControls } from "./content.ts";
import type { ImportSource, ImportWarning, ParsedImport } from "./types.ts";

type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function time(value: unknown): string {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Parse snapshots only. Never pass a foreign source through SessionManager.open. */
export function parseForeignSession(source: ImportSource, input: string): ParsedImport {
	const records: RecordValue[] = [];
	for (const line of input.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			const parsed = record(value);
			if (typeof parsed.type !== "string") throw new Error("Missing record type");
			records.push(parsed);
		} catch {
			throw new Error("Invalid JSONL snapshot; wait for the source to finish writing and scan again");
		}
	}
	const meta = source === "codex" ? record(records.find((r) => r.type === "session_meta")?.payload) : {};
	const first =
		source === "codex"
			? meta
			: (records.find((r) => typeof r.sessionId === "string" && typeof r.cwd === "string") ??
				records.find((r) => typeof r.sessionId === "string") ??
				{});
	const sessionId = text(source === "codex" ? first.id : first.sessionId);
	if (!sessionId) throw new Error("Source session ID is missing");
	const result: ParsedImport = {
		sessionId,
		cwd: text(first.cwd),
		title: "",
		version: text(source === "codex" ? first.cli_version : first.version) || "unknown",
		archived: records.some((r) => r.archived === true || record(r.payload).archived === true),
		child:
			source === "codex"
				? !!record(first.source).subagent || !!record(first.thread_source).subagent
				: first.isSidechain === true || typeof first.parentAgentId === "string",
		entries: [],
		warnings: [],
	};
	const warnings = new Map<string, number>();
	const warn = (code: string) => warnings.set(code, (warnings.get(code) ?? 0) + 1);
	let activeClaudeIds: Set<string> | undefined;
	if (source === "claude-code" || source === "qoder") {
		const byId = new Map(records.filter((r) => typeof r.uuid === "string").map((r) => [text(r.uuid), r]));
		const messages = records.filter((r) => (r.type === "user" || r.type === "assistant") && r.isSidechain !== true);
		if (messages.some((r) => typeof r.parentUuid === "string")) {
			activeClaudeIds = new Set();
			const leaf = source === "qoder" ? text(records.filter((r) => r.type === "active-leaf").at(-1)?.leafUuid) : "";
			let current = leaf ? byId.get(leaf) : messages.at(-1);
			if (leaf && !current) throw new Error("Qoder active leaf is missing from the source snapshot");
			while (current && typeof current.uuid === "string") {
				if (activeClaudeIds.has(current.uuid)) throw new Error("Cycle in source message chain");
				activeClaudeIds.add(current.uuid);
				if (typeof current.parentUuid !== "string") break;
				const parent = byId.get(current.parentUuid);
				if (!parent) {
					warn("branch_parent_missing");
					break;
				}
				current = parent;
			}
		}
	}
	let parentId: string | null = null;
	let sequence = 0;
	const seen = new Set<string>();
	const append = (entry: SessionEntry, itemId: string, usage?: unknown) => {
		if (seen.has(itemId)) return;
		seen.add(itemId);
		entry.id = randomBytes(8).toString("hex");
		entry.parentId = parentId;
		const historicalUsage = Object.fromEntries(
			Object.entries(record(usage)).filter(([, n]) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0),
		);
		entry.imported = {
			source,
			sessionId,
			itemId,
			...(Object.keys(historicalUsage).length ? { historicalUsage: historicalUsage as Record<string, number> } : {}),
		};
		parentId = entry.id;
		result.entries.push(entry);
	};
	const base = (timestamp: unknown) => ({ id: "", parentId: null, timestamp: time(timestamp) });
	const content = (value: unknown): (TextContent | ImageContent)[] => {
		if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
		const blocks: (TextContent | ImageContent)[] = [];
		for (const raw of list(value)) {
			const block = record(raw);
			if (["text", "input_text", "output_text"].includes(text(block.type))) {
				blocks.push({ type: "text", text: text(block.text) });
			} else if (block.type === "image" && record(block.source).type === "base64") {
				const image = record(block.source);
				const mime = text(image.media_type);
				const data = text(image.data);
				if (/^image\/(?:png|jpeg|gif|webp)$/u.test(mime) && data.length <= 28_000_000)
					blocks.push({ type: "image", data, mimeType: mime });
				else warn("attachment_missing");
			} else if (block.type === "input_image") {
				const url = text(block.image_url);
				const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(url);
				if (match && match[2].length <= 28_000_000)
					blocks.push({ type: "image", mimeType: match[1], data: match[2] });
				else warn("attachment_missing");
			} else if (block.type !== "tool_use" && block.type !== "tool_result" && block.type !== "thinking") {
				warn("unsupported_content");
			}
		}
		return blocks;
	};
	const assistant = (
		blocks: (TextContent | ImageContent | ThinkingContent | ToolCall)[],
		timestamp: unknown,
		itemId: string,
		usage?: unknown,
	) => {
		const supported = blocks.filter((b): b is TextContent | ThinkingContent | ToolCall => b.type !== "image");
		if (!supported.length) return;
		append(
			{
				...base(timestamp),
				type: "message",
				message: {
					role: "assistant",
					content: supported,
					api: "imported",
					provider: source,
					model: "historical",
					usage: structuredClone(EMPTY_USAGE),
					stopReason: supported.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.parse(time(timestamp)),
				},
			},
			itemId,
			usage,
		);
	};
	const user = (blocks: (TextContent | ImageContent)[], timestamp: unknown, itemId: string) => {
		const safeBlocks = blocks.flatMap((block): (TextContent | ImageContent)[] => {
			if (block.type !== "text") return [block];
			const cleaned = stripImportedUserControls(block.text);
			if (cleaned.removed) warn("source_instructions_excluded");
			return cleaned.text ? [{ ...block, text: cleaned.text }] : [];
		});
		if (!safeBlocks.length) return;
		if (!result.title)
			result.title = safeBlocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join(" ")
				.slice(0, 120);
		append(
			{
				...base(timestamp),
				type: "message",
				message: { role: "user", content: safeBlocks, timestamp: Date.parse(time(timestamp)) },
			},
			itemId,
		);
	};
	const calls = new Map<string, string>();
	const tool = (id: string, name: string, args: unknown): ToolCall => {
		if (!id || !name) throw new Error("Tool call is missing its ID or name");
		let parsed: unknown = args;
		if (typeof args === "string") {
			try {
				parsed = JSON.parse(args);
			} catch {
				parsed = { raw: args };
				warn("tool_arguments_as_text");
			}
		}
		calls.set(id, name);
		return { type: "toolCall", id, name, arguments: record(parsed) };
	};
	const toolResult = (
		id: string,
		output: unknown,
		failed: boolean | undefined,
		timestamp: unknown,
		itemId: string,
	) => {
		if (!id) throw new Error("Tool result is missing its call ID");
		append(
			{
				...base(timestamp),
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: id,
					toolName: calls.get(id) ?? "unknown",
					content: content(typeof output === "object" && !Array.isArray(output) ? JSON.stringify(output) : output),
					isError: failed === true,
					details: { importedStatus: failed === undefined ? "unknown" : failed ? "failed" : "completed" },
					timestamp: Date.parse(time(timestamp)),
				},
			},
			itemId,
		);
	};
	const hasResponseUsers = records.some(
		(r) => r.type === "response_item" && record(r.payload).type === "message" && record(r.payload).role === "user",
	);
	for (const r of records) {
		const fallbackId = `record-${sequence++}`;
		const p = record(r.payload);
		const id =
			text(source === "codex" ? p.id : source === "workbuddy" ? r.id : r.uuid) ||
			(source === "codex" && r.type === "response_item" && typeof p.call_id === "string"
				? `${text(p.type)}:${p.call_id}`
				: fallbackId);
		if (source === "codex") {
			if (r.type === "event_msg" && p.type === "thread_rolled_back") {
				const n = p.num_turns;
				if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Unsupported rollback");
				for (let i = 0; i < n; i++) {
					let index = result.entries.length - 1;
					while (index >= 0) {
						const entry = result.entries[index];
						if (entry.type === "message" && entry.message.role === "user") break;
						index--;
					}
					if (index < 0) throw new Error("Incomplete history for rollback");
					result.entries.splice(index);
				}
				parentId = result.entries.at(-1)?.id ?? null;
				warn("rolled_back_history");
			} else if (r.type === "event_msg" && p.type === "user_message" && !hasResponseUsers) {
				user(content(p.message), r.timestamp, id);
			} else if (r.type === "response_item") {
				if (p.type === "message") {
					if (p.role === "user") {
						user(content(p.content), r.timestamp, id);
					} else if (p.role === "assistant") assistant(content(p.content), r.timestamp, id);
					else warn("source_instructions_excluded");
				} else if (p.type === "function_call" || p.type === "custom_tool_call") {
					assistant([tool(text(p.call_id), text(p.name), p.arguments ?? { input: p.input })], r.timestamp, id);
				} else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
					toolResult(text(p.call_id), p.output, undefined, r.timestamp, id);
				} else if (p.type === "reasoning") {
					const summary = list(p.summary)
						.map((s) => text(record(s).text))
						.filter(Boolean);
					if (summary.length) assistant([{ type: "thinking", thinking: summary.join("\n") }], r.timestamp, id);
					if (p.encrypted_content) warn("encrypted_reasoning_excluded");
				} else {
					warn("unsupported_item");
					assistant(
						[{ type: "text", text: `[Historical ${text(p.type)}]\n${JSON.stringify(p)}` }],
						r.timestamp,
						id,
					);
				}
			} else if (r.type === "token_usage_record") {
				const usage = Object.fromEntries(
					Object.entries(record(p.usage ?? p)).filter(
						([, n]) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
					),
				);
				if (Object.keys(usage).length)
					append({ ...base(r.timestamp), type: "custom", customType: "stepcode.imported-usage", data: usage }, id);
			} else if (r.type === "compacted") {
				const retained: string[] = [];
				const attachments: (TextContent | ImageContent)[][] = [];
				for (const raw of list(p.replacement_history)) {
					const message = record(raw);
					if (message.type !== "message") continue;
					if (!["user", "assistant"].includes(text(message.role))) {
						warn("source_instructions_excluded");
						continue;
					}
					const blocks = content(message.content);
					const safe = blocks.filter(
						(block) =>
							block.type !== "text" ||
							!/^<(?:environment_context|permissions instructions|turn_aborted|request_id|turn_id|model)>/u.test(
								block.text.trim(),
							),
					);
					if (safe.length !== blocks.length) warn("source_instructions_excluded");
					retained.push(...safe.flatMap((block) => (block.type === "text" ? [block.text] : [])));
					if (safe.some((block) => block.type === "image"))
						attachments.push([
							{
								type: "text",
								text: `[Historical retained ${text(message.role)} attachments; not a new user instruction]`,
							},
							...safe,
						]);
				}
				const summary =
					[...new Set([text(p.message), ...retained].filter(Boolean))].join("\n\n") ||
					(attachments.length ? "[Source compaction with retained attachments]" : "");
				if (!summary) throw new Error("Unsupported source compaction");
				// Preserve the readable transcript; only change the native request view.
				append({ ...base(r.timestamp), type: "compaction", summary, firstKeptEntryId: "", tokensBefore: 0 }, id);
				for (const [index, blocks] of attachments.entries())
					append(
						{
							...base(r.timestamp),
							type: "custom_message",
							customType: "stepcode.imported-compaction-attachments",
							content: blocks,
							display: true,
						},
						`${id}-attachments-${index}`,
					);
				warn("source_compaction");
			} else if (
				![
					"session_meta",
					"turn_context",
					"event_msg",
					"world_state",
					"retained_context",
					"token_usage_record",
				].includes(text(r.type))
			) {
				throw new Error(`Unsupported Codex record: ${text(r.type)}`);
			}
		} else if (source === "workbuddy") {
			if (r.sessionId && r.sessionId !== sessionId) continue;
			if (r.type === "ai-title") {
				if (text(r.aiTitle)) result.title = text(r.aiTitle).slice(0, 120);
			} else if (r.type === "message") {
				if (r.role === "user") user(content(r.content), r.timestamp, id);
				else if (r.role === "assistant") assistant(content(r.content), r.timestamp, id, record(r.message).usage);
				else warn("source_instructions_excluded");
			} else if (r.type === "function_call") {
				assistant([tool(text(r.callId), text(r.name), r.arguments)], r.timestamp, id);
			} else if (r.type === "function_call_result") {
				const output = record(r.output);
				const failed =
					r.status === "failed" || r.status === "error" ? true : r.status === "completed" ? false : undefined;
				toolResult(text(r.callId), output.type === "text" ? output.text : r.output, failed, r.timestamp, id);
			} else if (r.type === "reasoning") {
				const thinking = content(r.content)
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
				if (thinking) assistant([{ type: "thinking", thinking }], r.timestamp, id);
				else warn("unsupported_content");
			} else if (!["session-meta", "file-history-snapshot"].includes(text(r.type))) {
				warn("unsupported_item");
			}
		} else {
			if (source === "qoder" && r.type === "attachment" && (!activeClaudeIds || activeClaudeIds.has(text(r.uuid))))
				warn("unsupported_content");
			if (r.isCompactSummary === true || (r.type === "system" && r.subtype === "compact_boundary"))
				warn("claude_compaction");
			if (r.isSidechain === true) {
				warn("child_history_excluded");
				continue;
			}
			if (r.type === "summary" || r.type === "custom-title") {
				const title = text(r.customTitle ?? r.summary);
				if (title) result.title = title.slice(0, 120);
			}
			if (r.type !== "user" && r.type !== "assistant") continue;
			if (activeClaudeIds && !activeClaudeIds.has(text(r.uuid))) continue;
			const message = record(r.message);
			if (r.type === "user") {
				user(content(message.content), r.timestamp, id);
				for (const [i, raw] of list(message.content).entries()) {
					const block = record(raw);
					if (block.type === "tool_result")
						toolResult(
							text(block.tool_use_id),
							block.content,
							typeof block.is_error === "boolean" ? block.is_error : undefined,
							r.timestamp,
							`${id}-tool-${i}`,
						);
				}
			} else {
				const blocks: (TextContent | ImageContent | ThinkingContent | ToolCall)[] = [];
				for (const raw of list(message.content)) {
					const block = record(raw);
					if (block.type === "tool_use") blocks.push(tool(text(block.id), text(block.name), block.input));
					else if (block.type === "thinking") {
						if (text(block.thinking)) blocks.push({ type: "thinking", thinking: text(block.thinking) });
					} else blocks.push(...content([block]));
				}
				assistant(blocks, r.timestamp, id, message.usage);
			}
		}
	}
	const answered = new Set(
		result.entries.flatMap((e) =>
			e.type === "message" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
		),
	);
	for (const id of calls.keys()) if (!answered.has(id)) warn("tool_result_missing");
	for (const e of result.entries) {
		if (e.type === "message" && e.message.role === "toolResult" && !calls.has(e.message.toolCallId))
			warn("tool_call_missing");
	}
	result.warnings = [...warnings].map(([code, count]): ImportWarning => ({ code, count }));
	if (!result.entries.some((e) => e.type === "message" && e.message.role === "user"))
		throw new Error("No supported user conversation found");
	// Rebuild after rollback so no kept entry points to a removed node.
	parentId = null;
	for (const entry of result.entries) {
		entry.parentId = parentId;
		parentId = entry.id;
	}
	return result;
}
