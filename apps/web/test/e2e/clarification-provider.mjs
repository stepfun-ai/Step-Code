/** Local deterministic provider; exercises the real agent and clarify_user without paid APIs. */
export const clarificationQuestions = [
  {
    id: "app",
    question: "假设要在这个项目里改进一个页面，你想以哪个应用为例?",
    options: [
      { label: "国内开发者控制台 main（推荐）", value: "main" },
      { label: "海外开发者控制台 main-oversea", value: "main-oversea" },
      { label: "两个应用的共享组件", value: "shared" },
    ],
  },
  {
    id: "scope",
    question: "你希望先完成哪个部分？",
    options: [
      { label: "页面交互（推荐）", value: "interaction" },
      { label: "页面样式", value: "style" },
      { label: "两者一起", value: "both" },
    ],
  },
  {
    id: "decision",
    question: "假设进入实际开发，你希望 Codex 在什么情况下先问你?",
    options: [
      { label: "常规细节自行决定，影响用户体验的关键选择先问我（推荐）", value: "key" },
      { label: "先给出完整方案，等我选择后再动手", value: "plan" },
      { label: "目标明确后直接完成，遇到阻塞再问我", value: "finish" },
    ],
  },
];

/** Text of a chat message, whichever content shape the adapter produced. */
function messageText(message) {
  return Array.isArray(message.content)
    ? message.content.map((part) => part.text ?? "").join("\n")
    : String(message.content ?? "");
}

/**
 * The plan file the host names, so the fixture writes where plan mode allows.
 * The reminder quotes it; the `exit_plan_mode` result lists it bare.
 */
function planPathFrom(messages) {
  for (const message of [...messages].reverse()) {
    const match = /Plan file: (?:"((?:[^"\\]|\\.)*)"|(\S+))/u.exec(messageText(message));
    if (match) return match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`);
  }
  return undefined;
}

/** The request-local plan-mode reminder, appended to every model request while planning. */
function isPlanReminder(message) {
  return messageText(message).trimStart().startsWith("<system-reminder>Plan mode is ON.");
}

/** One streamed tool call, the shape the OpenAI adapter turns into a kernel tool call. */
function toolCallDelta(name, args, id) {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

/**
 * A reply delivered in several chunks, so the page has a live assistant row — one
 * with no entry id — on screen long enough to inspect while a turn streams.
 */
async function slowReply(input, response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (let index = 0; index < 12; index += 1) {
    const delta = { content: `streamed reply ${index}\n` };
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

/**
 * A reply that never finishes on its own: a thinking block followed by prose,
 * both streamed slowly until the client stops the turn. The request's own close
 * ends it, so an aborted turn does not keep the fixture writing.
 */
async function endlessReply(request, response, input) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  let closed = false
  request.on("close", () => {
    closed = true
  })
  const chunk = (delta) =>
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    )
  for (let index = 0; index < 600 && !closed; index += 1) {
    chunk(
      index < 8
        ? { reasoning_content: `thought ${index} ` }
        : { content: `reply ${index} ${"lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(2)}\n` },
    )
    await new Promise((resolve) => setTimeout(resolve, index < 8 ? 60 : 8))
  }
  if (closed) return
  response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
  response.end("data: [DONE]\n\n")
}

export async function clarificationCompletion(request, response) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const last = input.messages.at(-1);
  const text = messageText(last);
  const cancelled = last.role === "tool" && text.includes("User clarification cancelled");
  // The host also sends text-only calls (the session-title sidecar) that carry
  // no tools; they arrive after a turn, sometimes after this suite has finished,
  // so a `.find` on a missing list was an unhandled rejection in the run.
  const tools = Array.isArray(input.tools) ? input.tools : [];
  // A slow reply: the page must keep one prompt field while the live row exists.
  if (tools.length && last.role === "user" && text.includes("stream-fixture")) {
    await slowReply(input, response);
    return;
  }
  // A reply long enough to stop. The turn inspects the folder first, the way a
  // "explain this repository" prompt does, so the answer is the turn's second
  // assistant message and the page refreshes its snapshot mid-run: that read is
  // the one that can be overtaken by the stop.
  if (tools.length && input.messages.some((message) => messageText(message).includes("stop-fixture"))) {
    const read = tools.find((item) => item.function.name === "list_directory");
    if (last.role === "user" && read) {
      const call = toolCallDelta(read.function.name, { path: "." }, "stop-prelude");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: call, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    await endlessReply(request, response, input);
    return;
  }
  let delta;
  if (!tools.length) {
    delta = { content: "fixture text reply" };
  } else if (input.messages.some((message) => messageText(message).includes("plan-fixture"))) {
    // Plan mode: write the proposal where the host says it may, then submit it
    // once. The `exit_plan_mode` result is the only message that mentions plan
    // mode itself, which is how the fixture tells the two tool results apart.
    // The reminder trails every request, so the turn's own message is before it.
    const turn = [...input.messages].reverse().find((message) => !isPlanReminder(message)) ?? last;
    const turnText = messageText(turn);
    if (turn.role === "tool" && turnText.includes("Plan mode")) {
      delta = { content: "The proposal is submitted." };
    } else if (turn.role === "user") {
      const planPath = planPathFrom(input.messages);
      if (!planPath) throw new Error("plan fixture: the host named no plan file");
      delta = toolCallDelta("write_file", { path: planPath, content: "# Plan fixture\n\n1. Read the fixture files.\n" }, `plan-write-${input.messages.length}`);
    } else {
      delta = toolCallDelta("exit_plan_mode", {}, `plan-exit-${input.messages.length}`);
    }
  } else if (last.role === "user" && text.includes("approval-fixture")) {
    const tool = tools.find((item) => item.function.name === "bash") ?? tools.find((item) => item.function.name === "run_command");
    const path = text.includes("denied") ? "approval-denied.txt" : text.includes("remembered") ? "approval-remembered.txt" : "approval-result.txt";
    const command = `printf '%s\\n' '${"approval command preview ".repeat(24)}' > ${path}\n# exact-end-of-command`;
    delta = { tool_calls: [{ index: 0, id: `approval-call-${input.messages.length}`, type: "function", function: {
      name: tool.function.name, arguments: JSON.stringify({ command }),
    } }] };
  } else if (last.role === "user" && text.includes("delegate-subagent-fixture")) {
    // The parent delegates the write, so the approval has to come from the
    // child's own permission prompt rather than from the main session.
    delta = { tool_calls: [{ index: 0, id: `subagent-call-${input.messages.length}`, type: "function", function: {
      name: "subagent",
      arguments: JSON.stringify({ agent: "general", task: "create-sub-file: write hello into src/sub.txt" }),
    } }] };
  } else if (last.role === "user" && text.includes("create-sub-file")) {
    const write = tools.find((item) => item.function.name === "write_file") ?? tools.find((item) => item.function.name === "write");
    delta = { tool_calls: [{ index: 0, id: `subagent-write-${input.messages.length}`, type: "function", function: {
      name: write.function.name, arguments: JSON.stringify({ path: "src/sub.txt", content: "hello\n" }),
    } }] };
  } else if (last.role === "user") {
    const freeform = text.includes("freeform-only");
    delta = { tool_calls: [{ index: 0, id: "clarification-call", type: "function", function: {
      name: "clarify_user",
      arguments: JSON.stringify({ questions: freeform ? [{ id: "custom", question: "写下你的回答", allow_freeform: true }] : clarificationQuestions }),
    } }] };
  } else if (last.role === "tool" && text.includes("source:") && !cancelled) {
    const write = tools.find((tool) => tool.function.name === "write_file") ?? tools.find((tool) => tool.function.name === "write");
    delta = { tool_calls: [{ index: 0, id: "write-call", type: "function", function: {
      name: write.function.name, arguments: JSON.stringify({ path: "clarification-result.txt", content: text.replaceAll("\\n", "\n") }),
    } }] };
  } else delta = { content: cancelled ? "Clarification cancelled." : "Clarification received and saved." };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}
