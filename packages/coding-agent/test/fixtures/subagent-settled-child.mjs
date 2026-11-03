// Fake `step --mode rpc` child for the subagent settled-failure regression.
//
// Speaks the real framing (one JSON object per LF-framed line). It drives the
// parent's production rpc adapter: the only thing synthetic here is the child's
// event stream.
//
// The empty turn keeps `stop` on its assistant message — that is what the kernel
// does — so the run's outcome can only arrive on `agent_settled`. `SETTLED_MODE`
// selects the two shapes a real child can produce:
//
//   failure  — the run ended without an actionable answer
//   success  — a normal settled run, whose transcript is the only evidence
const MODE = process.env.SETTLED_MODE ?? "success";

let buffer = "";
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
			data: {
				sessionFile: `${process.env.TMPDIR ?? "/tmp/"}settled-child-session.jsonl`,
			},
		});
		return;
	}
	if (command.type !== "prompt") return;

	write({ type: "response", id: command.id, command: "prompt", success: true });
	write({ type: "agent_start" });
	write({ type: "turn_start" });

	const empty = assistant([]);
	write({ type: "message_start", message: empty });
	// The kernel classifies the turn and records it on the message it persists.
	empty.incomplete = "no_visible_output";
	write({ type: "message_end", message: empty });
	write({ type: "turn_end", messageRole: "assistant", toolResultCount: 0 });
	write({ type: "agent_end", willRetry: false, messageCount: 2 });

	if (MODE === "failure") {
		write({
			type: "agent_settled",
			failure: {
				kind: "incomplete_turn",
				reason: "no_visible_output",
				message: "The model returned no visible answer or executable tool call.",
			},
		});
		return;
	}
	write({ type: "agent_settled" });
}
