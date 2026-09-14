import type { ChatMessage } from "@step-cli/protocol";
import { assistantMessagePreviewText } from "@step-cli/utils/assistant-message.js";
import { normalizeWhitespace, truncateText } from "@step-cli/utils/text.js";
import { userMessagePreviewText } from "@step-cli/utils/user-message.js";
import type {
  MemoryCheckpoint,
  MemoryCheckpointItem,
  MemoryEvidenceRef,
  MemoryCheckpointObjectiveEntry,
  MemoryCheckpointObjectiveStatus,
  TranscriptIndexEntry,
} from "./conversation-memory.js";
import { parseToolResult } from "./conversation-memory-tool-result.js";
import {
  dedupeMessagesKeepingNewest,
  extractExplicitObjectiveText,
  renderTranscriptEntrySummary,
} from "./conversation-memory-transcript.js";

export function createEmptyCheckpoint(): MemoryCheckpoint {
  return {
    version: 1,
    objective: [],
    hardConstraints: [],
    verifiedFacts: [],
    attemptedActions: [],
    openIssues: [],
    nextSteps: [],
    relevantPriors: [],
  };
}

export function cloneCheckpoint(
  checkpoint: MemoryCheckpoint,
): MemoryCheckpoint {
  return {
    version: 1,
    objective: checkpoint.objective.map(cloneCheckpointObjectiveEntry),
    hardConstraints: checkpoint.hardConstraints.map(cloneCheckpointItem),
    verifiedFacts: checkpoint.verifiedFacts.map(cloneCheckpointItem),
    attemptedActions: checkpoint.attemptedActions.map(cloneCheckpointItem),
    openIssues: checkpoint.openIssues.map(cloneCheckpointItem),
    nextSteps: checkpoint.nextSteps.map(cloneCheckpointItem),
    relevantPriors: checkpoint.relevantPriors.map(cloneCheckpointItem),
  };
}

function cloneCheckpointObjectiveEntry(
  entry: MemoryCheckpointObjectiveEntry,
): MemoryCheckpointObjectiveEntry {
  return {
    text: entry.text,
    status: entry.status,
  };
}

function cloneCheckpointItem(item: MemoryCheckpointItem): MemoryCheckpointItem {
  return {
    id: item.id,
    text: item.text,
    confidence: item.confidence,
    evidenceRefs: item.evidenceRefs.map((ref) => ({
      kind: ref.kind,
      transcriptPath: ref.transcriptPath,
      summarizedFrom: ref.summarizedFrom,
      summarizedTo: ref.summarizedTo,
      messageIndexes: ref.messageIndexes ? [...ref.messageIndexes] : undefined,
    })),
  };
}

export function normalizeCheckpoint(
  checkpoint: MemoryCheckpoint | undefined | null,
): MemoryCheckpoint | null {
  if (!checkpoint || typeof checkpoint !== "object") {
    return null;
  }

  return {
    version: 1,
    objective: normalizeCheckpointObjective(checkpoint.objective),
    hardConstraints: normalizeCheckpointItems(
      "hardConstraints",
      checkpoint.hardConstraints,
    ),
    verifiedFacts: normalizeCheckpointItems(
      "verifiedFacts",
      checkpoint.verifiedFacts,
    ),
    attemptedActions: normalizeCheckpointItems(
      "attemptedActions",
      checkpoint.attemptedActions,
    ),
    openIssues: normalizeCheckpointItems("openIssues", checkpoint.openIssues),
    nextSteps: normalizeCheckpointItems("nextSteps", checkpoint.nextSteps),
    relevantPriors: normalizeCheckpointItems(
      "relevantPriors",
      checkpoint.relevantPriors,
    ),
  };
}

function normalizeCheckpointObjective(
  objective: unknown,
): MemoryCheckpointObjectiveEntry[] {
  if (!Array.isArray(objective)) {
    return [];
  }

  const merged = new Map<string, MemoryCheckpointObjectiveEntry>();
  const order: string[] = [];

  for (const rawEntry of objective) {
    const nextEntry = normalizeCheckpointObjectiveEntry(rawEntry);
    if (!nextEntry) {
      continue;
    }

    const key = normalizeMemoryKey(nextEntry.text).toLowerCase();
    if (merged.has(key)) {
      const existingIndex = order.indexOf(key);
      if (existingIndex >= 0) {
        order.splice(existingIndex, 1);
      }
    }
    order.push(key);
    merged.set(key, nextEntry);
  }

  return order
    .slice(-4)
    .map((key) => merged.get(key))
    .filter(
      (entry): entry is MemoryCheckpointObjectiveEntry => entry !== undefined,
    );
}

function normalizeCheckpointObjectiveEntry(
  entry: unknown,
): MemoryCheckpointObjectiveEntry | null {
  const legacyText =
    typeof entry === "string"
      ? entry
      : entry &&
          typeof entry === "object" &&
          typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text
        : null;
  const text =
    typeof legacyText === "string"
      ? truncateText({
          text: legacyText.trim(),
          maxChars: 220,
          strategy: "tail",
        }).text
      : "";
  if (text.length === 0) {
    return null;
  }

  return {
    text,
    status: normalizeCheckpointObjectiveStatus(
      typeof entry === "object" && entry
        ? (entry as { status?: unknown }).status
        : undefined,
    ),
  };
}

function normalizeCheckpointObjectiveStatus(
  value: unknown,
): MemoryCheckpointObjectiveStatus {
  if (
    value === "still_active" ||
    value === "resolved" ||
    value === "superseded"
  ) {
    return value;
  }

  return "still_active";
}

function normalizeCheckpointItems(
  section:
    | "hardConstraints"
    | "verifiedFacts"
    | "attemptedActions"
    | "openIssues"
    | "nextSteps"
    | "relevantPriors",
  items: MemoryCheckpointItem[] | undefined,
): MemoryCheckpointItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const merged = new Map<string, MemoryCheckpointItem>();
  const order: string[] = [];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }

    const text =
      typeof rawItem.text === "string"
        ? truncateText({
            text: rawItem.text.trim(),
            maxChars: 260,
            strategy: "tail",
          }).text
        : "";
    if (text.length === 0) {
      continue;
    }

    const key = normalizeMemoryKey(text).toLowerCase();
    const nextItem: MemoryCheckpointItem = {
      id:
        typeof rawItem.id === "string" && rawItem.id.trim().length > 0
          ? rawItem.id
          : createCheckpointItemId(section, text),
      text,
      confidence: normalizeCheckpointConfidence(rawItem.confidence),
      evidenceRefs: normalizeEvidenceRefs(rawItem.evidenceRefs),
    };

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, nextItem);
      order.push(key);
      continue;
    }

    existing.confidence = maxConfidence(
      existing.confidence,
      nextItem.confidence,
    );
    existing.evidenceRefs = mergeEvidenceRefs(
      existing.evidenceRefs,
      nextItem.evidenceRefs,
    );
  }

  const limits = {
    hardConstraints: 8,
    verifiedFacts: 12,
    attemptedActions: 12,
    openIssues: 8,
    nextSteps: 6,
    relevantPriors: 6,
  };

  return order
    .slice(-limits[section])
    .map((key) => merged.get(key) as MemoryCheckpointItem);
}

function normalizeCheckpointConfidence(
  value: unknown,
): MemoryCheckpointItem["confidence"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

function maxConfidence(
  left: MemoryCheckpointItem["confidence"],
  right: MemoryCheckpointItem["confidence"],
): MemoryCheckpointItem["confidence"] {
  const rank = {
    low: 0,
    medium: 1,
    high: 2,
  };

  return rank[right] > rank[left] ? right : left;
}

function normalizeEvidenceRefs(
  refs: MemoryEvidenceRef[] | undefined,
): MemoryEvidenceRef[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    return [];
  }

  const deduped = new Map<string, MemoryEvidenceRef>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }

    const next: MemoryEvidenceRef = {
      kind:
        ref.kind === "user" ||
        ref.kind === "assistant" ||
        ref.kind === "tool" ||
        ref.kind === "mixed"
          ? ref.kind
          : "mixed",
      transcriptPath:
        typeof ref.transcriptPath === "string" ? ref.transcriptPath : undefined,
      summarizedFrom:
        typeof ref.summarizedFrom === "number" ? ref.summarizedFrom : undefined,
      summarizedTo:
        typeof ref.summarizedTo === "number" ? ref.summarizedTo : undefined,
      messageIndexes: Array.isArray(ref.messageIndexes)
        ? ref.messageIndexes
            .filter((value): value is number => typeof value === "number")
            .slice(0, 8)
        : undefined,
    };

    const key = JSON.stringify(next);
    deduped.set(key, next);
  }

  return [...deduped.values()].slice(0, 4);
}

function mergeEvidenceRefs(
  left: MemoryEvidenceRef[],
  right: MemoryEvidenceRef[],
): MemoryEvidenceRef[] {
  return normalizeEvidenceRefs([...left, ...right]);
}

export function createCheckpointItem(
  section:
    | "hardConstraints"
    | "verifiedFacts"
    | "attemptedActions"
    | "openIssues"
    | "nextSteps"
    | "relevantPriors",
  text: string,
  confidence: MemoryCheckpointItem["confidence"],
  evidenceRefs: MemoryEvidenceRef[],
): MemoryCheckpointItem {
  const normalized = truncateText({
    text: text.trim(),
    maxChars: 260,
    strategy: "tail",
  }).text;

  return {
    id: createCheckpointItemId(section, normalized),
    text: normalized,
    confidence,
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
  };
}

function createCheckpointItemId(section: string, text: string): string {
  const slug = normalizeMemoryKey(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${section}:${slug || "item"}`;
}

export function mergeCheckpoints(
  base: MemoryCheckpoint,
  update: Partial<MemoryCheckpoint>,
): MemoryCheckpoint {
  return normalizeCheckpoint({
    version: 1,
    objective: mergeCheckpointObjectives(base.objective, update.objective),
    hardConstraints: [
      ...base.hardConstraints,
      ...(update.hardConstraints ?? []),
    ],
    verifiedFacts: [...base.verifiedFacts, ...(update.verifiedFacts ?? [])],
    attemptedActions: [
      ...base.attemptedActions,
      ...(update.attemptedActions ?? []),
    ],
    openIssues: [...base.openIssues, ...(update.openIssues ?? [])],
    nextSteps: [...base.nextSteps, ...(update.nextSteps ?? [])],
    relevantPriors: [...base.relevantPriors, ...(update.relevantPriors ?? [])],
  }) as MemoryCheckpoint;
}

function mergeCheckpointObjectives(
  base: MemoryCheckpointObjectiveEntry[],
  update: MemoryCheckpoint["objective"] | undefined,
): MemoryCheckpointObjectiveEntry[] {
  const normalizedBase = normalizeCheckpointObjective(base);
  const normalizedUpdate = normalizeCheckpointObjective(update);
  if (normalizedUpdate.length === 0) {
    return normalizedBase;
  }

  const incomingActiveKeys = new Set(
    normalizedUpdate
      .filter((entry) => entry.status === "still_active")
      .map((entry) => normalizeMemoryKey(entry.text).toLowerCase()),
  );

  const adjustedBase =
    incomingActiveKeys.size === 0
      ? normalizedBase
      : normalizedBase.map((entry) => {
          if (entry.status !== "still_active") {
            return entry;
          }

          if (
            incomingActiveKeys.has(normalizeMemoryKey(entry.text).toLowerCase())
          ) {
            return entry;
          }

          return {
            ...entry,
            status: "superseded" as const,
          };
        });

  return normalizeCheckpointObjective([...adjustedBase, ...normalizedUpdate]);
}

export function buildCheckpointFromMessages(
  messages: ChatMessage[],
  input: {
    transcriptPath?: string;
    fromIndex: number;
    toIndex: number;
  },
): Partial<MemoryCheckpoint> {
  const objective = extractObjectiveCandidates(messages);
  const hardConstraints = extractConstraintCandidates(messages).map((text) =>
    createCheckpointItem("hardConstraints", text, "high", [
      buildEvidenceRef(messages, input),
    ]),
  );
  const verifiedFacts: MemoryCheckpointItem[] = [];
  const attemptedActions: MemoryCheckpointItem[] = [];
  const openIssues: MemoryCheckpointItem[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.tool_calls && message.tool_calls.length > 0) {
        attemptedActions.push(
          createCheckpointItem(
            "attemptedActions",
            `Planned tools: ${message.tool_calls.map((call) => call.function.name).join(", ")}`,
            "medium",
            [buildEvidenceRef([message], input)],
          ),
        );
      }

      const preview = assistantMessagePreviewText(message);
      if (preview.trim().length > 0 && !message.tool_calls?.length) {
        attemptedActions.push(
          createCheckpointItem("attemptedActions", preview, "low", [
            buildEvidenceRef([message], input),
          ]),
        );
      }
      continue;
    }

    if (message.role !== "tool") {
      continue;
    }

    const parsed = parseToolResult(message.content);
    attemptedActions.push(
      createCheckpointItem(
        "attemptedActions",
        `${message.name}: ${parsed.summary}`,
        parsed.ok === false || parsed.error ? "medium" : "high",
        [buildEvidenceRef([message], input)],
      ),
    );

    if (parsed.primaryPath) {
      verifiedFacts.push(
        createCheckpointItem(
          "verifiedFacts",
          `Observed path via ${message.name}: ${parsed.primaryPath}`,
          "high",
          [buildEvidenceRef([message], input)],
        ),
      );
    }

    if (parsed.ok === false || parsed.error) {
      const detail = parsed.errorCode
        ? `${parsed.errorCode}: ${parsed.error ?? parsed.summary}`
        : (parsed.error ?? parsed.summary);
      openIssues.push(
        createCheckpointItem(
          "openIssues",
          `${message.name}: ${detail}`,
          "high",
          [buildEvidenceRef([message], input)],
        ),
      );
      continue;
    }

    verifiedFacts.push(
      createCheckpointItem(
        "verifiedFacts",
        `${message.name}: ${parsed.summary}`,
        "high",
        [buildEvidenceRef([message], input)],
      ),
    );
  }

  return {
    objective,
    hardConstraints,
    verifiedFacts,
    attemptedActions,
    openIssues,
  };
}

function buildEvidenceRef(
  messages: ChatMessage[],
  input: {
    transcriptPath?: string;
    fromIndex: number;
    toIndex: number;
  },
): MemoryEvidenceRef {
  return {
    kind: inferEvidenceKind(messages),
    transcriptPath: input.transcriptPath,
    summarizedFrom: input.transcriptPath ? input.fromIndex : undefined,
    summarizedTo: input.transcriptPath ? input.toIndex : undefined,
    messageIndexes: input.transcriptPath
      ? undefined
      : buildMessageIndexes(input.fromIndex, input.toIndex),
  };
}

function buildMessageIndexes(fromIndex: number, toIndex: number): number[] {
  const indexes: number[] = [];
  for (
    let index = fromIndex;
    index < toIndex && indexes.length < 8;
    index += 1
  ) {
    indexes.push(index);
  }
  return indexes;
}

function inferEvidenceKind(messages: ChatMessage[]): MemoryEvidenceRef["kind"] {
  const roles = new Set(messages.map((message) => message.role));
  if (roles.size !== 1) {
    return "mixed";
  }

  const only = [...roles][0];
  if (only === "user" || only === "assistant" || only === "tool") {
    return only;
  }

  return "mixed";
}

function extractObjectiveCandidates(
  messages: ChatMessage[],
): MemoryCheckpointObjectiveEntry[] {
  const candidates: string[] = [];

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const preview = userMessagePreviewText(message).trim();
    const objective = extractExplicitObjectiveText(preview);
    if (objective) {
      candidates.push(objective);
    }
  }

  const normalized = normalizeCheckpointObjective(candidates);
  if (normalized.length <= 1) {
    return normalized;
  }

  return normalized.map((entry, index) => ({
    ...entry,
    status: index === normalized.length - 1 ? "still_active" : "superseded",
  }));
}

function extractConstraintCandidates(messages: ChatMessage[]): string[] {
  const candidates: string[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "system") {
      continue;
    }

    const content =
      message.role === "user"
        ? userMessagePreviewText(message)
        : message.content;
    for (const sentence of splitCandidateLines(content)) {
      const lower = sentence.toLowerCase();
      if (
        lower.includes("do not") ||
        lower.includes("don't") ||
        lower.includes("must") ||
        lower.includes("must not") ||
        lower.includes("only") ||
        sentence.includes("不要") ||
        sentence.includes("先不要") ||
        sentence.includes("必须") ||
        sentence.includes("只能")
      ) {
        candidates.push(sentence);
      }
    }
  }

  return dedupeMessagesKeepingNewest(candidates).slice(-6);
}

function splitCandidateLines(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?。！？])/u)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length > 0)
    .map(
      (entry) =>
        truncateText({
          text: entry,
          maxChars: 220,
          strategy: "tail",
        }).text,
    );
}

export function parseSummaryTextToCheckpoint(
  summaryText: string,
  input: {
    transcriptPath?: string;
    fromIndex: number;
    toIndex: number;
  },
): Partial<MemoryCheckpoint> | null {
  const jsonParsed = parseCheckpointJson(summaryText);
  if (jsonParsed) {
    const evidence = [
      {
        kind: "mixed" as const,
        transcriptPath: input.transcriptPath,
        summarizedFrom: input.transcriptPath ? input.fromIndex : undefined,
        summarizedTo: input.transcriptPath ? input.toIndex : undefined,
        messageIndexes: input.transcriptPath
          ? undefined
          : buildMessageIndexes(input.fromIndex, input.toIndex),
      },
    ];
    return {
      objective: normalizeCheckpointObjective(jsonParsed.objective),
      hardConstraints: parseCheckpointItemsFromStrings(
        "hardConstraints",
        jsonParsed.hardConstraints,
        "medium",
        evidence,
      ),
      verifiedFacts: parseCheckpointItemsFromStrings(
        "verifiedFacts",
        jsonParsed.verifiedFacts,
        "medium",
        evidence,
      ),
      attemptedActions: parseCheckpointItemsFromStrings(
        "attemptedActions",
        jsonParsed.attemptedActions,
        "medium",
        evidence,
      ),
      openIssues: parseCheckpointItemsFromStrings(
        "openIssues",
        jsonParsed.openIssues,
        "medium",
        evidence,
      ),
      nextSteps: parseCheckpointItemsFromStrings(
        "nextSteps",
        jsonParsed.nextSteps,
        "medium",
        evidence,
      ),
    };
  }

  return parseSummarySectionsToCheckpoint(summaryText, input);
}

function parseCheckpointJson(raw: string): Record<string, unknown> | null {
  const candidates = [raw.trim()];
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.unshift(fenceMatch[1].trim());
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function parseSummarySectionsToCheckpoint(
  summaryText: string,
  input: {
    transcriptPath?: string;
    fromIndex: number;
    toIndex: number;
  },
): Partial<MemoryCheckpoint> | null {
  const sections = parseSummarySections(summaryText);
  const evidence = [
    {
      kind: "mixed" as const,
      transcriptPath: input.transcriptPath,
      summarizedFrom: input.transcriptPath ? input.fromIndex : undefined,
      summarizedTo: input.transcriptPath ? input.toIndex : undefined,
      messageIndexes: input.transcriptPath
        ? undefined
        : buildMessageIndexes(input.fromIndex, input.toIndex),
    },
  ];

  const objective = normalizeCheckpointObjective([
    ...createObjectiveEntries(
      [
        ...splitBulletSection(sections["current objective"]),
        ...splitBulletSection(sections.goals),
      ],
      "still_active",
    ),
    ...createObjectiveEntries(
      splitBulletSection(sections["resolved objectives"]),
      "resolved",
    ),
    ...createObjectiveEntries(
      splitBulletSection(sections["superseded objectives"]),
      "superseded",
    ),
  ]);
  const hardConstraints = parseCheckpointItemsFromStrings(
    "hardConstraints",
    [
      ...splitBulletSection(sections["important context and constraints"]),
      ...splitBulletSection(sections.constraints),
    ],
    "low",
    evidence,
  );
  const verifiedFacts = parseCheckpointItemsFromStrings(
    "verifiedFacts",
    [
      ...splitBulletSection(sections["progress and key findings"]),
      ...splitBulletSection(sections.outcomes),
      ...splitBulletSection(sections["verified facts"]),
    ],
    "low",
    evidence,
  );
  const attemptedActions = parseCheckpointItemsFromStrings(
    "attemptedActions",
    splitBulletSection(sections.actions),
    "low",
    evidence,
  );
  const openIssues = parseCheckpointItemsFromStrings(
    "openIssues",
    [
      ...splitBulletSection(sections["open issues and risks"]),
      ...splitBulletSection(sections.issues),
    ],
    "low",
    evidence,
  );
  const nextSteps = parseCheckpointItemsFromStrings(
    "nextSteps",
    splitBulletSection(sections["next steps"]),
    "low",
    evidence,
  );

  if (
    objective.length === 0 &&
    hardConstraints.length === 0 &&
    verifiedFacts.length === 0 &&
    attemptedActions.length === 0 &&
    openIssues.length === 0 &&
    nextSteps.length === 0
  ) {
    const normalized = normalizeWhitespace(summaryText);
    if (normalized.length === 0) {
      return null;
    }

    return {
      verifiedFacts: [
        createCheckpointItem("verifiedFacts", normalized, "low", evidence),
      ],
    };
  }

  return {
    objective,
    hardConstraints,
    verifiedFacts,
    attemptedActions,
    openIssues,
    nextSteps,
  };
}

export function parseLegacySummaryToCheckpoint(
  summary: string,
): MemoryCheckpoint | null {
  const parsed = parseSummarySectionsToCheckpoint(summary, {
    fromIndex: 0,
    toIndex: 0,
  });
  if (!parsed) {
    return null;
  }

  return mergeCheckpoints(createEmptyCheckpoint(), parsed);
}

function parseSummarySections(summaryText: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "root";
  const lines = summaryText.split("\n");

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9\s&/-]+):\s*$/);
    if (match?.[1]) {
      current = normalizeWhitespace(match[1]).toLowerCase();
      if (!sections[current]) {
        sections[current] = "";
      }
      continue;
    }

    sections[current] = sections[current]
      ? `${sections[current]}\n${line}`
      : line;
  }

  return sections;
}

function splitBulletSection(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        truncateText({
          text: normalizeWhitespace(line),
          maxChars: 240,
          strategy: "tail",
        }).text,
    );
}

function createObjectiveEntries(
  values: readonly string[],
  status: MemoryCheckpointObjectiveStatus,
): MemoryCheckpointObjectiveEntry[] {
  return normalizeCheckpointObjective(
    values.map((text) => ({
      text,
      status,
    })),
  );
}

function parseCheckpointItemsFromStrings(
  section:
    | "hardConstraints"
    | "verifiedFacts"
    | "attemptedActions"
    | "openIssues"
    | "nextSteps",
  values: unknown,
  confidence: MemoryCheckpointItem["confidence"],
  evidenceRefs: MemoryEvidenceRef[],
): MemoryCheckpointItem[] {
  const strings = Array.isArray(values)
    ? values.filter((entry): entry is string => typeof entry === "string")
    : typeof values === "string"
      ? splitBulletSection(values)
      : [];

  return strings
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value.length > 0)
    .map((value) =>
      createCheckpointItem(section, value, confidence, evidenceRefs),
    );
}

export function renderCheckpointText(
  checkpoint: MemoryCheckpoint,
  input?: {
    title?: string;
    notes?: Array<string | undefined>;
  },
): string {
  const lines: string[] = [];

  if (input?.title) {
    lines.push(`[${input.title}]`, "");
  }

  const notes = (input?.notes ?? []).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (notes.length > 0) {
    for (const note of notes) {
      lines.push(note);
    }
    lines.push("");
  }

  pushObjectiveSections(lines, checkpoint.objective, {
    activeTitle: "Current Objective",
    resolvedTitle: "Resolved Objectives",
    supersededTitle: "Superseded Objectives",
  });
  pushCheckpointSection(lines, "Hard Constraints", checkpoint.hardConstraints);
  pushCheckpointSection(lines, "Verified Facts", checkpoint.verifiedFacts);
  pushCheckpointSection(
    lines,
    "Attempted Actions",
    checkpoint.attemptedActions,
  );
  pushCheckpointSection(lines, "Open Issues", checkpoint.openIssues);
  pushCheckpointSection(lines, "Next Steps", checkpoint.nextSteps);
  pushCheckpointSection(
    lines,
    "Relevant Prior Attempts",
    checkpoint.relevantPriors,
  );

  return lines.join("\n").trim();
}

function pushCheckpointSection(
  lines: string[],
  title: string,
  items: MemoryCheckpointItem[],
): void {
  if (items.length === 0) {
    return;
  }

  lines.push(`${title}:`);
  for (const item of items) {
    const ref = renderEvidenceRefs(item.evidenceRefs);
    const suffix = ref ? ` [refs: ${ref}]` : "";
    lines.push(`- ${item.text} (${item.confidence})${suffix}`);
  }
}

function renderEvidenceRefs(refs: MemoryEvidenceRef[]): string {
  return refs
    .map((ref) => {
      if (ref.transcriptPath) {
        const range =
          typeof ref.summarizedFrom === "number" &&
          typeof ref.summarizedTo === "number"
            ? `:${ref.summarizedFrom}-${ref.summarizedTo}`
            : "";
        return `${ref.transcriptPath}${range}`;
      }

      if (ref.messageIndexes && ref.messageIndexes.length > 0) {
        return `messages ${ref.messageIndexes.join(",")}`;
      }

      return "";
    })
    .filter((entry) => entry.length > 0)
    .join("; ");
}

export function renderConstraintMemory(items: MemoryCheckpointItem[]): string {
  return [
    "<context-constraints>",
    "Hard constraints carried from earlier work. Treat them as requirements unless new user input changes them.",
    ...items.map((item) => `- ${item.text}`),
    "</context-constraints>",
  ].join("\n");
}

export function renderObjectiveMemory(
  objective: readonly MemoryCheckpointObjectiveEntry[],
): string {
  const lines = [
    "<context-objective>",
    "Persisted user objectives from earlier work. Treat them as background memory, and prefer the current turn when there is any conflict.",
  ];

  pushObjectiveSections(lines, objective, {
    activeTitle: "Still Active",
    resolvedTitle: "Resolved",
    supersededTitle: "Superseded",
  });
  lines.push("</context-objective>");
  return lines.join("\n");
}

export function renderDecisionMemory(decisionChain: string[]): string {
  return [
    "<context-decisions>",
    "Recent decision trace from earlier work.",
    ...decisionChain.map((entry) => `- ${entry}`),
    "</context-decisions>",
  ].join("\n");
}

export function renderWorkingMemory(
  checkpoint: MemoryCheckpoint,
  decisionChain: string[],
  retrievedEntries: TranscriptIndexEntry[],
): string | undefined {
  const lines = [
    "<context-working-memory>",
    "Working memory from earlier compacted conversation. Use it as context, but prefer fresh evidence when conflicts appear.",
  ];

  const priorItems = normalizeCheckpointItems("relevantPriors", [
    ...checkpoint.relevantPriors,
    ...retrievedEntries.map((entry) =>
      createCheckpointItem(
        "relevantPriors",
        renderTranscriptEntrySummary(entry),
        "medium",
        [
          {
            kind: "mixed",
            transcriptPath: entry.transcriptPath,
            summarizedFrom: entry.summarizedFrom,
            summarizedTo: entry.summarizedTo,
          },
        ],
      ),
    ),
  ]);

  pushCheckpointSection(lines, "Verified Facts", checkpoint.verifiedFacts);
  pushCheckpointSection(
    lines,
    "Attempted Actions",
    checkpoint.attemptedActions,
  );
  pushCheckpointSection(lines, "Open Issues", checkpoint.openIssues);
  pushCheckpointSection(lines, "Next Steps", checkpoint.nextSteps);
  pushCheckpointSection(lines, "Relevant Prior Attempts", priorItems);
  if (decisionChain.length > 0) {
    lines.push("Decision Trace:");
    for (const entry of decisionChain) {
      lines.push(`- ${entry}`);
    }
  }
  lines.push("</context-working-memory>");

  return lines.length > 3 ? lines.join("\n") : undefined;
}

export function pruneCheckpointOnce(checkpoint: MemoryCheckpoint): boolean {
  for (const key of [
    "relevantPriors",
    "attemptedActions",
    "verifiedFacts",
    "openIssues",
    "nextSteps",
  ] as const) {
    if (checkpoint[key].length > 0) {
      checkpoint[key] = checkpoint[key].slice(1);
      return true;
    }
  }

  if (checkpoint.objective.length > 0) {
    checkpoint.objective = checkpoint.objective.slice(1);
    return true;
  }

  if (checkpoint.hardConstraints.length > 0) {
    checkpoint.hardConstraints = checkpoint.hardConstraints.slice(1);
    return true;
  }

  return false;
}

function normalizeMemoryKey(text: string): string {
  return normalizeWhitespace(text);
}

function pushSection(
  lines: string[],
  title: string,
  entries: readonly string[],
  limit: number,
): void {
  if (entries.length === 0) {
    return;
  }

  lines.push(`${title}:`);
  for (const entry of entries.slice(-limit)) {
    lines.push(`- ${entry}`);
  }
}

function pushObjectiveSections(
  lines: string[],
  entries: readonly MemoryCheckpointObjectiveEntry[],
  input: {
    activeTitle: string;
    resolvedTitle: string;
    supersededTitle: string;
  },
): void {
  const active = entries
    .filter((entry) => entry.status === "still_active")
    .map((entry) => entry.text);
  const resolved = entries
    .filter((entry) => entry.status === "resolved")
    .map((entry) => entry.text);
  const superseded = entries
    .filter((entry) => entry.status === "superseded")
    .map((entry) => entry.text);

  pushSection(lines, input.activeTitle, active, 4);
  pushSection(lines, input.resolvedTitle, resolved, 4);
  pushSection(lines, input.supersededTitle, superseded, 4);
}
