import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  encodeStorageKey,
  decodeStorageKey,
  resolveStorageLayout,
  getSessionDirectory,
  getSessionEventsFilePath,
  getSessionSnapshotFilePath,
  getSessionTriggersFilePath,
  getSessionHostPolicyFilePath,
  getSessionAssetsDirectory,
  getSessionProgressDirectory,
  getSessionProgressFilePath,
  getSessionTeamInboxDirectory,
  getSessionTraceDirectory,
  getSessionArtifactsRootDirectory,
  getSessionTranscriptsDirectory,
  getSessionsRootDirectory,
  getRootTeamInboxDirectory,
  getThemesDirectory,
  getWorkspaceTrustFilePath,
  toStorageRelativePath,
  type StepCliResolvedStorageLayout,
} from "./layout.js";

function createLayout(rootDir: string): StepCliResolvedStorageLayout {
  return resolveStorageLayout(rootDir, {
    workspaceTrustFile: "workspace-trust.json",
    teamInboxDir: "team/inbox",
    themesDir: "themes",
    sessionAssetsDir: "assets",
    sessionProgressDir: "progress",
    sessionProgressFile: "progress.md",
    sessionArtifactsDir: "artifacts",
    sessionTranscriptsDir: "transcripts",
    sessionTeamInboxDir: "team/inbox",
    sessionTraceDir: "trace",
  });
}

describe("encodeStorageKey / decodeStorageKey", () => {
  it("round-trips a simple key", () => {
    expect(decodeStorageKey(encodeStorageKey("hello"))).toBe("hello");
  });

  it("encodes special characters", () => {
    const encoded = encodeStorageKey("a/b c");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain(" ");
    expect(decodeStorageKey(encoded)).toBe("a/b c");
  });

  it("trims whitespace before encoding", () => {
    expect(encodeStorageKey("  key  ")).toBe(encodeStorageKey("key"));
  });

  it.each([".", ".."])("encodes the reserved dot segment %s", (key) => {
    const encoded = encodeStorageKey(key);
    expect(encoded).not.toBe(key);
    expect(decodeStorageKey(encoded)).toBe(key);
    expect(encoded).not.toBe(encodeStorageKey(encoded));
  });

  it("preserves existing encodings for ordinary IDs containing dots", () => {
    expect(encodeStorageKey("release.v1")).toBe("release.v1");
    expect(encodeStorageKey(".hidden")).toBe(".hidden");
  });
});

describe("resolveStorageLayout", () => {
  it("resolves rootDir to absolute path", () => {
    const layout = resolveStorageLayout("./data", {
      workspaceTrustFile: "trust.json",
      teamInboxDir: "team",
      themesDir: "themes",
      sessionAssetsDir: "assets",
      sessionProgressDir: "progress",
      sessionProgressFile: "progress.md",
      sessionArtifactsDir: "artifacts",
      sessionTranscriptsDir: "transcripts",
      sessionTeamInboxDir: "team/inbox",
      sessionTraceDir: "trace",
    });
    expect(path.isAbsolute(layout.rootDir)).toBe(true);
  });
});

describe("getSessionDirectory", () => {
  it("returns sessions subdirectory with encoded id", () => {
    const layout = createLayout("/root");
    const dir = getSessionDirectory(layout, "my-session");
    expect(dir).toContain("sessions");
    expect(dir).toContain("my-session");
  });

  it.each([".", "..", " . ", " .. ", "../other", "a/b", "a\\b", "%2E%2E"])(
    "keeps %s in its own direct child directory",
    (sessionId) => {
      const layout = createLayout("/root");
      const dir = getSessionDirectory(layout, sessionId);
      expect(path.dirname(dir)).toBe(getSessionsRootDirectory(layout));
      expect(dir).not.toBe(getSessionsRootDirectory(layout));
      expect(dir).not.toBe(layout.rootDir);
    },
  );

  it.each(["", "   "])("rejects an empty storage key %j", (sessionId) => {
    expect(() => getSessionDirectory(createLayout("/root"), sessionId)).toThrow(
      "Session id must not be empty",
    );
  });
});

describe("getSessionEventsFilePath", () => {
  it("returns events.jsonl inside session directory", () => {
    const layout = createLayout("/root");
    const filePath = getSessionEventsFilePath(layout, "s1");
    expect(filePath).toMatch(/events\.jsonl$/);
  });
});

describe("getSessionsRootDirectory", () => {
  it("returns sessions subdirectory of rootDir", () => {
    const layout = createLayout("/data");
    const dir = getSessionsRootDirectory(layout);
    expect(dir).toBe(path.join(layout.rootDir, "sessions"));
  });
});

describe("getThemesDirectory", () => {
  it("returns themes subdirectory", () => {
    const layout = createLayout("/root");
    const dir = getThemesDirectory(layout);
    expect(dir).toContain("themes");
  });
});

describe("session file paths", () => {
  const layout = createLayout("/root");

  it("returns events.jsonl path", () => {
    expect(getSessionEventsFilePath(layout, "s1")).toMatch(/events\.jsonl$/);
  });

  it("returns session.json snapshot path", () => {
    expect(getSessionSnapshotFilePath(layout, "s1")).toMatch(/session\.json$/);
  });

  it("returns triggers.json path", () => {
    expect(getSessionTriggersFilePath(layout, "s1")).toMatch(/triggers\.json$/);
  });

  it("returns host.json policy path", () => {
    expect(getSessionHostPolicyFilePath(layout, "s1")).toMatch(/host\.json$/);
  });
});

describe("session subdirectories", () => {
  const layout = createLayout("/root");
  const sessionDir = getSessionDirectory(layout, "s1");

  it("nests assets under the session directory", () => {
    const dir = getSessionAssetsDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "assets"));
  });

  it("nests progress under the session directory", () => {
    const dir = getSessionProgressDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "progress"));
  });

  it("nests the progress file inside the progress directory", () => {
    const file = getSessionProgressFilePath(layout, "s1");
    expect(file).toBe(path.join(sessionDir, "progress", "progress.md"));
  });

  it("nests the team inbox under the session directory", () => {
    const dir = getSessionTeamInboxDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "team", "inbox"));
  });

  it("nests the trace directory under the session directory", () => {
    const dir = getSessionTraceDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "trace"));
  });

  it("nests the artifacts root under the session directory", () => {
    const dir = getSessionArtifactsRootDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "artifacts"));
  });

  it("nests transcripts under the session directory", () => {
    const dir = getSessionTranscriptsDirectory(layout, "s1");
    expect(dir).toBe(path.join(sessionDir, "transcripts"));
  });
});

describe("root-level paths", () => {
  const layout = createLayout("/root");

  it("returns the root team inbox directory", () => {
    expect(getRootTeamInboxDirectory(layout)).toBe(
      path.join(layout.rootDir, "team", "inbox"),
    );
  });

  it("returns the workspace trust file path", () => {
    expect(getWorkspaceTrustFilePath(layout)).toBe(
      path.join(layout.rootDir, "workspace-trust.json"),
    );
  });
});

describe("toStorageRelativePath", () => {
  it("returns a path relative to the storage root", () => {
    const layout = createLayout("/root");
    const abs = path.join(layout.rootDir, "sessions", "s1");
    expect(toStorageRelativePath(layout, abs)).toBe(
      path.join("sessions", "s1"),
    );
  });

  it("returns the absolute path when relative would be empty", () => {
    const layout = createLayout("/root");
    expect(toStorageRelativePath(layout, layout.rootDir)).toBe(layout.rootDir);
  });
});

describe("storage subpath escape protection", () => {
  it("throws when a configured layout path escapes the root", () => {
    const layout = resolveStorageLayout("/root", {
      workspaceTrustFile: "../escape.json",
      teamInboxDir: "team/inbox",
      themesDir: "themes",
      sessionAssetsDir: "assets",
      sessionProgressDir: "progress",
      sessionProgressFile: "progress.md",
      sessionArtifactsDir: "artifacts",
      sessionTranscriptsDir: "transcripts",
      sessionTeamInboxDir: "team/inbox",
      sessionTraceDir: "trace",
    });
    expect(() => getWorkspaceTrustFilePath(layout)).toThrow(
      "Storage layout escapes root",
    );
  });

  it("throws when an absolute layout path escapes the root", () => {
    const layout = resolveStorageLayout("/root", {
      workspaceTrustFile: "workspace-trust.json",
      teamInboxDir: "/etc/passwd",
      themesDir: "themes",
      sessionAssetsDir: "assets",
      sessionProgressDir: "progress",
      sessionProgressFile: "progress.md",
      sessionArtifactsDir: "artifacts",
      sessionTranscriptsDir: "transcripts",
      sessionTeamInboxDir: "team/inbox",
      sessionTraceDir: "trace",
    });
    expect(() => getRootTeamInboxDirectory(layout)).toThrow(
      "Storage layout escapes root",
    );
  });
});
