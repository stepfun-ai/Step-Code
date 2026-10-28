// Fake `step --mode rpc` child used by the local amplification repro.
// It speaks the real rpc framing (one JSON object per LF-framed line) and
// replays what a child with a long streaming turn looks like: many text deltas,
// then a persisted assistant message, then a tool result.
const TURNS = Number(process.env.REPRO_TURNS ?? 20); // assistant turns in the child
const DELTAS = Number(process.env.REPRO_DELTAS ?? 60); // text deltas per turn
const TOOL_BYTES = Number(process.env.REPRO_TOOL_BYTES ?? 20_000); // child tool result size

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) handle(line.trim());
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
		usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: {} },
		stopReason,
		timestamp: Date.now(),
	};
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
		write({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionFile: "/tmp/child.jsonl" } });
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
			write({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			});
		}

		// The persisted assistant message, exactly as the real child sends it.
		const message = assistant([{ type: "text", text }], "toolUse");
		messages.push(message);
		write({ type: "message_end", message });

		// A tool call whose result the child accumulates into its transcript.
		const toolCallId = `call_${turn}`;
		write({
			type: "tool_execution_start",
			toolCallId,
			toolName: "run_command",
			args: { command: `echo ${turn}` },
		});
		const output = "x".repeat(TOOL_BYTES);
		write({ type: "tool_execution_update", toolCallId, toolName: "run_command", partialResult: output });
		const result = {
			role: "toolResult",
			toolCallId,
			toolName: "run_command",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: Date.now(),
		};
		messages.push(result);
		write({ type: "tool_execution_end", toolCallId, toolName: "run_command", result: { content: [{ type: "text", text: output }] }, isError: false });
		write({ type: "message_end", message: result });
		write({ type: "turn_end" });
	}

	write({ type: "message_end", message: assistant([{ type: "text", text: "child done" }]) });
	write({ type: "agent_end" });
	write({ type: "agent_settled" });
}
