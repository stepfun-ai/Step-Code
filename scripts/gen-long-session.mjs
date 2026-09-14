/**
 * Generate a synthetic LONG (≈5-hour) Step session .jsonl so the "regular-mode
 * input freeze" can be reproduced live in a real terminal without spending 5h.
 *
 * It matches the on-disk schema (type:session header, model_change,
 * thinking_level_change, then chained message records) and writes into the
 * encoded-cwd sessions dir so `pnpm step` can resume it from the picker.
 *
 * Run: node scripts/gen-long-session.mjs [turns]   (default 900 turns ≈ 4k records)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const turns = Number(process.argv[2] || 900);
const cwd = "C:\\Users\\admin\\Desktop\\code\\cli-all\\step-harness";
// Encoded cwd dir name: path separators -> '-', wrapped in '--...--' (see memory).
const encoded = "--C--Users-admin-Desktop-code-cli-all-step-harness--";
const sessionsDir = path.join(homedir(), ".step-cli", "agent", "sessions", encoded);
mkdirSync(sessionsDir, { recursive: true });

const sessionId = randomUUID();
// Session spans 5 hours ending "now".
const endMs = Date.now();
const startMs = endMs - 5 * 60 * 60 * 1000;
const stepMs = Math.floor((endMs - startMs) / (turns * 4));
let clock = startMs;
const iso = (ms) => new Date(ms).toISOString();
const hid = () => randomUUID().slice(0, 8);

const out = [];
let parentId = null;
function push(rec) {
	out.push(JSON.stringify(rec));
	if (rec.id) parentId = rec.id;
}

push({ type: "session", version: 3, id: sessionId, timestamp: iso(clock), cwd });
push({ type: "model_change", id: hid(), parentId, timestamp: iso(clock), provider: "step", modelId: "step-3.7-flash" });
push({ type: "thinking_level_change", id: hid(), parentId, timestamp: iso(clock), thinkingLevel: "medium" });

const body =
	"Here is a detailed explanation of the change and why it is correct.\n" +
	"- Updated the guard clause to handle the empty-input path.\n" +
	"- Added a regression test and verified the suite is green.\n" +
	"- Considered the Windows-specific code path and confirmed parity.";

for (let t = 0; t < turns; t++) {
	clock += stepMs;
	const uid = hid();
	push({
		type: "message",
		id: uid,
		parentId,
		timestamp: iso(clock),
		message: {
			role: "user",
			content: [{ type: "text", text: `Turn ${t}: please refactor module ${t} and explain the reasoning in full detail.` }],
			timestamp: clock,
		},
	});

	clock += stepMs;
	const toolCallId = `chatcmpl-tool-${hid()}${hid()}`;
	const aid = hid();
	push({
		type: "message",
		id: aid,
		parentId,
		timestamp: iso(clock),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Working through turn ${t}: inspect files, plan the edit, keep it correct.`, thinkingSignature: hid() },
				{ type: "text", text: body },
				{ type: "toolCall", id: toolCallId, name: "read_file", arguments: { path: `packages/foo/src/mod-${t}.ts` } },
			],
			api: "anthropic-messages",
			provider: "step",
			model: "step-3.7-flash",
			usage: { input: 12000 + t, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 12200 + t, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheWrite1h: 0 },
			stopReason: "toolUse",
			timestamp: clock,
			responseId: `resp-${hid()}`,
			rawStopReason: "tool_use",
		},
	});

	clock += stepMs;
	push({
		type: "message",
		id: hid(),
		parentId,
		timestamp: iso(clock),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read_file",
			content: [{ type: "text", text: `contents of mod-${t}.ts\n`.repeat(6) }],
			isError: false,
			timestamp: clock,
		},
	});

	clock += stepMs;
	push({
		type: "message",
		id: hid(),
		parentId,
		timestamp: iso(clock),
		message: {
			role: "assistant",
			content: [{ type: "text", text: `Done with turn ${t}. Tests pass; the change is applied and verified.` }],
			api: "anthropic-messages",
			provider: "step",
			model: "step-3.7-flash",
			usage: { input: 12500 + t, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 12620 + t, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheWrite1h: 0 },
			stopReason: "endTurn",
			timestamp: clock,
			responseId: `resp-${hid()}`,
			rawStopReason: "stop",
		},
	});
}

const tsName = iso(startMs).replace(/[:.]/g, "-");
const file = path.join(sessionsDir, `${tsName}_${sessionId}.jsonl`);
writeFileSync(file, out.join("\n") + "\n");
console.log(`Wrote ${out.length} records (${turns} turns, ~5h span) to:\n${file}`);
console.log(`Session id: ${sessionId}`);
