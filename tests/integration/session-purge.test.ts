import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_CLI_DEFAULTS,
  BUILTIN_STORAGE_LAYOUT_DEFAULTS,
} from "../../src/bootstrap/config/defaults.js";
import { StepCliSessionService } from "../../src/gateway/service/session-service.js";
import {
  startStepCliHttpServer,
  type StepCliHttpServerHandle,
} from "../../src/gateway/service/http-server.js";
import {
  getSessionDirectory,
  resolveStorageLayout,
  type StepCliResolvedStorageLayout,
} from "../../src/gateway/storage/layout.js";
import type { StepCliConfig } from "../../src/gateway/runtime.js";

describe("HTTP session purge storage isolation", () => {
  let tempDir: string;
  let layout: StepCliResolvedStorageLayout;
  let server: StepCliHttpServerHandle | undefined;
  let sessions: StepCliSessionService;
  let rootSentinel: string;
  let sessionSentinel: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-session-purge-"));
    layout = resolveStorageLayout(
      path.join(tempDir, "storage"),
      BUILTIN_STORAGE_LAYOUT_DEFAULTS,
    );
    rootSentinel = path.join(layout.rootDir, "keep-root.txt");
    sessionSentinel = path.join(
      getSessionDirectory(layout, "innocent"),
      "keep-session.txt",
    );
    await fs.mkdir(path.dirname(sessionSentinel), { recursive: true });
    await fs.writeFile(rootSentinel, "root data");
    await fs.writeFile(sessionSentinel, "unrelated session data");

    const config: StepCliConfig = {
      ...BUILTIN_CLI_DEFAULTS,
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      workspaceRoot: tempDir,
      storageRootDir: layout.rootDir,
      storageLayout: layout,
      skillsDirectoryName: "skills",
      maxToolResultCharsInContext: 10_000,
      interactionProfile: { surface: "service", canAskUser: false },
      resumeSession: false,
      autoSaveSession: false,
      sessionTraceHeaderInjectionBaseUrls: [],
      useAlternateScreen: false,
      verbose: false,
    };
    sessions = new StepCliSessionService(config, {
      storageRootDir: layout.rootDir,
    });
    await sessions.waitUntilReady();
    server = await startStepCliHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-service-token",
      sessions,
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    } else {
      await sessions?.close();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function purge(sessionId: string): Promise<unknown> {
    // Padding keeps URL dot-segment normalization from hiding the bug before
    // the service decodes and trims the ID.
    const encodedId = encodeURIComponent(` ${sessionId} `);
    const response = await fetch(
      `${server!.origin}/v1/sessions/${encodedId}?purge=true`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer test-service-token" },
      },
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  async function expectOtherDataIntact(): Promise<void> {
    expect(await fs.readFile(rootSentinel, "utf8")).toBe("root data");
    expect(await fs.readFile(sessionSentinel, "utf8")).toBe(
      "unrelated session data",
    );
  }

  it.each([".", ".."])(
    "purging unknown %s preserves other data",
    async (id) => {
      await purge(id);
      await expectOtherDataIntact();
    },
  );

  it.each([".", "..", "normal-session"])(
    "purges only the directory belonging to %s",
    async (id) => {
      const target = getSessionDirectory(layout, id);
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "delete-me.txt"), "target data");
      expect(await purge(id)).toEqual({
        ok: true,
        existed: false,
        purged: true,
      });
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expectOtherDataIntact();
    },
  );
});
