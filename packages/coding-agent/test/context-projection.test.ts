/**
 * Tests for request-time lightweight context projection integration:
 * - the coding-agent package re-exports the single pi-agent-core implementation
 * - step.compaction.contextProjection setting + --context-projection CLI flag
 * - AgentSession wires lightweight projection into convertToLlm when selected,
 *   emitting telemetry and never mutating the transcript
 */

import {
	Agent,
	type AgentMessage,
	projectContextForRequest as coreProjectContextForRequest,
} from "@step-harness/agent-core";
import type { Api, Message, Model, ToolResultMessage, Usage } from "@step-harness/providers/compat";
import { streamSimple } from "@step-harness/providers/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { PROJECTION_CUT_MARKER_PREFIX, projectContextForRequest } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// ============================================================================
// Single implementation
// ============================================================================

describe("projection single-implementation re-export", () => {
	it("resolves the compaction-index export to the exact pi-agent-core function, not a copy", () => {
		expect(projectContextForRequest).toBe(coreProjectContextForRequest);
	});
});

// ============================================================================
// Settings flag
// ============================================================================

describe("step.compaction.contextProjection setting", () => {
	it("defaults to CLM with automatic compaction enabled", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getContextProjectionMode()).toBe("clm-v1");
		expect(settings.getCompactionSettings().contextProjection).toBe("clm-v1");
		expect(settings.getAutoClmSettings().enabled).toBe(true);
		expect(settings.getGlobalSettings().compaction).toBeUndefined();
	});

	it("turns implicit CLM off with automatic compaction and restores it when enabled", () => {
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		expect(settings.getContextProjectionMode()).toBe("off");
		settings.setCompactionEnabled(true);
		expect(settings.getContextProjectionMode()).toBe("clm-v1");
		settings.setCompactionEnabled(false);
		expect(settings.getContextProjectionMode()).toBe("off");
	});

	it.each(["off", "lightweight-v1", "clm-v1"] as const)(
		"preserves explicit %s when automatic compaction is disabled",
		(mode) => {
			const settings = SettingsManager.inMemory({ compaction: { enabled: false, contextProjection: mode } });
			expect(settings.getContextProjectionMode()).toBe(mode);
			settings.setCompactionEnabled(true);
			expect(settings.getContextProjectionMode()).toBe(mode);
		},
	);

	it("keeps the CLM working view when only automatic maintenance is disabled", () => {
		const settings = SettingsManager.inMemory({ compaction: { autoClm: { enabled: false } } });
		expect(settings.getContextProjectionMode()).toBe("clm-v1");
		expect(settings.getAutoClmSettings().enabled).toBe(false);
	});

	it.each(["off", "lightweight-v1", "clm-v1"] as const)("reads %s from config", (mode) => {
		const settings = SettingsManager.inMemory({ compaction: { contextProjection: mode } });
		expect(settings.getContextProjectionMode()).toBe(mode);
		expect(settings.getCompactionSettings().contextProjection).toBe(mode);
	});

	it.each(["off", "lightweight-v1", "clm-v1"] as const)("applies a %s override", (mode) => {
		const settings = SettingsManager.inMemory({ compaction: { contextProjection: "lightweight-v1" } });
		settings.applyOverrides({ compaction: { contextProjection: mode } });
		expect(settings.getContextProjectionMode()).toBe(mode);
		expect(settings.getCompactionSettings().contextProjection).toBe(mode);
	});

	it.each(["experimental-v9", "lightweight-v1,clm-v1", ""])("treats unknown value %j as off", (mode) => {
		const settings = SettingsManager.inMemory();
		settings.applyOverrides({ compaction: { contextProjection: mode as never } });
		expect(settings.getContextProjectionMode()).toBe("off");
		expect(settings.getCompactionSettings().contextProjection).toBe("off");
	});

	it("persists one mode at a time, including resetting to off", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);

		for (const mode of ["clm-v1", "lightweight-v1", "off"] as const) {
			settings.setContextProjectionMode(mode);
			expect(settings.getContextProjectionMode()).toBe(mode);
			expect(settings.getCompactionSettings().contextProjection).toBe(mode);
			await settings.flush();

			const reloaded = SettingsManager.fromStorage(storage);
			expect(reloaded.getContextProjectionMode()).toBe(mode);
			expect(reloaded.getGlobalSettings()).toEqual({ compaction: { contextProjection: mode } });
		}
		expect(settings.drainErrors()).toEqual([]);
	});

	it("persists only the mode while preserving external changes to other settings", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1000 } }));
		const settings = SettingsManager.fromStorage(storage);
		const externalSettings = {
			theme: "light",
			compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 2000 },
		};
		storage.withLock("global", () => JSON.stringify(externalSettings));
		settings.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 9999 } });

		settings.setContextProjectionMode("clm-v1");
		await settings.flush();

		const reloaded = SettingsManager.fromStorage(storage);
		expect(reloaded.getGlobalSettings()).toEqual({
			...externalSettings,
			compaction: { ...externalSettings.compaction, contextProjection: "clm-v1" },
		});
		expect(settings.drainErrors()).toEqual([]);
	});
});

// ============================================================================
// CLI flag
// ============================================================================

describe("--context-projection flag", () => {
	it.each(["off", "lightweight-v1", "clm-v1"] as const)("parses %s", (mode) => {
		const result = parseArgs(["--context-projection", mode]);
		expect(result.contextProjection).toBe(mode);
		expect(result.diagnostics).toEqual([]);
	});

	it("leaves the mode unset when the flag is absent", () => {
		expect(parseArgs([]).contextProjection).toBeUndefined();
	});

	it.each([
		["lightweight-v1", "clm-v1"],
		["clm-v1", "lightweight-v1"],
		["clm-v1", "off"],
	])("replaces %s with %s when the flag is repeated", (initialMode, finalMode) => {
		const result = parseArgs(["--context-projection", initialMode, "--context-projection", finalMode]);
		expect(result.contextProjection).toBe(finalMode);
		expect(result.diagnostics).toEqual([]);
	});

	it.each(["bogus", "lightweight-v1,clm-v1", ""])("rejects invalid mode %j", (mode) => {
		const result = parseArgs(["--context-projection", mode]);
		expect(result.contextProjection).toBeUndefined();
		expect(result.diagnostics).toEqual([
			{
				type: "error",
				message: `Invalid context projection mode "${mode}". Valid values: off, lightweight-v1, clm-v1`,
			},
		]);
	});

	it("requires a value", () => {
		const result = parseArgs(["--context-projection"]);
		expect(result.contextProjection).toBeUndefined();
		expect(result.diagnostics).toEqual([
			{ type: "error", message: "--context-projection requires off, lightweight-v1, or clm-v1" },
		]);
	});

	it("reports a missing value without consuming the next flag", () => {
		const result = parseArgs(["--context-projection", "--verbose"]);
		expect(result.contextProjection).toBeUndefined();
		expect(result.verbose).toBe(true);
		expect(result.diagnostics).toEqual([
			{ type: "error", message: "--context-projection requires off, lightweight-v1, or clm-v1" },
		]);
	});

	it("lists all modes and the default in help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = log.mock.calls.flat().join("\n");
			const option = help.split("\n").find((line) => line.includes("--context-projection <mode>"));
			expect(option).toContain("clm-v1 (default), lightweight-v1, or off");
		} finally {
			log.mockRestore();
		}
	});
});

// ============================================================================
// AgentSession wiring
// ============================================================================

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Small offline model stub: 20k window so tests trigger with ~50KB of text. */
function testModel(): Model<Api> {
	return {
		id: "projection-test-model",
		name: "Projection Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		contextWindow: 20_000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

function bigText(lines: number): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(
			i === Math.floor(lines / 2) ? "Error: step failed at src/tool.ts:7" : `tool output line ${i} with filler`,
		);
	}
	return out.join("\n");
}

let nextTimestamp = 5_000_000;
function ts(): number {
	return nextTimestamp++;
}

/** A conversation whose estimate crosses 60% of the 20k-token window. */
function buildAgentMessages(): AgentMessage[] {
	const big = bigText(1600); // ~52KB -> ~13k estimated tokens
	return [
		{ role: "user", content: "run the full test suite", timestamp: ts() },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }],
			api: "anthropic-messages" as Api,
			provider: "anthropic",
			model: "projection-test-model",
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: ts(),
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: big }],
			isError: false,
			timestamp: ts(),
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "The suite failed at src/tool.ts:7." }],
			api: "anthropic-messages" as Api,
			provider: "anthropic",
			model: "projection-test-model",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: ts(),
		},
		{ role: "user", content: "ok, fix it", timestamp: ts() },
	];
}

describe("AgentSession projection wiring", () => {
	let session: AgentSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	async function createSession(contextProjection?: "off" | "lightweight-v1"): Promise<{
		session: AgentSession;
		events: AgentSessionEvent[];
	}> {
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: { model: testModel(), systemPrompt: "test system prompt", tools: [] },
		});
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({
			compaction: { keepRecentTokens: 100, ...(contextProjection ? { contextProjection } : {}) },
		});
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = await createModelRegistry(authStorage);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		return { session, events };
	}

	it("does not project when the flag is explicitly off", async () => {
		const { session: s } = await createSession("off");
		const agentMessages = buildAgentMessages();
		const llmMessages = await s.agent.convertToLlm(agentMessages);
		const serialized = JSON.stringify(llmMessages);
		expect(serialized).not.toContain(PROJECTION_CUT_MARKER_PREFIX.replaceAll("[", "\\["));
		expect(serialized).not.toContain("context-compacted");
	});

	it("projects the outgoing request when lightweight-v1 is enabled", async () => {
		const { session: s, events } = await createSession("lightweight-v1");
		const agentMessages = buildAgentMessages();
		const originalBig = (agentMessages[2] as ToolResultMessage).content;

		const llmMessages = (await s.agent.convertToLlm(agentMessages)) as Message[];

		const projectedResult = llmMessages[2] as ToolResultMessage;
		const projectedText = projectedResult.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
		expect(projectedText).toContain("context-compacted");
		expect(projectedText).toContain("Error: step failed at src/tool.ts:7");
		expect(projectedText.length).toBeLessThan(bigText(1600).length / 2);

		// Tool pairing intact and protected zone untouched.
		expect(projectedResult.toolCallId).toBe("call-1");
		expect(llmMessages[4]).toEqual(agentMessages[4]);

		// The session/agent transcript is never mutated.
		expect((agentMessages[2] as ToolResultMessage).content).toBe(originalBig);
		const originalText = originalBig.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(originalText).toBe(bigText(1600));

		// Telemetry event emitted with per-rule counts.
		const telemetry = events.find((event) => event.type === "context_projection");
		expect(telemetry).toBeDefined();
		if (telemetry?.type === "context_projection") {
			expect(telemetry.invariantsPassed).toBe(true);
			expect(telemetry.cutsByRule.tool_result_cuts).toBe(1);
			expect(telemetry.bytesRemoved).toBeGreaterThan(0);
			expect(telemetry.projectedTokens).toBeLessThan(telemetry.originalTokens);
		}
	});

	it("passes small conversations through byte-identically even when enabled", async () => {
		const { session: s, events } = await createSession("lightweight-v1");
		const agentMessages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: ts() },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages" as Api,
				provider: "anthropic",
				model: "projection-test-model",
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: ts(),
			},
			{ role: "user", content: "how are you?", timestamp: ts() },
		];
		const llmMessages = await s.agent.convertToLlm(agentMessages);
		expect(llmMessages).toEqual(agentMessages);
		expect(events.find((event) => event.type === "context_projection")).toBeUndefined();
	});
});

// ============================================================================
// Re-export sanity (projection is usable through the compaction index)
// ============================================================================

describe("coding-agent projection re-export", () => {
	it("applies rules through the compaction index export", () => {
		const big = bigText(1600);
		const messages: Message[] = [
			{ role: "user", content: "q", timestamp: ts() },
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: big }],
				isError: false,
				timestamp: ts(),
			},
			{ role: "user", content: "next", timestamp: ts() },
		];
		const { messages: projected, stats } = projectContextForRequest(messages, {
			contextWindow: 20_000,
			keepRecentTokens: 10,
		});
		expect(stats.applied).toBe(true);
		expect(stats.byRule.tool_result_cuts).toBe(1);
		expect(JSON.stringify(projected[1])).toContain("context-compacted");
	});
});
