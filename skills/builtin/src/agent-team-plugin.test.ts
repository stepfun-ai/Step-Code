import { describe, it, expect } from "vitest";
import { createAgentTeamPlugin } from "./agent-team-plugin.js";
import type {
  AgentTeamInboxStore,
  TeamMessage,
} from "@step-cli/core/agent/agent-team.js";
import type { AgentHarnessFactory } from "@step-cli/core/agent/harness.js";
import type { WorktreeManager } from "@step-cli/core/agent/worktree-manager.js";
import type { ToolPluginContext } from "@step-cli/core/plugins/types.js";
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

function mainPluginContext(): ToolPluginContext {
  return {
    workspaceRoot: "/tmp/workspace",
    interactionProfile: { surface: "headless", canAskUser: false },
    harness: {
      kind: "main",
      name: "main",
      depth: 0,
      sessionId: "main-session",
      goalId: "main:root",
      executionProfile: {
        workspaceMode: "shared",
        memoryMode: "session",
        priority: "interactive",
      },
    },
  };
}

describe("agent-team-plugin read_inbox abort wiring", () => {
  it("forwards the tool abort signal into team.readInbox waits", async () => {
    const plugin = createAgentTeamPlugin(
      createMutableRef<AgentHarnessFactory>("AgentHarnessFactory"),
      new MemoryInboxStore(),
      {} as WorktreeManager,
    );
    const tools = plugin.register(mainPluginContext());
    const readInbox = tools.find(
      (tool) => tool.definition.function.name === "read_inbox",
    );
    expect(readInbox).toBeDefined();

    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = readInbox!.execute(
      { waitMs: 5_000 },
      {
        workspaceRoot: "/tmp/workspace",
        commandTimeoutMs: 1_000,
        commandOutputLimit: 1_000,
        signal: controller.signal,
      },
      {} as never,
    );

    setTimeout(() => controller.abort("Run interrupted by user."), 30);

    await expect(pending).rejects.toThrow("Run interrupted by user.");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
