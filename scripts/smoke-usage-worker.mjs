#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanUsageOverview } from "../packages/coding-agent/dist/bundle/index.js";

// Run after build:offline. --benchmark uses the annual-index acceptance fixture.
const files = process.argv.includes("--benchmark") ? 10000 : 4;
const root = mkdtempSync(join(tmpdir(), "step-usage-worker-"));
const sessions = join(root, "sessions");
mkdirSync(sessions);
let ticker;
try {
	const timestamp = new Date().toISOString();
	let bytes = 0;
	for (let i = 0; i < files; i++) {
		const sessionId = `session-${i}`;
		const rows = [
			{ type: "session", id: sessionId, cwd: root, timestamp },
			{ type: "custom", id: "cap", customType: "step.activity_capabilities", timestamp, data: { version: 1, sessionId, sessionRole: "user" } },
			{ type: "message", id: "usage", timestamp, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(32768) }], usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 10 } } },
		];
		const line = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		bytes += Buffer.byteLength(line);
		writeFileSync(join(sessions, `${i}.jsonl`), line);
	}
	const gaps = [];
	let last = performance.now();
	ticker = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 10);
	const scan = (signal = new AbortController().signal) => scanUsageOverview([sessions], join(root, "cache"), root, "all", signal);
	const start = performance.now(), first = await scan(), fullMs = performance.now() - start;
	const cachedStart = performance.now(), cached = await scan(), cacheMs = performance.now() - cachedStart;
	assert.equal(first.tokens, files * 135); assert.equal(cached.tokens, first.tokens); assert.equal(first.chats, files);
	assert(!first.limited.includes("File inventory budget exceeded"));
	const controller = new AbortController(), cancelStart = performance.now(), pending = scan(controller.signal);
	setTimeout(() => controller.abort(), files === 4 ? 0 : 20);
	await assert.rejects(pending, /cancelled/u);
	gaps.sort((a, b) => a - b);
	console.log(JSON.stringify({ files, MiB: bytes / 1024 / 1024, fullMs, cacheMs, cancelMs: performance.now() - cancelStart, mainThreadTickP95: gaps[Math.floor(gaps.length * 0.95)], rssMiB: process.memoryUsage().rss / 1024 / 1024, tokens: first.tokens, chats: first.chats, coverage: first.limited }, null, 2));
} finally {
	clearInterval(ticker);
	rmSync(root, { recursive: true, force: true });
}
