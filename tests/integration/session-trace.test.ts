import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FetchHttpTransport } from "../../extensions/llm/src/http-transport.js";
import { SessionTraceStore } from "../../src/gateway/session/session-trace-store.js";
import { BUILTIN_STORAGE_LAYOUT_DEFAULTS } from "../../src/bootstrap/config/defaults.js";
import {
  getSessionTraceDirectory,
  resolveStorageLayout,
} from "../../src/gateway/storage/layout.js";

describe("session trace credential persistence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes redacted headers while retaining useful diagnostic metadata", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "step-trace-redaction-"),
    );
    const layout = resolveStorageLayout(
      tempDir,
      BUILTIN_STORAGE_LAYOUT_DEFAULTS,
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    try {
      const transport = new FetchHttpTransport({
        traceRecorder: new SessionTraceStore(layout),
      });
      await transport.request({
        url: "https://example.invalid/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer test-key-not-for-persistence",
          "x-api-key": "test-anthropic-key-not-for-persistence",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test-model" }),
        timeoutMs: 1000,
        trace: {
          sessionId: "session-1",
          spanId: "span-1",
          provider: "openai",
          model: "test-model",
        },
      });
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        authorization: "Bearer test-key-not-for-persistence",
        "x-api-key": "test-anthropic-key-not-for-persistence",
      });
      const saved = await fs.readFile(
        path.join(getSessionTraceDirectory(layout, "session-1"), "span-1.json"),
        "utf8",
      );
      expect(saved).not.toContain("test-key-not-for-persistence");
      expect(saved).not.toContain("test-anthropic-key-not-for-persistence");
      expect(JSON.parse(saved)).toMatchObject({
        sessionId: "session-1",
        spanId: "span-1",
        request: {
          headers: {
            authorization: ["[REDACTED]"],
            "x-api-key": ["[REDACTED]"],
          },
          body: JSON.stringify({ model: "test-model" }),
        },
        response: { status: 200, body: "{}" },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
