// Fake `step --mode rpc` child for the subagent live-channel regression.
//
// Speaks the real framing (one JSON object per LF-framed line) and streams what
// a long child produces: text deltas, persisted messages, tool progress. Only
// its token stream is synthetic; everything it drives on the parent side is the
// production rpc adapter, parser, orchestration, agent loop and projections.
//
// Like the real CLI, progress frames are written only under
// `--include-live-events`, so a parent that forgets the flag gets no live view
// and the regression fails instead of passing on durable events alone.
const TURNS = Number(process.env.STREAM_TURNS ?? 6);
const DELTAS = Number(process.env.STREAM_DELTAS ?? 20);
const TOOL_BYTES = Number(process.env.STREAM_TOOL_BYTES ?? 4_000);
// A real child streams over seconds; the parent coalesces frames on a 100ms
// repaint window, so a child that finishes in a few milliseconds publishes only
// its first and last frame. Tests that assert streamed text must let the child
// outlive that window.
const DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 0);
// The real CLI writes `message_update`/`tool_execution_update` only when the
// caller opted in; a fixture that always emitted them would let a parent test
// pass even if the flag were never passed. Mirror the CLI: no flag, no frames.
const LIVE = process.argv.includes("--include-live-events");
/** Appears only in a progress frame, never in a final tool result. */
const PROGRESS_MARKER = "tool-progress-marker";

let buffer = "";
/** Frames must reach stdout in order, so handle() calls are serialized. */
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) queue = queue.then(() => handle(line.trim()));
});

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "step",
		model: "step-3.8-code-alpha",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: {} },
		stopReason,
		timestamp: Date.now(),
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(line) {
	if (!line) return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (command.type === "get_state") {
		write({
			type: "response",
			id: command.id,
			command: "get_state",
			success: true,
			data: { sessionFile: "/tmp/stream-child-session.jsonl" },
		});
		return;
	}
	if (command.type === "abort") {
		write({ type: "agent_settled" });
		return;
	}
	if (command.type !== "prompt") return;

	write({ type: "response", id: command.id, command: "prompt", success: true });
	write({ type: "agent_start" });

	const messages = [];
	for (let turn = 0; turn < TURNS; turn++) {
		write({ type: "turn_start" });
		write({ type: "message_start", message: assistant([]) });
		let text = "";
		for (let index = 0; index < DELTAS; index++) {
			const delta = `token-${turn}-${index} `;
			text += delta;
			if (LIVE) {
				write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
			}
			if (DELAY_MS > 0) await sleep(DELAY_MS);
		}
		const message = assistant([{ type: "text", text }], "toolUse");
		messages.push(message);
		write({ type: "message_end", message });

		const toolCallId = `call_${turn}`;
		const output = "x".repeat(TOOL_BYTES);
		write({ type: "tool_execution_start", toolCallId, toolName: "run_command", args: { command: `echo ${turn}` } });
		if (LIVE) {
			// A real tool's progress snapshot carries something the final result
			// does not: a counter, a spinner, a partial line. Marking it that way
			// lets a parent test prove it read a *frame* rather than the durable
			// value that `message_end` also provides.
			write({
				type: "tool_execution_update",
				toolCallId,
				toolName: "run_command",
				partialResult: {
					content: [{ type: "text", text: `${output}\nprogress ${PROGRESS_MARKER}` }],
				},
			});
			// A real tool's progress is observable for a while; without pacing the
			// start/update/end triple lands inside one repaint window and the parent
			// never publishes a frame mid-tool.
			if (DELAY_MS > 0) await sleep(DELAY_MS * 3);
		}
		const result = {
			role: "toolResult",
			toolCallId,
			toolName: "run_command",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: Date.now(),
		};
		messages.push(result);
		write({
			type: "tool_execution_end",
			toolCallId,
			toolName: "run_command",
			result: { content: [{ type: "text", text: output }] },
			isError: false,
		});
		write({ type: "message_end", message: result });
		write({ type: "turn_end" });
	}

	write({ type: "message_end", message: assistant([{ type: "text", text: "child done" }]) });
	write({ type: "agent_end" });
	write({ type: "agent_settled" });
}
