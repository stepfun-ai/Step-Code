import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@step-cli/protocol";
import {
  buildTranscriptSaveArtifact,
  extractExplicitObjectiveText,
} from "./conversation-memory-transcript.js";

describe("extractExplicitObjectiveText", () => {
  it("ignores ordinary chat prompts from issue #73", () => {
    expect(extractExplicitObjectiveText("你是谁？")).toBeUndefined();
    expect(
      extractExplicitObjectiveText("你去读取一下README的文件内容。"),
    ).toBeUndefined();
    expect(extractExplicitObjectiveText("what's next?")).toBeUndefined();
  });

  it("extracts /goal text and ignores control verbs", () => {
    expect(extractExplicitObjectiveText("/goal 读取 README")).toBe(
      "读取 README",
    );
    expect(extractExplicitObjectiveText("/goal status")).toBeUndefined();
    expect(extractExplicitObjectiveText("/goal pause waiting")).toBeUndefined();
    expect(
      extractExplicitObjectiveText("/goal start sess-1 ship the feature"),
    ).toBe("sess-1 ship the feature");
  });

  it("extracts labeled and wake-prompt objectives", () => {
    expect(extractExplicitObjectiveText("Goal: ship the release")).toBe(
      "ship the release",
    );
    expect(extractExplicitObjectiveText("当前目标：迁移鉴权")).toBe("迁移鉴权");
    expect(
      extractExplicitObjectiveText(
        [
          "You are working toward this long-running session goal:",
          "",
          "Keep the SUMMARY panel accurate",
          "",
          "Goal id: goal-1",
          "Goal iteration: 0",
        ].join("\n"),
      ),
    ).toBe("Keep the SUMMARY panel accurate");
  });
});

describe("buildTranscriptSaveArtifact", () => {
  it("does not list ordinary user chat under Goals", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你是谁？" },
      { role: "assistant", content: "助手" },
      { role: "user", content: "/goal 读取 README" },
    ];

    const artifact = buildTranscriptSaveArtifact({
      workspaceRoot: "/tmp",
      sessionId: "sess",
      summarizedFrom: 0,
      summarizedTo: 3,
      savedAt: "2026-06-19T10:12:37.000Z",
      messages,
    });

    expect(artifact.entry.summaryPreview).toMatch(/Goals:\n- 读取 README/u);
    expect(artifact.entry.summaryPreview).toContain("User turns:");
    expect(artifact.entry.summaryPreview).toContain("你是谁？");
    expect(artifact.entry.summaryPreview).not.toMatch(/Goals:\n- 你是谁？/u);
  });
});
