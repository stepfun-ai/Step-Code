import {
  AgentTeam,
  type AgentTeamInboxStore,
  type TeamMessageType,
  type TeammateHooksFactory,
} from "@step-cli/core/agent/agent-team.js";
import type { AgentRunArtifactStore } from "@step-cli/core/agent/run-artifact-store.js";
import {
  resolveAgentPreset,
  type AgentPresetRegistry,
} from "@step-cli/core/agent/agent-presets.js";
import { AgentHarnessFactory } from "@step-cli/core/agent/harness.js";
import {
  getHarnessContext,
  resolveExecutionProfile,
} from "@step-cli/core/agent/harness-context.js";
import { WorktreeManager } from "@step-cli/core/agent/worktree-manager.js";
import {
  parseJsonObject,
  readBooleanField,
  readIntegerField,
  readObjectField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import type {
  ToolExecutionResult,
  ToolGroupingDescriptor,
  ToolSpec,
} from "@step-cli/protocol";
import type { MutableRef } from "@step-cli/utils/mutable-ref.js";
import { shortenLine } from "@step-cli/utils/text.js";
import {
  isTeammateHarness,
  isTopLevelMainHarness,
} from "@step-cli/core/plugins/tool-visibility.js";
import type { ToolPlugin } from "@step-cli/core/plugins/types.js";

export interface AgentTeamToolPlugin extends ToolPlugin {
  getTeam(): AgentTeam;
}

interface SpawnTeammateArgs {
  name: string;
  role?: string;
  preset?: string;
  prompt: string;
  isolateWorkspace?: boolean;
  worktreeName?: string;
}

interface SendMessageArgs {
  to: string;
  content: string;
  type?: TeamMessageType;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

interface ReadInboxArgs {
  inbox?: string;
  markRead?: boolean;
  limit?: number;
  waitMs?: number;
}

interface RequestShutdownArgs {
  teammate: string;
  reason?: string;
  requestId?: string;
}

interface RespondShutdownArgs {
  requestId: string;
  approve: boolean;
  response?: string;
}

interface RequestPlanApprovalArgs {
  plan: string;
  to?: string;
  requestId?: string;
}

interface RespondPlanApprovalArgs {
  requestId: string;
  approve: boolean;
  response?: string;
}

const VALID_TEAM_MESSAGE_TYPES: TeamMessageType[] = [
  "message",
  "broadcast",
  "announcement",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_request",
  "plan_approval_response",
];
const TEAMMATE_GROUPING_SUMMARY =
  "Coordinate persistent teammates and inbox protocols through one tool.";
const TEAMMATE_GROUPING_SECURITY = {
  risk: "meta",
  defaultMode: "allow",
} as const;
const TEAMMATE_GROUPING_PROPERTY_OVERRIDES = {
  request_id: {
    type: "string",
    description:
      "Protocol request id. Required for response actions and optional for send/request actions.",
  },
} as const;

function createTeammateGrouping(
  action: string,
  aliases: string[],
): ToolGroupingDescriptor {
  return {
    family: "teammate",
    summary: TEAMMATE_GROUPING_SUMMARY,
    action,
    aliases,
    propertyOverrides: TEAMMATE_GROUPING_PROPERTY_OVERRIDES,
    security: TEAMMATE_GROUPING_SECURITY,
  };
}

export function createAgentTeamPlugin(
  harnessFactoryRef: MutableRef<AgentHarnessFactory>,
  inboxStore: AgentTeamInboxStore,
  worktreeManager: WorktreeManager,
  artifactStore?: AgentRunArtifactStore,
  presetRegistry?: AgentPresetRegistry,
  teammateHooksFactory?: TeammateHooksFactory,
): AgentTeamToolPlugin {
  const team = new AgentTeam({
    inboxStore,
    harnessFactoryRef,
    artifactStore,
    presetRegistry,
    teammateHooksFactory,
  });

  return {
    id: "agent-team-plugin",
    description: "Persistent named teammates with JSONL inbox coordination",
    register: (context) => {
      if (isTopLevelMainHarness(context)) {
        return [
          createSpawnTeammateTool(team, worktreeManager, presetRegistry),
          createSendMessageTool(team),
          createReadInboxTool(team),
          createListTeammatesTool(team),
          createRequestShutdownTool(team),
          createRespondPlanApprovalTool(team),
        ];
      }

      if (isTeammateHarness(context)) {
        return [
          createSendMessageTool(team),
          createReadInboxTool(team),
          createRespondShutdownTool(team),
          createRequestPlanApprovalTool(team),
        ];
      }

      return [];
    },
    exportState: () => team.exportState(),
    loadState: (state) => {
      team.loadState(state);
    },
    shutdown: async (reason) => {
      await team.close({
        abortRunning: true,
        reason,
      });
    },
    getTeam: () => team,
  };
}

function createSpawnTeammateTool(
  team: AgentTeam,
  worktreeManager: WorktreeManager,
  presetRegistry?: AgentPresetRegistry,
): ToolSpec<SpawnTeammateArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "spawn_teammate",
        description:
          "Create or wake a persistent named teammate with its own memory and inbox. Use it for longer-lived parallel collaborators, and spawn multiple teammates in the same turn when their roles are independent.",
        parameters: {
          type: "object",
          required: ["name", "prompt"],
          properties: {
            name: {
              type: "string",
              description:
                "Stable teammate name. Reusing a name resumes the same persistent teammate.",
            },
            role: {
              type: "string",
              description:
                "Optional teammate role, such as researcher, coder, or reviewer. Required unless preset supplies a default role.",
            },
            preset: {
              type: "string",
              description:
                "Optional teammate preset, such as review, planner, or explore.",
            },
            prompt: {
              type: "string",
              description: "The teammate's initial assignment or next task.",
            },
            isolate_workspace: {
              type: "boolean",
              description:
                "Create or reuse a dedicated git worktree for this teammate.",
            },
            worktree_name: {
              type: "string",
              description:
                "Optional worktree lane name. Defaults to a sanitized teammate name.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("spawn", ["spawn_teammate"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        name: readRequiredStringField(payload.name, "name"),
        role: readStringField(payload.role),
        preset: readStringField(payload.preset),
        prompt: readRequiredStringField(payload.prompt, "prompt"),
        isolateWorkspace:
          readBooleanField(payload.isolate_workspace, "isolate_workspace") ??
          readBooleanField(payload.isolateWorkspace, "isolateWorkspace"),
        worktreeName:
          readStringField(payload.worktree_name) ??
          readStringField(payload.worktreeName),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "spawn_teammate",
        buildSpawnTeammateHint(args),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind !== "main" || current.depth !== 0) {
        return {
          ok: false,
          summary: "Only the main harness can spawn persistent teammates",
          error: {
            code: "TEAMMATE_SPAWN_DENIED",
            message:
              "spawn_teammate is restricted to the top-level main harness.",
          },
          data: {
            harness: current,
          },
        };
      }

      const preset = resolveAgentPreset(
        presetRegistry,
        "teammate",
        args.preset,
      );
      const resolvedRole = args.role?.trim() || preset?.defaultRole?.trim();
      if (!resolvedRole) {
        return {
          ok: false,
          summary: "Teammate role is required",
          error: {
            code: "TEAMMATE_ROLE_REQUIRED",
            message: args.preset?.trim()
              ? `Preset '${args.preset}' does not provide a default role. Pass role explicitly or use a preset with defaultRole.`
              : "spawn_teammate requires role unless the selected preset provides a default role.",
          },
        };
      }

      const existingTeammate = team.getTeammate(args.name);
      let workspaceRoot = ctx.workspaceRoot;
      let worktree:
        | Awaited<ReturnType<WorktreeManager["allocate"]>>["worktree"]
        | undefined;
      const warnings: string[] = [];

      if (args.isolateWorkspace) {
        if (existingTeammate && existingTeammate.status !== "shutdown") {
          const assigned = await worktreeManager.findAssigned(
            "teammate",
            args.name,
          );
          if (assigned) {
            workspaceRoot = assigned.workspaceRoot;
            worktree = assigned.worktree;
          } else {
            warnings.push(
              `Teammate '${args.name}' is already active in workspace '${existingTeammate.workspaceRoot}'. Restart it before moving to a dedicated worktree.`,
            );
          }
        } else {
          const allocation = await worktreeManager.allocate({
            ownerKind: "teammate",
            ownerName: args.name,
            preferredName: args.worktreeName,
          });
          workspaceRoot = allocation.workspaceRoot;
          worktree = allocation.worktree;
          if (allocation.warnings) {
            warnings.push(...allocation.warnings);
          }
        }
      }

      const created = await team.spawnTeammate({
        name: args.name,
        role: args.role,
        preset: args.preset,
        prompt: args.prompt,
        requester: current.name,
        parentId: current.id,
        parentDepth: current.depth,
        workspaceRoot,
        sessionId: current.sessionId,
        goalId: `${current.goalId ?? "main:root"}/teammate:${args.name.trim()}`,
        executionProfile: resolveExecutionProfile("teammate", {
          workspaceMode: args.isolateWorkspace ? "isolated" : "shared",
        }),
      });
      if (created.warnings) {
        warnings.push(...created.warnings);
      }

      return {
        ok: true,
        summary: `Spawned teammate '${created.teammate.name}'`,
        content: renderSpawnResult(created.teammate, worktree, warnings),
        data: {
          teammate: created.teammate,
          worktree,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    },
  };
}

function createSendMessageTool(team: AgentTeam): ToolSpec<SendMessageArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "send_message",
        description:
          "Send a direct team message to another inbox such as a teammate or main.",
        parameters: {
          type: "object",
          required: ["to", "content"],
          properties: {
            to: {
              type: "string",
              description:
                "Destination inbox name, such as main or a teammate name.",
            },
            content: {
              type: "string",
              description: "Message content to deliver.",
            },
            type: {
              type: "string",
              enum: VALID_TEAM_MESSAGE_TYPES,
              description: "Optional message type. Defaults to message.",
            },
            request_id: {
              type: "string",
              description:
                "Optional correlation id for request-response protocols.",
            },
            metadata: {
              type: "object",
              description:
                "Optional structured metadata to attach to the message.",
              additionalProperties: true,
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("send", ["send_message"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        to: readRequiredStringField(payload.to, "to"),
        content: readRequiredStringField(payload.content, "content"),
        type: parseOptionalMessageType(payload.type),
        requestId:
          readStringField(payload.request_id) ??
          readStringField(payload.requestId),
        metadata: readObjectField(payload.metadata, "metadata"),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "send_message",
        buildRecipientHint(args.to, args.content),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind === "subagent") {
        return {
          ok: false,
          summary: "Subagents cannot use team inbox messaging",
          error: {
            code: "TEAM_INBOX_UNAVAILABLE",
            message:
              "send_message is only available to the main harness and persistent teammates.",
          },
        };
      }

      const message = await team.sendMessage({
        from: current.name,
        to: args.to,
        content: args.content,
        type: args.type,
        sessionId: current.sessionId,
        requestId: args.requestId,
        metadata: args.metadata,
      });

      return {
        ok: true,
        summary: `Sent ${message.type} to '${message.to}'`,
        content: JSON.stringify(message, null, 2),
        data: message,
      };
    },
  };
}

function createReadInboxTool(team: AgentTeam): ToolSpec<ReadInboxArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_inbox",
        description:
          "Read team messages from the current inbox or a specified inbox, with optional short waiting.",
        parameters: {
          type: "object",
          properties: {
            inbox: {
              type: "string",
              description:
                "Inbox name to read. Defaults to the current harness name.",
            },
            markRead: {
              type: "boolean",
              description:
                "Whether to advance the cursor after reading. Defaults to true.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              description: "Maximum number of messages to return.",
            },
            waitMs: {
              type: "integer",
              minimum: 0,
              maximum: 60000,
              description:
                "Optional wait time for new messages before returning.",
            },
          },
        },
      },
    },
    security: {
      risk: "read",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("inbox", ["read_inbox"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        inbox: readStringField(payload.inbox),
        markRead: readBooleanField(payload.markRead, "markRead"),
        limit: readIntegerField(payload.limit, "limit"),
        waitMs: readIntegerField(payload.waitMs, "waitMs"),
      };
    },
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind === "subagent") {
        return {
          ok: false,
          summary: "Subagents cannot read team inboxes",
          error: {
            code: "TEAM_INBOX_UNAVAILABLE",
            message:
              "read_inbox is only available to the main harness and persistent teammates.",
          },
        };
      }

      const inboxName = args.inbox?.trim() || current.name;
      if (current.kind === "teammate" && inboxName !== current.name) {
        return {
          ok: false,
          summary: "Teammates can only read their own inbox",
          error: {
            code: "INBOX_ACCESS_DENIED",
            message: `Teammate '${current.name}' cannot read inbox '${inboxName}'.`,
          },
        };
      }

      const result = await team.readInbox({
        inboxName,
        reader: current.name,
        sessionId: current.sessionId,
        markRead: args.markRead,
        limit: args.limit,
        waitMs: args.waitMs,
        signal: ctx.signal,
      });

      return {
        ok: true,
        summary: `Read ${result.messages.length} message(s) from '${inboxName}'`,
        content: JSON.stringify(result.messages, null, 2),
        data: {
          inbox: inboxName,
          ...result,
        },
      };
    },
  };
}

function createRequestShutdownTool(
  team: AgentTeam,
): ToolSpec<RequestShutdownArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "request_shutdown",
        description:
          "Ask a persistent teammate to shut down gracefully after the current turn.",
        parameters: {
          type: "object",
          required: ["teammate"],
          properties: {
            teammate: {
              type: "string",
              description: "Teammate name to stop.",
            },
            reason: {
              type: "string",
              description: "Optional reason or shutdown instructions.",
            },
            request_id: {
              type: "string",
              description:
                "Optional request id for explicit protocol correlation.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("request_shutdown", ["request_shutdown"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        teammate: readRequiredStringField(payload.teammate, "teammate"),
        reason: readStringField(payload.reason),
        requestId:
          readStringField(payload.request_id) ??
          readStringField(payload.requestId),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "request_shutdown",
        buildRecipientHint(args.teammate, args.reason),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind !== "main" || current.depth !== 0) {
        return {
          ok: false,
          summary: "Only the main harness can request teammate shutdown",
          error: {
            code: "SHUTDOWN_REQUEST_DENIED",
            message:
              "request_shutdown is restricted to the top-level main harness.",
          },
        };
      }

      const result = await team.requestShutdown({
        from: current.name,
        to: args.teammate,
        content: args.reason,
        sessionId: current.sessionId,
        requestId: args.requestId,
      });

      return {
        ok: true,
        summary: `Requested shutdown for '${args.teammate}'`,
        content: renderProtocolResult(result.request, result.message),
        data: result,
      };
    },
  };
}

function createRespondShutdownTool(
  team: AgentTeam,
): ToolSpec<RespondShutdownArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "respond_shutdown",
        description:
          "Respond to a shutdown request from the lead. Approving will stop this teammate after the turn.",
        parameters: {
          type: "object",
          required: ["request_id", "approve"],
          properties: {
            request_id: {
              type: "string",
              description: "Shutdown request id to answer.",
            },
            approve: {
              type: "boolean",
              description: "Whether to approve the shutdown request.",
            },
            response: {
              type: "string",
              description: "Optional response back to the lead.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("respond_shutdown", ["respond_shutdown"]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        requestId:
          readStringField(payload.request_id) ??
          readRequiredStringField(payload.requestId, "requestId"),
        approve: readRequiredBooleanField(payload.approve, "approve"),
        response: readStringField(payload.response),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "respond_shutdown",
        buildApprovalHint(args.requestId, args.approve, args.response),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind !== "teammate") {
        return {
          ok: false,
          summary: "Only persistent teammates can answer shutdown requests",
          error: {
            code: "SHUTDOWN_RESPONSE_DENIED",
            message:
              "respond_shutdown is only available inside a teammate harness.",
          },
        };
      }

      const result = await team.respondShutdown({
        from: current.name,
        requestId: args.requestId,
        approve: args.approve,
        sessionId: current.sessionId,
        content: args.response,
      });

      return {
        ok: true,
        summary: args.approve
          ? "Approved shutdown request"
          : "Rejected shutdown request",
        content: renderProtocolResult(result.request, result.message),
        data: result,
      };
    },
  };
}

function createRequestPlanApprovalTool(
  team: AgentTeam,
): ToolSpec<RequestPlanApprovalArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "request_plan_approval",
        description:
          "Ask the lead to approve a plan. After sending, wait for a matching plan_approval_response in your inbox.",
        parameters: {
          type: "object",
          required: ["plan"],
          properties: {
            plan: {
              type: "string",
              description: "Plan text that needs approval.",
            },
            to: {
              type: "string",
              description:
                "Optional reviewer inbox. Defaults to the teammate lead.",
            },
            request_id: {
              type: "string",
              description:
                "Optional request id for explicit protocol correlation.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("request_plan", [
      "request_plan",
      "request_plan_approval",
    ]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        plan: readRequiredStringField(payload.plan, "plan"),
        to: readStringField(payload.to),
        requestId:
          readStringField(payload.request_id) ??
          readStringField(payload.requestId),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "request_plan_approval",
        buildRecipientHint(args.to ?? "main", args.plan),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind !== "teammate") {
        return {
          ok: false,
          summary: "Only teammates can request plan approval",
          error: {
            code: "PLAN_REQUEST_DENIED",
            message:
              "request_plan_approval is only available inside a teammate harness.",
          },
        };
      }

      const teammate = team.getTeammate(current.name);
      const target = args.to?.trim() || teammate?.lead || "main";
      const result = await team.requestPlanApproval({
        from: current.name,
        to: target,
        content: args.plan,
        sessionId: current.sessionId,
        requestId: args.requestId,
      });

      return {
        ok: true,
        summary: `Requested plan approval from '${target}'`,
        content: renderProtocolResult(result.request, result.message),
        data: result,
      };
    },
  };
}

function createRespondPlanApprovalTool(
  team: AgentTeam,
): ToolSpec<RespondPlanApprovalArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "respond_plan_approval",
        description: "Approve or reject a teammate's plan request.",
        parameters: {
          type: "object",
          required: ["request_id", "approve"],
          properties: {
            request_id: {
              type: "string",
              description: "Plan approval request id to answer.",
            },
            approve: {
              type: "boolean",
              description: "Whether to approve the requested plan.",
            },
            response: {
              type: "string",
              description: "Optional review notes for the teammate.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("respond_plan", [
      "respond_plan",
      "respond_plan_approval",
    ]),
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        requestId:
          readStringField(payload.request_id) ??
          readRequiredStringField(payload.requestId, "requestId"),
        approve: readRequiredBooleanField(payload.approve, "approve"),
        response: readStringField(payload.response),
      };
    },
    inspect: ({ args }) =>
      createTeamExternalInspection(
        "respond_plan_approval",
        buildApprovalHint(args.requestId, args.approve, args.response),
      ),
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      const current = getCurrentHarnessName(ctx.workspaceRoot);
      if (current.kind !== "main" || current.depth !== 0) {
        return {
          ok: false,
          summary: "Only the main harness can respond to plan approvals",
          error: {
            code: "PLAN_RESPONSE_DENIED",
            message:
              "respond_plan_approval is restricted to the top-level main harness.",
          },
        };
      }

      const result = await team.respondPlanApproval({
        from: current.name,
        requestId: args.requestId,
        approve: args.approve,
        sessionId: current.sessionId,
        content: args.response,
      });

      return {
        ok: true,
        summary: args.approve
          ? "Approved teammate plan"
          : "Rejected teammate plan",
        content: renderProtocolResult(result.request, result.message),
        data: result,
      };
    },
  };
}

function createListTeammatesTool(team: AgentTeam): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_teammates",
        description: "List persistent teammates and their status.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    grouping: createTeammateGrouping("list", ["list_teammates"]),
    parseArgs: () => ({}),
    execute: async (): Promise<ToolExecutionResult> => {
      const teammates = team.listTeammates();
      const lines =
        teammates.length === 0
          ? ["(none)"]
          : teammates.map(
              (entry) =>
                `${entry.name} [${entry.status}] role=${entry.role} lead=${entry.lead} workspace=${entry.workspaceRoot}`,
            );

      return {
        ok: true,
        summary: `Teammates: ${teammates.length}`,
        content: lines.join("\n"),
        data: {
          teammates,
        },
      };
    },
  };
}

function getCurrentHarnessName(workspaceRoot: string): {
  id: string;
  kind: "main" | "subagent" | "teammate";
  name: string;
  depth: number;
  workspaceRoot: string;
  sessionId?: string;
  goalId?: string;
} {
  const current = getHarnessContext();
  if (current) {
    return current;
  }

  return {
    id: "main",
    kind: "main",
    name: "main",
    depth: 0,
    workspaceRoot,
    sessionId: "main-session",
    goalId: "main:root",
  };
}

function parseOptionalMessageType(value: unknown): TeamMessageType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !VALID_TEAM_MESSAGE_TYPES.includes(value as TeamMessageType)
  ) {
    throw new Error(
      `type must be one of: ${VALID_TEAM_MESSAGE_TYPES.join(", ")}`,
    );
  }

  return value as TeamMessageType;
}

function readRequiredBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function createTeamExternalInspection(label: string, inputHint?: string) {
  return {
    ...(inputHint ? { inputHint } : {}),
    externalEffects: [
      {
        kind: "external-unsafe" as const,
        label,
      },
    ],
  };
}

function buildSpawnTeammateHint(args: SpawnTeammateArgs): string {
  const normalizedName = args.name.trim();
  const roleOrPreset = args.role?.trim() || args.preset?.trim();
  const detail = roleOrPreset || args.prompt;
  return shortenLine(`${normalizedName} · ${detail}`, 96);
}

function buildRecipientHint(target: string, content?: string): string {
  const normalizedTarget = target.trim();
  const normalizedContent = content?.trim();
  if (!normalizedContent) {
    return shortenLine(normalizedTarget, 96);
  }
  return shortenLine(`${normalizedTarget} · ${normalizedContent}`, 96);
}

function buildApprovalHint(
  requestId: string,
  approve: boolean,
  response?: string,
): string {
  const base = `${requestId.trim()} · ${approve ? "approve" : "reject"}`;
  const normalizedResponse = response?.trim();
  return shortenLine(
    normalizedResponse ? `${base} · ${normalizedResponse}` : base,
    96,
  );
}

function renderProtocolResult(
  request: {
    kind: string;
    requestId: string;
    from: string;
    to: string;
    status: string;
    content: string;
    response?: string;
  },
  message: {
    type: string;
    at: string;
  },
): string {
  const lines = [
    `kind: ${request.kind}`,
    `request_id: ${request.requestId}`,
    `from: ${request.from}`,
    `to: ${request.to}`,
    `status: ${request.status}`,
    `content: ${request.content}`,
    `message_type: ${message.type}`,
    `message_at: ${message.at}`,
  ];

  if (request.response) {
    lines.push(`response: ${request.response}`);
  }

  return lines.join("\n");
}

function renderSpawnResult(
  teammate: {
    name: string;
    role: string;
    lead: string;
    status: string;
    workspaceRoot: string;
    sessionId?: string;
    goalId?: string;
    executionProfile?: {
      workspaceMode: string;
      memoryMode: string;
      priority: string;
    };
  },
  worktree?: {
    name: string;
    path: string;
    branch: string;
  },
  warnings?: string[],
): string {
  const lines = [
    `name: ${teammate.name}`,
    `role: ${teammate.role}`,
    `lead: ${teammate.lead}`,
    `status: ${teammate.status}`,
    `workspace: ${teammate.workspaceRoot}`,
  ];

  if (teammate.sessionId) {
    lines.push(`session_id: ${teammate.sessionId}`);
  }

  if (teammate.goalId) {
    lines.push(`goal_id: ${teammate.goalId}`);
  }

  if (teammate.executionProfile) {
    lines.push(
      `profile: ${teammate.executionProfile.workspaceMode}/${teammate.executionProfile.memoryMode}/${teammate.executionProfile.priority}`,
    );
  }

  if (worktree) {
    lines.push(`worktree: ${worktree.name}`);
    lines.push(`worktree_root: ${worktree.path}`);
    lines.push(`worktree_branch: ${worktree.branch}`);
  }

  if (warnings && warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}
