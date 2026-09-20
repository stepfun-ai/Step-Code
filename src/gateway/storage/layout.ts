import path from "node:path";
export { resolveStorageRootDirectory } from "@step-cli/utils/path.js";

export interface StepCliStorageLayoutPaths {
  workspaceTrustFile: string;
  teamInboxDir: string;
  themesDir: string;
  sessionAssetsDir: string;
  sessionProgressDir: string;
  sessionProgressFile: string;
  sessionArtifactsDir: string;
  sessionTranscriptsDir: string;
  sessionTeamInboxDir: string;
  sessionTraceDir: string;
}

export interface StepCliResolvedStorageLayout {
  rootDir: string;
  paths: StepCliStorageLayoutPaths;
}

export function encodeStorageKey(value: string): string {
  const encoded = encodeURIComponent(value.trim());
  // encodeURIComponent leaves dot segments unchanged, but path.join treats
  // them as the current/parent directory instead of a session's own name.
  return encoded === "." || encoded === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
}

export function decodeStorageKey(value: string): string {
  return decodeURIComponent(value);
}

export function resolveStorageLayout(
  rootDir: string,
  paths: StepCliStorageLayoutPaths,
): StepCliResolvedStorageLayout {
  return {
    rootDir: path.resolve(rootDir),
    paths: { ...paths },
  };
}

export function getSessionDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  const key = encodeStorageKey(sessionId);
  if (!key) {
    throw new Error("Session id must not be empty");
  }
  return path.join(getSessionsRootDirectory(storage), key);
}

export function getSessionEventsFilePath(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return path.join(getSessionDirectory(storage, sessionId), "events.jsonl");
}

export function getSessionSnapshotFilePath(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return path.join(getSessionDirectory(storage, sessionId), "session.json");
}

export function getSessionTriggersFilePath(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return path.join(getSessionDirectory(storage, sessionId), "triggers.json");
}

export function getSessionHostPolicyFilePath(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return path.join(getSessionDirectory(storage, sessionId), "host.json");
}

export function getSessionAssetsDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionAssetsDir,
  );
}

export function getSessionProgressDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionProgressDir,
  );
}

export function getSessionTeamInboxDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionTeamInboxDir,
  );
}

export function getSessionTraceDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionTraceDir,
  );
}

export function getSessionArtifactsRootDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionArtifactsDir,
  );
}

export function getSessionsRootDirectory(
  storage: StepCliResolvedStorageLayout,
): string {
  return path.join(storage.rootDir, "sessions");
}

export function getSessionTranscriptsDirectory(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionDirectory(storage, sessionId),
    storage.paths.sessionTranscriptsDir,
  );
}

export function getSessionProgressFilePath(
  storage: StepCliResolvedStorageLayout,
  sessionId: string,
): string {
  return resolveStorageSubpath(
    getSessionProgressDirectory(storage, sessionId),
    storage.paths.sessionProgressFile,
  );
}

export function getRootTeamInboxDirectory(
  storage: StepCliResolvedStorageLayout,
): string {
  return resolveStorageSubpath(storage.rootDir, storage.paths.teamInboxDir);
}

export function getThemesDirectory(
  storage: StepCliResolvedStorageLayout,
): string {
  return resolveStorageSubpath(storage.rootDir, storage.paths.themesDir);
}

export function getWorkspaceTrustFilePath(
  storage: StepCliResolvedStorageLayout,
): string {
  return resolveStorageSubpath(
    storage.rootDir,
    storage.paths.workspaceTrustFile,
  );
}

export function toStorageRelativePath(
  storage: StepCliResolvedStorageLayout,
  absolutePath: string,
): string {
  return path.relative(storage.rootDir, absolutePath) || absolutePath;
}

function resolveStorageSubpath(baseDir: string, relativePath: string): string {
  const normalizedBase = path.resolve(baseDir);
  const resolved = path.resolve(normalizedBase, relativePath);
  if (
    resolved !== normalizedBase &&
    !resolved.startsWith(`${normalizedBase}${path.sep}`)
  ) {
    throw new Error(`Storage layout escapes root: ${relativePath}`);
  }
  return resolved;
}
