import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@step-cli/protocol";
import {
  createEmptyCheckpoint,
  cloneCheckpoint,
  normalizeCheckpoint,
  mergeCheckpoints,
  createCheckpointItem,
  renderCheckpointText,
  buildCheckpointFromMessages,
  parseSummaryTextToCheckpoint,
  parseLegacySummaryToCheckpoint,
  renderConstraintMemory,
  renderObjectiveMemory,
  renderDecisionMemory,
  renderWorkingMemory,
  pruneCheckpointOnce,
} from "./conversation-memory-checkpoint.js";

describe("createEmptyCheckpoint", () => {
  it("returns checkpoint with all empty arrays", () => {
    const cp = createEmptyCheckpoint();
    expect(cp.version).toBe(1);
    expect(cp.objective).toEqual([]);
    expect(cp.hardConstraints).toEqual([]);
    expect(cp.verifiedFacts).toEqual([]);
    expect(cp.attemptedActions).toEqual([]);
    expect(cp.openIssues).toEqual([]);
    expect(cp.nextSteps).toEqual([]);
    expect(cp.relevantPriors).toEqual([]);
  });
});

describe("cloneCheckpoint", () => {
  it("deep-clones all sections", () => {
    const original = createEmptyCheckpoint();
    original.objective.push({ text: "goal", status: "still_active" });
    original.hardConstraints.push({
      id: "hc-1",
      text: "must pass tests",
      confidence: "high",
      evidenceRefs: [],
    });

    const cloned = cloneCheckpoint(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.objective).not.toBe(original.objective);
    expect(cloned.hardConstraints[0]).not.toBe(original.hardConstraints[0]);
  });
});

describe("normalizeCheckpoint", () => {
  it("returns null for null or undefined", () => {
    expect(normalizeCheckpoint(null)).toBeNull();
    expect(normalizeCheckpoint(undefined)).toBeNull();
  });

  it("normalizes a valid checkpoint with deduplication", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: [
        { text: "build feature", status: "still_active" },
        { text: "build feature", status: "resolved" },
      ],
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp).not.toBeNull();
    expect(cp!.objective).toHaveLength(1);
    expect(cp!.objective[0]!.status).toBe("resolved");
  });

  it("limits objective entries to 4", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: Array.from({ length: 6 }, (_, i) => ({
        text: `goal-${i}`,
        status: "still_active" as const,
      })),
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp!.objective.length).toBeLessThanOrEqual(4);
  });

  it("normalizes unknown confidence to medium", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: [],
      hardConstraints: [
        {
          id: "hc-1",
          text: "constraint",
          confidence: "unknown" as never,
          evidenceRefs: [],
        },
      ],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp!.hardConstraints[0]!.confidence).toBe("medium");
  });
});

describe("createCheckpointItem", () => {
  it("creates item with generated id and normalized text", () => {
    const item = createCheckpointItem(
      "verifiedFacts",
      "  tests pass  ",
      "high",
      [],
    );
    expect(item.id).toContain("verifiedFacts:");
    expect(item.text).toBe("tests pass");
    expect(item.confidence).toBe("high");
    expect(item.evidenceRefs).toEqual([]);
  });
});

describe("mergeCheckpoints", () => {
  it("merges update into base", () => {
    const base = createEmptyCheckpoint();
    base.objective.push({ text: "original goal", status: "still_active" });
    base.hardConstraints.push({
      id: "hc-1",
      text: "must compile",
      confidence: "high",
      evidenceRefs: [],
    });

    const merged = mergeCheckpoints(base, {
      verifiedFacts: [
        {
          id: "vf-1",
          text: "fact one",
          confidence: "medium",
          evidenceRefs: [],
        },
      ],
    });

    expect(merged.objective).toHaveLength(1);
    expect(merged.hardConstraints).toHaveLength(1);
    expect(merged.verifiedFacts).toHaveLength(1);
  });

  it("deduplicates items with same text", () => {
    const base = createEmptyCheckpoint();
    base.verifiedFacts.push({
      id: "vf-1",
      text: "duplicate fact",
      confidence: "low",
      evidenceRefs: [],
    });

    const merged = mergeCheckpoints(base, {
      verifiedFacts: [
        {
          id: "vf-2",
          text: "duplicate fact",
          confidence: "high",
          evidenceRefs: [],
        },
      ],
    });

    expect(merged.verifiedFacts).toHaveLength(1);
    expect(merged.verifiedFacts[0]!.confidence).toBe("high");
  });
});

describe("renderCheckpointText", () => {
  it("renders non-empty checkpoint as markdown sections", () => {
    const cp = createEmptyCheckpoint();
    cp.objective.push({ text: "ship feature", status: "still_active" });
    cp.verifiedFacts.push({
      id: "vf-1",
      text: "tests pass",
      confidence: "high",
      evidenceRefs: [],
    });

    const text = renderCheckpointText(cp);
    expect(text).toContain("ship feature");
    expect(text).toContain("tests pass");
  });

  it("returns empty string for empty checkpoint", () => {
    const text = renderCheckpointText(createEmptyCheckpoint());
    expect(text).toBe("");
  });

  it("renders title, notes, and evidence refs", () => {
    const cp = createEmptyCheckpoint();
    cp.verifiedFacts.push({
      id: "vf-1",
      text: "found bug",
      confidence: "high",
      evidenceRefs: [
        {
          kind: "tool",
          transcriptPath: "/t.jsonl",
          summarizedFrom: 2,
          summarizedTo: 5,
        },
        {
          kind: "mixed",
          messageIndexes: [1, 2, 3],
        },
      ],
    });

    const text = renderCheckpointText(cp, {
      title: "Checkpoint",
      notes: ["note one", undefined, ""],
    });
    expect(text).toContain("[Checkpoint]");
    expect(text).toContain("note one");
    expect(text).toContain("found bug (high)");
    expect(text).toContain("refs: /t.jsonl:2-5; messages 1,2,3");
  });
});

describe("normalizeCheckpoint extras", () => {
  it("returns empty objective array for non-array input", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: "not-an-array" as never,
      hardConstraints: [],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });
    expect(cp!.objective).toEqual([]);
  });

  it("drops malformed items and merges evidence/confidence by key", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: [],
      hardConstraints: [],
      verifiedFacts: [
        null as never,
        { text: "" } as never,
        {
          id: "vf-1",
          text: "shared fact",
          confidence: "low",
          evidenceRefs: [{ kind: "tool", transcriptPath: "/a" }],
        },
        {
          id: "vf-2",
          text: "shared fact",
          confidence: "high",
          evidenceRefs: [{ kind: "user", transcriptPath: "/b" }],
        },
      ],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });

    expect(cp!.verifiedFacts).toHaveLength(1);
    expect(cp!.verifiedFacts[0]!.confidence).toBe("high");
    expect(cp!.verifiedFacts[0]!.evidenceRefs.length).toBe(2);
  });

  it("generates ids and normalizes legacy string objective entries", () => {
    const cp = normalizeCheckpoint({
      version: 1,
      objective: ["plain string goal", { notText: 1 }] as never,
      hardConstraints: [
        {
          text: "auto id constraint",
          confidence: "high",
          evidenceRefs: [],
        } as never,
      ],
      verifiedFacts: [],
      attemptedActions: [],
      openIssues: [],
      nextSteps: [],
      relevantPriors: [],
    });
    expect(cp!.objective).toHaveLength(1);
    expect(cp!.objective[0]!.text).toBe("plain string goal");
    expect(cp!.hardConstraints[0]!.id).toContain("hardConstraints:");
  });
});

describe("buildCheckpointFromMessages", () => {
  it("does not promote ordinary chat into SUMMARY objectives", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你是谁？" },
      { role: "assistant", content: "我是 Step CLI 助手。" },
      { role: "user", content: "你去读取一下README的文件内容。" },
    ];

    const result = buildCheckpointFromMessages(messages, {
      fromIndex: 0,
      toIndex: 3,
    });

    expect(result.objective).toEqual([]);
    const summary = renderCheckpointText(
      mergeCheckpoints(createEmptyCheckpoint(), result),
    );
    expect(summary).not.toMatch(/Current Objective|Superseded Objectives/);
  });

  it("extracts explicit /goal and labeled objective signals", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你是谁？" },
      { role: "user", content: "/goal 读取 README 并总结" },
      { role: "user", content: "Goal: ship the release tonight" },
    ];

    const result = buildCheckpointFromMessages(messages, {
      fromIndex: 0,
      toIndex: 3,
    });

    expect(result.objective?.map((entry) => entry.text)).toEqual([
      "读取 README 并总结",
      "ship the release tonight",
    ]);
    expect(result.objective?.[0]!.status).toBe("superseded");
    expect(result.objective?.[1]!.status).toBe("still_active");
  });

  it("extracts the goal text from a /goal wake prompt", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          "You are working toward this long-running session goal:",
          "",
          "Migrate the auth flow",
          "",
          "Goal id: goal-123",
          "Goal iteration: 1",
        ].join("\n"),
      },
    ];

    const result = buildCheckpointFromMessages(messages, {
      fromIndex: 0,
      toIndex: 1,
    });

    expect(result.objective).toEqual([
      { text: "Migrate the auth flow", status: "still_active" },
    ]);
  });

  it("extracts tool outcomes without treating the user prompt as an objective", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Please fix the login bug" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        name: "Read",
        tool_call_id: "c1",
        content: JSON.stringify({
          ok: true,
          summary: "read file",
          data: { path: "/src/login.ts" },
        }),
      },
      {
        role: "tool",
        name: "Bash",
        tool_call_id: "c2",
        content: JSON.stringify({
          ok: false,
          summary: "command failed",
          error: { message: "boom", code: "EFAIL" },
        }),
      },
      {
        role: "assistant",
        content: "Here is my plan to proceed.",
      },
    ];

    const result = buildCheckpointFromMessages(messages, {
      transcriptPath: "/t.jsonl",
      fromIndex: 0,
      toIndex: 5,
    });

    expect(result.objective).toEqual([]);
    // Planned tools + assistant preview + tool summaries
    const actionTexts = (result.attemptedActions ?? []).map((a) => a.text);
    expect(actionTexts.some((t) => t.includes("Planned tools: Read"))).toBe(
      true,
    );
    expect(actionTexts.some((t) => t.includes("plan to proceed"))).toBe(true);
    // verified fact with observed path
    const factTexts = (result.verifiedFacts ?? []).map((f) => f.text);
    expect(factTexts.some((t) => t.includes("Observed path"))).toBe(true);
    // failed tool -> open issue with error code
    const issueTexts = (result.openIssues ?? []).map((i) => i.text);
    expect(issueTexts.some((t) => t.includes("EFAIL"))).toBe(true);
  });

  it("extracts hard constraints from constraint phrases", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "You must not delete files. Only edit tests.",
      },
      { role: "system", content: "Do not commit without review." },
    ];

    const result = buildCheckpointFromMessages(messages, {
      fromIndex: 0,
      toIndex: 2,
    });
    const constraintTexts = (result.hardConstraints ?? []).map((c) => c.text);
    expect(constraintTexts.length).toBeGreaterThan(0);
    expect(
      constraintTexts.some((t) => t.includes("must not") || t.includes("Only")),
    ).toBe(true);
  });
});

describe("parseSummaryTextToCheckpoint", () => {
  it("parses JSON checkpoint from a fenced code block", () => {
    const summary = [
      "Here is the checkpoint:",
      "```json",
      JSON.stringify({
        objective: ["ship the release"],
        hardConstraints: ["no breaking changes"],
        verifiedFacts: ["build passes"],
        nextSteps: ["write docs"],
      }),
      "```",
    ].join("\n");

    const result = parseSummaryTextToCheckpoint(summary, {
      transcriptPath: "/t.jsonl",
      fromIndex: 1,
      toIndex: 9,
    });

    expect(result).not.toBeNull();
    expect(result!.objective?.[0]!.text).toContain("ship the release");
    expect(result!.hardConstraints?.[0]!.text).toContain("no breaking");
    expect(result!.nextSteps?.[0]!.text).toContain("write docs");
    expect(result!.verifiedFacts?.[0]!.evidenceRefs[0]!.transcriptPath).toBe(
      "/t.jsonl",
    );
  });

  it("falls back to section parsing for markdown summaries", () => {
    const summary = [
      "Current Objective:",
      "- finish the migration",
      "Verified Facts:",
      "- schema updated",
      "Next Steps:",
      "- deploy to staging",
    ].join("\n");

    const result = parseSummaryTextToCheckpoint(summary, {
      fromIndex: 0,
      toIndex: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.objective?.[0]!.text).toContain("finish the migration");
    expect(result!.verifiedFacts?.[0]!.text).toContain("schema updated");
    expect(result!.nextSteps?.[0]!.text).toContain("deploy to staging");
    // No transcriptPath -> messageIndexes used in evidence (empty for 0..0 range)
    expect(result!.verifiedFacts?.[0]!.evidenceRefs[0]!.messageIndexes).toEqual(
      [],
    );
  });

  it("treats unstructured text as a single verified fact", () => {
    const result = parseSummaryTextToCheckpoint("just some prose here", {
      fromIndex: 0,
      toIndex: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.verifiedFacts).toHaveLength(1);
    expect(result!.verifiedFacts?.[0]!.text).toBe("just some prose here");
  });

  it("returns null for whitespace-only summary", () => {
    expect(
      parseSummaryTextToCheckpoint("   \n  ", { fromIndex: 0, toIndex: 0 }),
    ).toBeNull();
  });
});

describe("parseLegacySummaryToCheckpoint", () => {
  it("returns a full checkpoint merged from sections", () => {
    const cp = parseLegacySummaryToCheckpoint(
      ["Open Issues and Risks:", "- flaky test on CI"].join("\n"),
    );
    expect(cp).not.toBeNull();
    expect(cp!.version).toBe(1);
    expect(cp!.openIssues[0]!.text).toContain("flaky test");
  });

  it("returns null for empty input", () => {
    expect(parseLegacySummaryToCheckpoint("   ")).toBeNull();
  });
});

describe("mergeCheckpoints objective lifecycle", () => {
  it("supersedes base active objectives not present in update", () => {
    const base = createEmptyCheckpoint();
    base.objective.push({ text: "old goal", status: "still_active" });

    const merged = mergeCheckpoints(base, {
      objective: [{ text: "new goal", status: "still_active" }],
    });

    const old = merged.objective.find((o) => o.text === "old goal");
    const fresh = merged.objective.find((o) => o.text === "new goal");
    expect(old?.status).toBe("superseded");
    expect(fresh?.status).toBe("still_active");
  });

  it("keeps base objectives when update has none", () => {
    const base = createEmptyCheckpoint();
    base.objective.push({ text: "keep me", status: "still_active" });
    const merged = mergeCheckpoints(base, {});
    expect(merged.objective).toHaveLength(1);
    expect(merged.objective[0]!.status).toBe("still_active");
  });
});

describe("render*Memory helpers", () => {
  it("renders constraint memory block", () => {
    const items = [
      createCheckpointItem("hardConstraints", "no force push", "high", []),
    ];
    const text = renderConstraintMemory(items);
    expect(text).toContain("<context-constraints>");
    expect(text).toContain("- no force push");
    expect(text).toContain("</context-constraints>");
  });

  it("renders objective memory grouped by status", () => {
    const text = renderObjectiveMemory([
      { text: "active goal", status: "still_active" },
      { text: "done goal", status: "resolved" },
      { text: "old goal", status: "superseded" },
    ]);
    expect(text).toContain("Still Active:");
    expect(text).toContain("- active goal");
    expect(text).toContain("Resolved:");
    expect(text).toContain("Superseded:");
  });

  it("renders decision memory trace", () => {
    const text = renderDecisionMemory(["chose plan A", "rejected plan B"]);
    expect(text).toContain("<context-decisions>");
    expect(text).toContain("- chose plan A");
  });

  it("renders working memory with facts, decisions, and retrieved priors", () => {
    const cp = createEmptyCheckpoint();
    cp.verifiedFacts.push(
      createCheckpointItem("verifiedFacts", "fact A", "high", []),
    );
    cp.openIssues.push(
      createCheckpointItem("openIssues", "issue A", "medium", []),
    );

    const text = renderWorkingMemory(
      cp,
      ["decided X"],
      [
        {
          savedAt: "2025-01-01T00:00:00.000Z",
          transcriptPath: "/p.jsonl",
          summarizedFrom: 1,
          summarizedTo: 3,
          messageCount: 2,
          summaryPreview: "prior work summary",
          toolNames: [],
          errorCodes: [],
          primaryPaths: [],
          issueSignatures: [],
        },
      ],
    );

    expect(text).toBeDefined();
    expect(text).toContain("<context-working-memory>");
    expect(text).toContain("fact A");
    expect(text).toContain("issue A");
    expect(text).toContain("Decision Trace:");
    expect(text).toContain("- decided X");
    expect(text).toContain("Relevant Prior Attempts:");
  });

  it("returns undefined working memory when nothing to render", () => {
    const text = renderWorkingMemory(createEmptyCheckpoint(), [], []);
    expect(text).toBeUndefined();
  });
});

describe("pruneCheckpointOnce", () => {
  it("prunes sections in priority order and reports progress", () => {
    const cp = createEmptyCheckpoint();
    cp.relevantPriors.push(
      createCheckpointItem("relevantPriors", "prior", "low", []),
    );
    cp.hardConstraints.push(
      createCheckpointItem("hardConstraints", "constraint", "high", []),
    );

    // First prune removes from relevantPriors (highest priority list)
    expect(pruneCheckpointOnce(cp)).toBe(true);
    expect(cp.relevantPriors).toHaveLength(0);
    expect(cp.hardConstraints).toHaveLength(1);

    // Next prune falls through to hardConstraints
    expect(pruneCheckpointOnce(cp)).toBe(true);
    expect(cp.hardConstraints).toHaveLength(0);

    // Nothing left
    expect(pruneCheckpointOnce(cp)).toBe(false);
  });

  it("prunes objective when only objective remains", () => {
    const cp = createEmptyCheckpoint();
    cp.objective.push({ text: "goal", status: "still_active" });
    expect(pruneCheckpointOnce(cp)).toBe(true);
    expect(cp.objective).toHaveLength(0);
    expect(pruneCheckpointOnce(cp)).toBe(false);
  });
});

describe("cloneCheckpoint evidence refs", () => {
  it("deep clones evidence message indexes", () => {
    const original = createEmptyCheckpoint();
    original.verifiedFacts.push({
      id: "vf-1",
      text: "fact",
      confidence: "high",
      evidenceRefs: [
        {
          kind: "tool",
          transcriptPath: "/t",
          summarizedFrom: 1,
          summarizedTo: 2,
          messageIndexes: [4, 5],
        },
      ],
    });

    const cloned = cloneCheckpoint(original);
    expect(cloned.verifiedFacts[0]!.evidenceRefs[0]!.messageIndexes).toEqual([
      4, 5,
    ]);
    expect(cloned.verifiedFacts[0]!.evidenceRefs[0]!.messageIndexes).not.toBe(
      original.verifiedFacts[0]!.evidenceRefs[0]!.messageIndexes,
    );
  });
});
