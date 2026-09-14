import { describe, it, expect, vi } from "vitest";
import {
  AgentTeam,
  type AgentTeamInboxStore,
  type TeamMessage,
} from "./agent-team.js";
import { AgentHarnessFactory } from "./harness.js";
import type { MemoryConfig } from "./conversation-memory.js";
import type { AgentRunConfig, CompletionResponse } from "@step-cli/protocol";
import { createMutableRef } from "@step-cli/utils/mutable-ref.js";

class MemoryInboxStore implements AgentTeamInboxStore {
  private readonly messages: TeamMessage[] = [];

  async append(message: TeamMessage): Promise<void> {
    this.messages.push(message);
  }

  async read(inboxName: string, sessionId?: string): Promise<TeamMessage[]> {
    return this.messages.filter((message) => {
      if (message.to !== inboxName) {
        return false;
      }
      if (!sessionId) {
        return true;
      }
      return message.sessionId === sessionId;
    });
  }
}

function makeMemoryConfig(): MemoryConfig {
  return {
    maxContextTokens: 128_000,
    reserveOutputTokens: 4096,
    minRecentMessages: 4,
    compressionTriggerRatio: 0.85,
    compressionTargetRatio: 0.6,
    maxSummaryChars: 2000,
    compactedUserMessageTokenBudget: 2000,
    maxCompactedUserMessages: 5,
    compactedUserMessageMaxChars: 500,
    maxDecisionEntries: 20,
    decisionEntryMaxChars: 200,
    microCompactKeepRecentToolMessages: 10,
    microCompactToolContentChars: 2000,
  };
}

function makeRunConfig(): AgentRunConfig {
  return {
    maxSteps: 4,
    temperature: 0,
    maxContextTokens: 128_000,
    maxOutputTokens: 4096,
    minOutputTokens: 256,
    outputTokenSafetyMargin: 512,
    parallelToolCalls: true,
    maxToolCallsPerStep: 5,
    repeatedToolCallLimit: 3,
    maxToolResultCharsInContext: 25_000,
    modelRequestRetries: 0,
    toolExecutionRetries: 0,
  };
}

function assistantReply(content: string): CompletionResponse {
  return {
    id: "cmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

function createTeam(store = new MemoryInboxStore()) {
  const factory = new AgentHarnessFactory({
    model: "test-model",
    client: {
      createChatCompletion: vi.fn().mockResolvedValue(assistantReply("done")),
    },
    defaultSystemPrompt: "You are a teammate.",
    memoryConfig: makeMemoryConfig(),
    runConfig: makeRunConfig(),
    commandTimeoutMs: 1_000,
    commandOutputLimit: 1_000,
    plugins: [],
    interactionProfile: { surface: "headless", canAskUser: false },
  });
  const harnessFactoryRef = createMutableRef<AgentHarnessFactory>(
    "AgentHarnessFactory",
  );
  harnessFactoryRef.set(factory);

  return {
    team: new AgentTeam({
      inboxStore: store,
      harnessFactoryRef,
    }),
    store,
    factory,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for condition");
}

describe("AgentTeam sleep abort", () => {
  it("rejects promptly when the caller aborts during readInbox wait", async () => {
    const { team } = createTeam();
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = team.readInbox({
      inboxName: "lead",
      reader: "lead",
      waitMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort("Run interrupted by user."), 30);

    await expect(pending).rejects.toThrow("Run interrupted by user.");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { team } = createTeam();
    const controller = new AbortController();
    controller.abort("Run interrupted by user.");
    const startedAt = Date.now();

    await expect(
      team.readInbox({
        inboxName: "lead",
        reader: "lead",
        waitMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Run interrupted by user.");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("removes the abort listener when sleep completes normally", async () => {
    const { team } = createTeam();
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");

    try {
      const result = await team.readInbox({
        inboxName: "lead",
        reader: "lead",
        waitMs: 80,
      });

      expect(result.messages).toEqual([]);
      const abortAdds = add.mock.calls.filter(([type]) => type === "abort");
      const abortRemoves = remove.mock.calls.filter(
        ([type]) => type === "abort",
      );
      expect(abortAdds.length).toBeGreaterThan(0);
      expect(abortRemoves.length).toBeGreaterThanOrEqual(abortAdds.length);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("wakes idle worker inbox waits when the team closes", async () => {
    const { team } = createTeam();
    await team.spawnTeammate({
      name: "researcher",
      role: "researcher",
      prompt: "Look this up",
      requester: "lead",
      parentId: "main",
      parentDepth: 0,
      workspaceRoot: "/tmp/workspace",
    });

    await waitFor(() => team.getTeammate("researcher")?.status === "idle");

    const startedAt = Date.now();
    await team.close({
      abortRunning: true,
      reason: "Agent team shutting down.",
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("interrupts worker claim-slot backoff when the team closes", async () => {
    const store = new MemoryInboxStore();
    let modelCalls = 0;
    const hangFactory = new AgentHarnessFactory({
      model: "test-model",
      client: {
        createChatCompletion: vi.fn().mockImplementation(() => {
          modelCalls += 1;
          if (modelCalls === 1) {
            return Promise.resolve(assistantReply("spawn complete"));
          }
          return new Promise(() => {});
        }),
      },
      defaultSystemPrompt: "You are a teammate.",
      memoryConfig: makeMemoryConfig(),
      runConfig: makeRunConfig(),
      commandTimeoutMs: 1_000,
      commandOutputLimit: 1_000,
      plugins: [],
      interactionProfile: { surface: "headless", canAskUser: false },
    });
    const harnessFactoryRef = createMutableRef<AgentHarnessFactory>(
      "AgentHarnessFactory",
    );
    harnessFactoryRef.set(hangFactory);
    const team = new AgentTeam({
      inboxStore: store,
      harnessFactoryRef,
    });

    await team.spawnTeammate({
      name: "coder",
      role: "coder",
      prompt: "Start work",
      requester: "lead",
      parentId: "main",
      parentDepth: 0,
      workspaceRoot: "/tmp/workspace",
    });
    await waitFor(() => team.getTeammate("coder")?.status === "idle");

    const hangingTurn = team.runTeammateTurn("coder", "Keep working");
    await waitFor(() => team.getTeammate("coder")?.status === "working");

    await team.sendMessage({
      from: "lead",
      to: "coder",
      content: "Follow-up assignment",
      sessionId: team.getTeammate("coder")?.sessionId,
    });

    // Worker idle wait is 800ms; after that claim-slot backoff sleeps up to 200ms.
    await new Promise((resolve) => setTimeout(resolve, 850));

    const startedAt = Date.now();
    await team.close({
      abortRunning: true,
      reason: "Run interrupted by user.",
    });
    expect(Date.now() - startedAt).toBeLessThan(300);
    void hangingTurn.catch(() => undefined);
  });
});
