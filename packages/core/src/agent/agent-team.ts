import { randomUUID } from "node:crypto";
import {
  resolveAgentPreset,
  type AgentPresetRegistry,
} from "./agent-presets.js";
import {
  AgentHarnessFactory,
  type AgentHarness,
  type AgentHarnessOptions,
} from "./harness.js";
import type { AgentRunResult } from "./agent-loop.js";
import type { ConversationMemoryState } from "./conversation-memory.js";
import {
  cloneExecutionProfile,
  isExecutionProfile,
} from "./harness-context.js";
import type { AgentExecutionProfile } from "../runtime-context-types.js";
import {
  type AgentRunArtifactStore,
  persistAgentRunArtifact,
  renderAgentRunArtifactNotice,
  renderAgentRunInlineNotice,
} from "./run-artifact-store.js";
import { compileTeammateHarness } from "./scaffolding.js";

import type { UserTurnInput } from "@step-cli/protocol";
import type { ToolRuntimeState } from "../tools/runtime.js";
import { toErrorMessage } from "@step-cli/utils/error.js";
import { clamp } from "@step-cli/utils/math.js";
import type { MutableRef } from "@step-cli/utils/mutable-ref.js";

export type TeamMessageType =
  | "message"
  | "broadcast"
  | "announcement"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval_request"
  | "plan_approval_response";

export type TeammateStatus = "idle" | "working" | "shutdown" | "error";

export interface TeamMessage {
  id: string;
  type: TeamMessageType;
  from: string;
  to: string;
  content: string;
  at: string;
  sessionId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamReadResult {
  messages: TeamMessage[];
  remaining: number;
  total: number;
}

export interface AgentTeamInboxStore {
  append(message: TeamMessage): Promise<void>;
  read(inboxName: string, sessionId?: string): Promise<TeamMessage[]>;
}

export interface TeamTeammateInfo {
  name: string;
  role: string;
  lead: string;
  status: TeammateStatus;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  depth: number;
  parentId?: string;
  sessionId: string;
  goalId: string;
  executionProfile: AgentExecutionProfile;
}

export type TeamProtocolKind = "shutdown" | "plan_approval";

export type TeamProtocolStatus = "pending" | "approved" | "rejected";

export interface TeamProtocolRequest {
  requestId: string;
  kind: TeamProtocolKind;
  from: string;
  to: string;
  status: TeamProtocolStatus;
  content: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  response?: string;
}

export interface AgentTeamState {
  version: 4;
  cursors: Record<string, Record<string, number>>;
  teammates: SerializedTeammate[];
  shutdownRequests: TeamProtocolRequest[];
  planRequests: TeamProtocolRequest[];
}

export interface SpawnTeammateInput {
  name: string;
  role?: string;
  preset?: string;
  prompt: string;
  requester: string;
  parentId: string;
  parentDepth: number;
  workspaceRoot: string;
  sessionId?: string;
  goalId?: string;
  executionProfile?: AgentExecutionProfile;
  allowedTools?: string[];
}

interface SerializedTeammate {
  name: string;
  role: string;
  lead: string;
  status: TeammateStatus;
  workspaceRoot: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  depth: number;
  parentId?: string;
  sessionId?: string;
  goalId?: string;
  executionProfile?: AgentExecutionProfile;
  allowedTools?: string[];
  memory: ConversationMemoryState;
  toolRuntime: ToolRuntimeState;
}

interface LiveTeammate extends TeamTeammateInfo {
  harness: AgentHarness;
  systemPrompt: string;
  worker?: Promise<void>;
  shutdownAfterTurn: boolean;
}

interface ActiveTeammateRun {
  controller: AbortController;
  kind: "worker" | "foreground";
}

const WORKER_IDLE_WAIT_MS = 800;
const MAX_READ_LIMIT = 200;

export type TeammateHooksFactory = (
  name: string,
) => AgentHarnessOptions["hooks"] | undefined;

export class AgentTeam {
  private readonly inboxStore: AgentTeamInboxStore;
  private readonly harnessFactoryRef: MutableRef<AgentHarnessFactory>;
  private readonly artifactStore?: AgentRunArtifactStore;
  private readonly presetRegistry?: AgentPresetRegistry;
  private readonly teammateHooksFactory?: TeammateHooksFactory;
  private readonly teammates = new Map<string, LiveTeammate>();
  private readonly activeRuns = new Map<string, ActiveTeammateRun>();
  private readonly shutdownRequests = new Map<string, TeamProtocolRequest>();
  private readonly planRequests = new Map<string, TeamProtocolRequest>();
  private readonly abortController = new AbortController();
  private cursors: Record<string, Record<string, number>> = {};
  private closePromise: Promise<void> | null = null;

  constructor(input: {
    inboxStore: AgentTeamInboxStore;
    harnessFactoryRef: MutableRef<AgentHarnessFactory>;
    artifactStore?: AgentRunArtifactStore;
    presetRegistry?: AgentPresetRegistry;
    teammateHooksFactory?: TeammateHooksFactory;
  }) {
    this.inboxStore = input.inboxStore;
    this.harnessFactoryRef = input.harnessFactoryRef;
    this.artifactStore = input.artifactStore;
    this.presetRegistry = input.presetRegistry;
    this.teammateHooksFactory = input.teammateHooksFactory;
  }

  async spawnTeammate(
    input: SpawnTeammateInput,
  ): Promise<{ teammate: TeamTeammateInfo; warnings?: string[] }> {
    const name = normalizeInboxName(input.name);
    const preset = resolveAgentPreset(
      this.presetRegistry,
      "teammate",
      input.preset,
    );
    const role = input.role?.trim() || preset?.defaultRole?.trim();
    const requester = normalizeInboxName(input.requester);
    const now = new Date().toISOString();

    if (!role) {
      throw new Error(
        "Teammate role is required. Provide role explicitly or use a preset with a default role.",
      );
    }

    let teammate = this.teammates.get(name);
    const warnings: string[] = [];

    if (!teammate || teammate.status === "shutdown") {
      const factory = this.harnessFactoryRef.get();
      const sessionId = input.sessionId?.trim() || randomUUID();
      const goalId = input.goalId?.trim() || `main:root/teammate:${name}`;
      const created = compileTeammateHarness(factory, {
        id: `teammate:${name}`,
        name,
        role,
        lead: requester,
        depth: input.parentDepth + 1,
        parentId: input.parentId,
        workspaceRoot: input.workspaceRoot,
        sessionId,
        goalId,
        executionProfile: input.executionProfile,
        presetRegistry: this.presetRegistry,
        preset: input.preset,
        allowedTools: input.allowedTools,
        approvalHandler: async () => "deny",
        hooks: this.teammateHooksFactory?.(name),
      });

      warnings.push(...created.warnings);
      const harnessExecutionProfile = cloneExecutionProfile(
        created.harness.getContext().executionProfile,
      );
      teammate = {
        name,
        role,
        lead: requester,
        status: "idle",
        workspaceRoot: input.workspaceRoot,
        createdAt: now,
        updatedAt: now,
        depth: input.parentDepth + 1,
        parentId: input.parentId,
        sessionId,
        goalId,
        executionProfile: harnessExecutionProfile,
        harness: created.harness,
        systemPrompt: created.systemPrompt,
        shutdownAfterTurn: false,
      };
      this.teammates.set(name, teammate);
    } else {
      if (input.preset?.trim()) {
        warnings.push(
          `Teammate '${name}' already exists. Presets only apply when creating a new persistent teammate.`,
        );
      }
      if (teammate.role !== role) {
        warnings.push(
          `Teammate '${name}' already exists with role '${teammate.role}'. Keeping the existing role for this persistent agent.`,
        );
      }

      teammate.lead = requester;
      teammate.updatedAt = now;
      teammate.shutdownAfterTurn = false;
    }

    teammate.status = "working";
    teammate.updatedAt = now;

    await this.sendMessage({
      from: requester,
      to: name,
      content: input.prompt,
      type: "message",
      sessionId: teammate.sessionId,
      metadata: {
        spawn: true,
      },
    });

    this.ensureWorker(name);

    return {
      teammate: this.toInfo(teammate),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async sendMessage(input: {
    from: string;
    to: string;
    content: string;
    type?: TeamMessageType;
    sessionId?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TeamMessage> {
    const from = normalizeInboxName(input.from);
    const to = normalizeInboxName(input.to);
    const type = input.type ?? "message";
    const sessionId = normalizeSessionId(input.sessionId);

    const message: TeamMessage = {
      id: randomUUID().slice(0, 12),
      type,
      from,
      to,
      content: input.content,
      at: new Date().toISOString(),
      sessionId,
      requestId: input.requestId,
      metadata: input.metadata,
    };

    await this.inboxStore.append(message);
    return message;
  }

  async readInbox(input: {
    inboxName: string;
    reader: string;
    sessionId?: string;
    markRead?: boolean;
    limit?: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<TeamReadResult> {
    const inboxName = normalizeInboxName(input.inboxName);
    const reader = normalizeInboxName(input.reader);
    const sessionId = normalizeSessionId(input.sessionId);
    const markRead = input.markRead ?? true;
    const limit = clamp(input.limit ?? MAX_READ_LIMIT, 1, MAX_READ_LIMIT);
    const waitMs = clamp(input.waitMs ?? 0, 0, 60_000);
    const deadline = Date.now() + waitMs;
    const combined = combineAbortSignals(
      input.signal,
      this.abortController.signal,
    );

    try {
      while (true) {
        const messages = await this.loadInboxMessages(inboxName, sessionId);
        const start = this.getCursor(reader, inboxName, sessionId);
        const available = messages.slice(start);

        if (available.length > 0 || waitMs === 0 || Date.now() >= deadline) {
          const selected = available.slice(0, limit);
          if (markRead) {
            this.setCursor(
              reader,
              inboxName,
              start + selected.length,
              sessionId,
            );
          }
          return {
            messages: selected,
            remaining: Math.max(0, available.length - selected.length),
            total: messages.length,
          };
        }

        await sleep(
          Math.min(WORKER_IDLE_WAIT_MS, Math.max(50, deadline - Date.now())),
          combined.signal,
        );
      }
    } finally {
      combined.dispose();
    }
  }

  listTeammates(): TeamTeammateInfo[] {
    return [...this.teammates.values()]
      .map((entry) => this.toInfo(entry))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getTeammate(name: string): TeamTeammateInfo | null {
    const teammate = this.teammates.get(normalizeInboxName(name));
    return teammate ? this.toInfo(teammate) : null;
  }

  getTeammateConversationState(name: string): ConversationMemoryState | null {
    const teammate = this.teammates.get(normalizeInboxName(name));
    return teammate ? teammate.harness.getMemory().exportState() : null;
  }

  async close(
    options: {
      abortRunning?: boolean;
      reason?: string;
    } = {},
  ): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    const reason = options.reason?.trim() || "Agent team shutting down.";
    this.closePromise = (async () => {
      if (!this.abortController.signal.aborted) {
        this.abortController.abort(reason);
      }

      const shutdownAt = new Date().toISOString();

      for (const teammate of this.teammates.values()) {
        teammate.shutdownAfterTurn = true;
        teammate.updatedAt = shutdownAt;
        if (!this.activeRuns.has(teammate.name)) {
          teammate.status = "shutdown";
        }
      }

      if (options.abortRunning) {
        for (const run of this.activeRuns.values()) {
          if (!run.controller.signal.aborted) {
            run.controller.abort(reason);
          }
        }
      }

      const workerPromises = [...this.teammates.values()]
        .map((teammate) => teammate.worker)
        .filter((worker): worker is Promise<void> => Boolean(worker));
      if (workerPromises.length > 0) {
        await Promise.allSettled(workerPromises);
      }

      for (const teammate of this.teammates.values()) {
        if (this.activeRuns.has(teammate.name)) {
          continue;
        }
        teammate.status = "shutdown";
        finalizeTeammateHarness(teammate);
      }
    })();

    await this.closePromise;
  }

  async runTeammateTurn(
    name: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
  async runTeammateTurn(
    name: string,
    prompt: UserTurnInput,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
  async runTeammateTurn(
    name: string,
    prompt: string | UserTurnInput,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const teammateName = normalizeInboxName(name);
    const teammate = this.teammates.get(teammateName);

    if (!teammate || teammate.status === "shutdown") {
      throw new Error(`Teammate '${teammateName}' is not available`);
    }

    const run = this.claimRunSlot(teammateName, "foreground");
    if (!run) {
      throw new Error(`Teammate '${teammateName}' is already running`);
    }

    teammate.status = "working";
    teammate.updatedAt = new Date().toISOString();

    const combinedSignal = combineAbortSignals(signal, run.controller.signal);

    try {
      const result = await teammate.harness.run(prompt, combinedSignal.signal);
      teammate.updatedAt = new Date().toISOString();
      teammate.status = teammate.shutdownAfterTurn ? "shutdown" : "idle";
      if (teammate.shutdownAfterTurn) {
        finalizeTeammateHarness(teammate);
      }
      return result;
    } catch (error) {
      teammate.updatedAt = new Date().toISOString();
      if (teammate.shutdownAfterTurn) {
        teammate.status = "shutdown";
        finalizeTeammateHarness(teammate);
      } else if (
        isInterruptError(error) ||
        run.controller.signal.aborted ||
        signal?.aborted
      ) {
        teammate.status = "idle";
      } else {
        teammate.status = "error";
      }
      throw error;
    } finally {
      combinedSignal.dispose();
      this.releaseRunSlot(teammateName, run.controller);
      if (!teammate.shutdownAfterTurn && teammate.status !== "shutdown") {
        this.ensureWorker(teammateName);
      }
    }
  }

  interruptTeammate(name: string): boolean {
    const teammateName = normalizeInboxName(name);
    const run = this.activeRuns.get(teammateName);
    if (!run || run.controller.signal.aborted) {
      return false;
    }

    run.controller.abort("Run interrupted by user.");
    return true;
  }

  async requestShutdown(input: {
    from: string;
    to: string;
    content?: string;
    requestId?: string;
    sessionId?: string;
  }): Promise<{ request: TeamProtocolRequest; message: TeamMessage }> {
    const from = normalizeInboxName(input.from);
    const to = normalizeInboxName(input.to);
    const teammate = this.teammates.get(to);

    if (!teammate || teammate.status === "shutdown") {
      throw new Error(`Teammate '${to}' is not active`);
    }

    const requestId = normalizeRequestId(input.requestId, "shutdown");
    const now = new Date().toISOString();
    const content =
      input.content?.trim() || "Please shut down after your current turn.";
    this.ensureRequestIdAvailable(requestId);

    const request: TeamProtocolRequest = {
      requestId,
      kind: "shutdown",
      from,
      to,
      status: "pending",
      content,
      createdAt: now,
      updatedAt: now,
      sessionId: normalizeSessionId(input.sessionId),
    };

    this.shutdownRequests.set(requestId, request);
    const message = await this.sendMessage({
      from,
      to,
      content,
      type: "shutdown_request",
      sessionId: request.sessionId,
      requestId,
      metadata: {
        kind: "shutdown",
      },
    });
    this.ensureWorker(to);

    return {
      request: { ...request },
      message,
    };
  }

  async respondShutdown(input: {
    from: string;
    requestId: string;
    approve: boolean;
    content?: string;
    sessionId?: string;
  }): Promise<{ request: TeamProtocolRequest; message: TeamMessage }> {
    const from = normalizeInboxName(input.from);
    const requestId = normalizeRequestId(input.requestId);
    const request = this.requireProtocolRequest(
      this.shutdownRequests,
      requestId,
      "shutdown",
    );

    if (request.to !== from) {
      throw new Error(
        `Shutdown request '${requestId}' is assigned to '${request.to}', not '${from}'`,
      );
    }

    const now = new Date().toISOString();
    request.status = input.approve ? "approved" : "rejected";
    request.updatedAt = now;
    request.response =
      input.content?.trim() ||
      (input.approve ? "Shutdown approved." : "Shutdown rejected.");

    const teammate = this.teammates.get(from);
    if (teammate && input.approve) {
      teammate.shutdownAfterTurn = true;
      teammate.updatedAt = now;
    }

    const message = await this.sendMessage({
      from,
      to: request.from,
      content: request.response,
      type: "shutdown_response",
      sessionId: request.sessionId ?? normalizeSessionId(input.sessionId),
      requestId,
      metadata: {
        approve: input.approve,
      },
    });

    return {
      request: { ...request },
      message,
    };
  }

  async requestPlanApproval(input: {
    from: string;
    to: string;
    content: string;
    requestId?: string;
    sessionId?: string;
  }): Promise<{ request: TeamProtocolRequest; message: TeamMessage }> {
    const from = normalizeInboxName(input.from);
    const to = normalizeInboxName(input.to);
    const requestId = normalizeRequestId(input.requestId, "plan");
    const now = new Date().toISOString();
    const content = input.content.trim();

    if (!content) {
      throw new Error("Plan approval content must not be empty");
    }
    this.ensureRequestIdAvailable(requestId);

    const request: TeamProtocolRequest = {
      requestId,
      kind: "plan_approval",
      from,
      to,
      status: "pending",
      content,
      createdAt: now,
      updatedAt: now,
      sessionId: normalizeSessionId(input.sessionId),
    };

    this.planRequests.set(requestId, request);
    const message = await this.sendMessage({
      from,
      to,
      content,
      type: "plan_approval_request",
      sessionId: request.sessionId,
      requestId,
      metadata: {
        kind: "plan_approval",
      },
    });

    return {
      request: { ...request },
      message,
    };
  }

  async respondPlanApproval(input: {
    from: string;
    requestId: string;
    approve: boolean;
    content?: string;
    sessionId?: string;
  }): Promise<{ request: TeamProtocolRequest; message: TeamMessage }> {
    const from = normalizeInboxName(input.from);
    const requestId = normalizeRequestId(input.requestId);
    const request = this.requireProtocolRequest(
      this.planRequests,
      requestId,
      "plan_approval",
    );

    if (request.to !== from) {
      throw new Error(
        `Plan approval request '${requestId}' is assigned to '${request.to}', not '${from}'`,
      );
    }

    const now = new Date().toISOString();
    request.status = input.approve ? "approved" : "rejected";
    request.updatedAt = now;
    request.response =
      input.content?.trim() ||
      (input.approve ? "Plan approved." : "Plan rejected.");

    const message = await this.sendMessage({
      from,
      to: request.from,
      content: request.response,
      type: "plan_approval_response",
      sessionId: request.sessionId ?? normalizeSessionId(input.sessionId),
      requestId,
      metadata: {
        approve: input.approve,
      },
    });

    return {
      request: { ...request },
      message,
    };
  }

  exportState(): AgentTeamState {
    return {
      version: 4,
      cursors: cloneCursorState(this.cursors),
      teammates: [...this.teammates.values()]
        .map((entry) => {
          const harnessState = entry.harness.exportState();
          return {
            name: entry.name,
            role: entry.role,
            lead: entry.lead,
            status: entry.status,
            workspaceRoot: entry.workspaceRoot,
            systemPrompt: entry.systemPrompt,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            depth: entry.depth,
            parentId: entry.parentId,
            sessionId: entry.sessionId,
            goalId: entry.goalId,
            executionProfile: cloneExecutionProfile(
              harnessState.identity.executionProfile,
            ),
            allowedTools: [...harnessState.allowedTools],
            memory: harnessState.memory,
            toolRuntime: harnessState.toolRuntime,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      shutdownRequests: [...this.shutdownRequests.values()].sort(
        (left, right) => left.requestId.localeCompare(right.requestId),
      ),
      planRequests: [...this.planRequests.values()].sort((left, right) =>
        left.requestId.localeCompare(right.requestId),
      ),
    };
  }

  loadState(state: unknown): void {
    for (const teammate of this.teammates.values()) {
      finalizeTeammateHarness(teammate);
    }
    for (const run of this.activeRuns.values()) {
      if (!run.controller.signal.aborted) {
        run.controller.abort("Teammate state reloaded.");
      }
    }

    const parsed = parseTeamState(state);
    this.teammates.clear();
    this.activeRuns.clear();
    this.shutdownRequests.clear();
    this.planRequests.clear();
    this.cursors = {};

    if (!parsed) {
      return;
    }

    this.cursors = cloneCursorState(parsed.cursors);

    for (const request of parsed.shutdownRequests) {
      this.shutdownRequests.set(request.requestId, request);
    }
    for (const request of parsed.planRequests) {
      this.planRequests.set(request.requestId, request);
    }

    for (const snapshot of parsed.teammates) {
      const factory = this.harnessFactoryRef.get();
      const sessionId = snapshot.sessionId?.trim() || randomUUID();
      const goalId =
        snapshot.goalId?.trim() || `main:root/teammate:${snapshot.name}`;
      const created = compileTeammateHarness(factory, {
        id: `teammate:${snapshot.name}`,
        name: snapshot.name,
        role: snapshot.role,
        lead: snapshot.lead,
        depth: snapshot.depth,
        parentId: snapshot.parentId,
        workspaceRoot: snapshot.workspaceRoot,
        sessionId,
        goalId,
        executionProfile: snapshot.executionProfile,
        systemPrompt: snapshot.systemPrompt,
        allowedTools: snapshot.allowedTools,
        memoryState: snapshot.memory,
        toolRuntimeState: snapshot.toolRuntime,
        approvalHandler: async () => "deny",
        hooks: this.teammateHooksFactory?.(snapshot.name),
      });

      const harnessExecutionProfile = cloneExecutionProfile(
        created.harness.getContext().executionProfile,
      );
      const teammate: LiveTeammate = {
        name: snapshot.name,
        role: snapshot.role,
        lead: snapshot.lead,
        status: snapshot.status === "shutdown" ? "shutdown" : "idle",
        workspaceRoot: snapshot.workspaceRoot,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        depth: snapshot.depth,
        parentId: snapshot.parentId,
        sessionId,
        goalId,
        executionProfile: harnessExecutionProfile,
        harness: created.harness,
        systemPrompt: created.systemPrompt,
        shutdownAfterTurn: false,
      };

      this.teammates.set(snapshot.name, teammate);
      if (teammate.status !== "shutdown") {
        this.ensureWorker(snapshot.name);
      }
    }
  }

  private ensureWorker(name: string): void {
    const teammate = this.teammates.get(name);
    if (!teammate || teammate.worker || teammate.status === "shutdown") {
      return;
    }

    teammate.worker = this.workerLoop(name).finally(() => {
      const latest = this.teammates.get(name);
      if (latest) {
        latest.worker = undefined;
      }
    });
  }

  private async workerLoop(name: string): Promise<void> {
    while (true) {
      const teammate = this.teammates.get(name);
      if (!teammate) {
        return;
      }

      if (teammate.status === "shutdown") {
        finalizeTeammateHarness(teammate);
        return;
      }

      let read: TeamReadResult;
      try {
        read = await this.readInbox({
          inboxName: name,
          reader: name,
          sessionId: teammate.sessionId,
          markRead: false,
          limit: 32,
          waitMs: WORKER_IDLE_WAIT_MS,
        });
      } catch (error) {
        if (this.shouldStopWorker(error)) {
          return;
        }
        throw error;
      }

      const latest = this.teammates.get(name);
      if (!latest) {
        return;
      }

      if (latest.status === "shutdown") {
        finalizeTeammateHarness(latest);
        return;
      }

      if (read.messages.length === 0) {
        if (!this.activeRuns.has(name)) {
          latest.status = "idle";
        }
        continue;
      }

      const run = this.claimRunSlot(name, "worker");
      if (!run) {
        try {
          await sleep(
            Math.min(200, WORKER_IDLE_WAIT_MS),
            this.abortController.signal,
          );
        } catch (error) {
          if (this.shouldStopWorker(error)) {
            return;
          }
          throw error;
        }
        continue;
      }

      latest.status = "working";
      latest.updatedAt = new Date().toISOString();
      const nextCursor =
        this.getCursor(name, name, latest.sessionId) + read.messages.length;
      this.setCursor(name, name, nextCursor, latest.sessionId);
      const inboxPrompt = renderInboxPrompt(name, latest.role, read.messages);

      try {
        const result = await latest.harness.run(
          inboxPrompt,
          run.controller.signal,
        );
        latest.updatedAt = new Date().toISOString();
        latest.status = latest.shutdownAfterTurn ? "shutdown" : "idle";
        if (latest.shutdownAfterTurn) {
          finalizeTeammateHarness(latest);
        }

        const metadata: Record<string, unknown> = {
          teammate: name,
          steps: result.steps,
          toolCalls: result.toolCalls,
          sessionId: result.run.sessionId,
          goalId: result.run.goalId,
          attemptId: result.run.attemptId,
        };
        let content: string;

        try {
          const artifact = await persistAgentRunArtifact(this.artifactStore, {
            workspaceRoot: latest.workspaceRoot,
            category: "teammate",
            label: name,
            taskPrompt: inboxPrompt,
            harness: latest.harness.getContext(),
            result,
            notes: {
              lead: latest.lead,
              role: latest.role,
              shutdownAfterTurn: latest.shutdownAfterTurn,
            },
          });
          metadata.artifact = artifact;
          content = renderAgentRunArtifactNotice({
            subject: `Teammate '${name}'`,
            artifact,
            result,
          });
        } catch (artifactError) {
          metadata.artifactError = toErrorMessage(artifactError);
          content = renderAgentRunInlineNotice({
            subject: `Teammate '${name}'`,
            error: artifactError,
            result,
          });
        }

        await this.sendMessage({
          from: name,
          to: latest.lead,
          content,
          type: "announcement",
          sessionId: latest.sessionId,
          metadata,
        });
      } catch (error) {
        latest.updatedAt = new Date().toISOString();
        const interrupted =
          isInterruptError(error) || run.controller.signal.aborted;
        latest.status = latest.shutdownAfterTurn
          ? "shutdown"
          : interrupted
            ? "idle"
            : "error";
        if (latest.shutdownAfterTurn) {
          finalizeTeammateHarness(latest);
        }

        if (!interrupted) {
          await this.sendMessage({
            from: name,
            to: latest.lead,
            content: toErrorMessage(error),
            type: "announcement",
            sessionId: latest.sessionId,
            metadata: {
              teammate: name,
              error: true,
            },
          });
        }
      } finally {
        this.releaseRunSlot(name, run.controller);
      }

      if (latest.shutdownAfterTurn) {
        latest.status = "shutdown";
        latest.updatedAt = new Date().toISOString();
        return;
      }
    }
  }

  private async loadInboxMessages(
    name: string,
    sessionId?: string,
  ): Promise<TeamMessage[]> {
    return this.inboxStore.read(name, sessionId);
  }

  private getCursor(
    reader: string,
    inboxName: string,
    sessionId?: string,
  ): number {
    return (
      this.cursors[buildCursorReaderKey(reader, sessionId)]?.[inboxName] ?? 0
    );
  }

  private setCursor(
    reader: string,
    inboxName: string,
    nextValue: number,
    sessionId?: string,
  ): void {
    const readerKey = buildCursorReaderKey(reader, sessionId);
    if (!this.cursors[readerKey]) {
      this.cursors[readerKey] = {};
    }
    this.cursors[readerKey][inboxName] = Math.max(0, nextValue);
  }

  private toInfo(teammate: LiveTeammate): TeamTeammateInfo {
    return {
      name: teammate.name,
      role: teammate.role,
      lead: teammate.lead,
      status: teammate.status,
      workspaceRoot: teammate.workspaceRoot,
      createdAt: teammate.createdAt,
      updatedAt: teammate.updatedAt,
      depth: teammate.depth,
      parentId: teammate.parentId,
      sessionId: teammate.sessionId,
      goalId: teammate.goalId,
      executionProfile: cloneExecutionProfile(
        teammate.harness.getContext().executionProfile,
      ),
    };
  }

  private requireProtocolRequest(
    store: Map<string, TeamProtocolRequest>,
    requestId: string,
    kind: TeamProtocolKind,
  ): TeamProtocolRequest {
    const request = store.get(requestId);
    if (!request || request.kind !== kind) {
      throw new Error(`Unknown ${kind} request '${requestId}'`);
    }
    return request;
  }

  private ensureRequestIdAvailable(requestId: string): void {
    if (
      this.shutdownRequests.has(requestId) ||
      this.planRequests.has(requestId)
    ) {
      throw new Error(`request_id '${requestId}' already exists`);
    }
  }

  private claimRunSlot(
    name: string,
    kind: ActiveTeammateRun["kind"],
  ): ActiveTeammateRun | null {
    const current = this.activeRuns.get(name);
    if (current) {
      return null;
    }

    const run: ActiveTeammateRun = {
      controller: new AbortController(),
      kind,
    };
    this.activeRuns.set(name, run);
    return run;
  }

  private releaseRunSlot(name: string, controller: AbortController): void {
    const current = this.activeRuns.get(name);
    if (!current || current.controller !== controller) {
      return;
    }
    this.activeRuns.delete(name);
  }

  private shouldStopWorker(error: unknown): boolean {
    return this.abortController.signal.aborted || isInterruptError(error);
  }
}

function renderInboxPrompt(
  name: string,
  role: string,
  messages: TeamMessage[],
): string {
  const renderedMessages = messages
    .map((message, index) =>
      [
        `Message ${index + 1}:`,
        `type: ${message.type}`,
        `from: ${message.from}`,
        `to: ${message.to}`,
        `at: ${message.at}`,
        message.requestId ? `request_id: ${message.requestId}` : undefined,
        `content:\n${message.content}`,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n"),
    )
    .join("\n\n");

  return [
    `Inbox batch for teammate '${name}' (${role}).`,
    "Process the messages below. Use tools when needed and return a concise work summary.",
    renderedMessages,
  ].join("\n\n");
}

function parseTeamState(state: unknown): AgentTeamState | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }

  const candidate = state as Record<string, unknown>;
  const version = candidate.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
    return null;
  }

  const teammatesRaw = candidate.teammates;
  if (!Array.isArray(teammatesRaw)) {
    return null;
  }

  const parsedTeammates: SerializedTeammate[] = [];
  for (const entry of teammatesRaw) {
    const parsed = parseSerializedTeammate(entry);
    if (parsed) {
      parsedTeammates.push(parsed);
    }
  }

  return {
    version: 4,
    cursors: parseCursorState(candidate.cursors),
    teammates: parsedTeammates,
    shutdownRequests:
      version >= 2
        ? parseProtocolRequests(candidate.shutdownRequests, "shutdown")
        : [],
    planRequests:
      version >= 2
        ? parseProtocolRequests(candidate.planRequests, "plan_approval")
        : [],
  };
}

function parseProtocolRequests(
  value: unknown,
  kind: TeamProtocolKind,
): TeamProtocolRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const requests: TeamProtocolRequest[] = [];
  for (const entry of value) {
    const parsed = parseProtocolRequest(entry, kind);
    if (parsed) {
      requests.push(parsed);
    }
  }
  return requests;
}

function parseProtocolRequest(
  value: unknown,
  kind: TeamProtocolKind,
): TeamProtocolRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  const candidateKind = candidate.kind;

  if (
    typeof candidate.requestId !== "string" ||
    candidateKind !== kind ||
    typeof candidate.from !== "string" ||
    typeof candidate.to !== "string" ||
    typeof candidate.content !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    return null;
  }

  return {
    requestId: candidate.requestId,
    kind,
    from: candidate.from,
    to: candidate.to,
    status,
    content: candidate.content,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    sessionId:
      typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    response:
      typeof candidate.response === "string" ? candidate.response : undefined,
  };
}

function parseSerializedTeammate(value: unknown): SerializedTeammate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.role !== "string" ||
    typeof candidate.lead !== "string" ||
    typeof candidate.workspaceRoot !== "string" ||
    typeof candidate.systemPrompt !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    typeof candidate.depth !== "number"
  ) {
    return null;
  }

  const status = candidate.status;
  if (
    status !== "idle" &&
    status !== "working" &&
    status !== "shutdown" &&
    status !== "error"
  ) {
    return null;
  }

  return {
    name: candidate.name,
    role: candidate.role,
    lead: candidate.lead,
    status,
    workspaceRoot: candidate.workspaceRoot,
    systemPrompt: candidate.systemPrompt,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    depth: candidate.depth,
    parentId:
      typeof candidate.parentId === "string" ? candidate.parentId : undefined,
    sessionId:
      typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    goalId: typeof candidate.goalId === "string" ? candidate.goalId : undefined,
    executionProfile: isExecutionProfile(candidate.executionProfile)
      ? candidate.executionProfile
      : undefined,
    allowedTools: parseAllowedTools(candidate.allowedTools),
    memory: candidate.memory as SerializedTeammate["memory"],
    toolRuntime: candidate.toolRuntime as SerializedTeammate["toolRuntime"],
  };
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const name = entry.trim();
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);
    tools.push(name);
  }

  return tools;
}

function parseCursorState(
  value: unknown,
): Record<string, Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const cursors: Record<string, Record<string, number>> = {};
  for (const [reader, inboxes] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !isSafeInboxName(reader) ||
      !inboxes ||
      typeof inboxes !== "object" ||
      Array.isArray(inboxes)
    ) {
      continue;
    }

    const next: Record<string, number> = {};
    for (const [inboxName, rawValue] of Object.entries(
      inboxes as Record<string, unknown>,
    )) {
      if (
        !isSafeInboxName(inboxName) ||
        typeof rawValue !== "number" ||
        !Number.isFinite(rawValue) ||
        rawValue < 0
      ) {
        continue;
      }
      next[inboxName] = Math.floor(rawValue);
    }

    cursors[reader] = next;
  }

  return cursors;
}

function cloneCursorState(
  value: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const cloned: Record<string, Record<string, number>> = {};
  for (const [reader, inboxes] of Object.entries(value)) {
    cloned[reader] = { ...inboxes };
  }
  return cloned;
}

function normalizeInboxName(value: string): string {
  const trimmed = value.trim();
  if (!isSafeInboxName(trimmed)) {
    throw new Error(`Invalid inbox name: ${value}`);
  }
  return trimmed;
}

function normalizeRequestId(value?: string, prefix = "req"): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid request id: ${value}`);
  }

  return trimmed;
}

function normalizeSessionId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSafeInboxName(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function buildCursorReaderKey(reader: string, sessionId?: string): string {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return reader;
  }
  return `${reader}--${encodeSessionStorageKey(normalizedSessionId)}`;
}

function encodeSessionStorageKey(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);

    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(interruptError(signal));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function interruptError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Run interrupted by user.",
  );
}

function finalizeTeammateHarness(teammate: LiveTeammate): void {
  const lifecycleState = teammate.harness.getContext().lifecycleState;
  if (lifecycleState === "finalized") {
    return;
  }

  try {
    teammate.harness.finalize();
  } catch {
    // Ignore shutdown cleanup failures; the teammate is already exiting.
  }
}

function isInterruptError(error: unknown): boolean {
  const message = toErrorMessage(error).trim().toLowerCase();
  return (
    message.includes("run interrupted by user") ||
    message.includes("request aborted")
  );
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (activeSignals.length === 0) {
    return {
      signal: undefined,
      dispose: () => {},
    };
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
    for (const dispose of listeners) {
      dispose();
    }
    listeners.length = 0;
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }

    const handleAbort = () => abort(signal);
    signal.addEventListener("abort", handleAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", handleAbort));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of listeners) {
        dispose();
      }
      listeners.length = 0;
    },
  };
}
