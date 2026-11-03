import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGlobalStepConfig } from "./config-toml.ts";
import { applyStepMcpImport, planStepMcpImport } from "./mcp-import.ts";
import { describeStepMcpImportOutcome, planPendingStepMcpImport } from "./mcp-import-prompt.ts";
import {
	hasReviewedStepMcpImportSource,
	markStepMcpImportSourcesReviewed,
	readStepMcpImportState,
} from "./mcp-import-store.ts";
import { StepMcpImportView } from "./mcp-import-view.ts";

let workspace: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "step-mcp-import-"));
	home = join(workspace, "home");
	mkdirSync(home, { recursive: true });
	env = { STEP_CODING_AGENT_DIR: join(workspace, "config", "agent") };
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function writeClaude(config: unknown): void {
	writeFileSync(join(home, ".claude.json"), JSON.stringify(config), "utf8");
}

function writeCodex(toml: string): void {
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(join(home, ".codex", "config.toml"), toml, "utf8");
}

function plan() {
	return planStepMcpImport({ homeDir: home, env });
}

describe("planStepMcpImport", () => {
	it("reports a specific reason for each source that has nothing to offer", () => {
		const sources = plan().sources;
		expect(sources.map((source) => source.state)).toEqual(["missing", "missing"]);
		expect(sources[0]?.detail).toContain(".claude.json");
		expect(sources[1]?.detail).toContain("config.toml");
		expect(plan().candidates).toEqual([]);
	});

	it("reports an empty config separately from a missing one", () => {
		writeClaude({ mcpServers: {} });
		writeCodex('model = "gpt-5"\n');
		const sources = plan().sources;
		expect(sources.map((source) => source.state)).toEqual(["empty", "empty"]);
		for (const source of sources) expect(source.detail).toBeTruthy();
	});

	it("survives malformed configs and still reads the other source", () => {
		writeFileSync(join(home, ".claude.json"), "{ not json", "utf8");
		writeCodex('[mcp_servers.docs]\ncommand = "docs-server"\n');
		const result = plan();
		const claude = result.sources.find((source) => source.source === ".claude");
		expect(claude?.state).toBe("error");
		expect(claude?.detail).toBeTruthy();
		expect(result.candidates.map((candidate) => candidate.name)).toEqual(["docs"]);
	});

	it("keeps untranslatable servers visible with a reason", () => {
		writeClaude({
			mcpServers: {
				legacy: { type: "sse", url: "https://example.test/sse" },
				broken: { type: "stdio" },
				ide: { type: "ws-ide", url: "ws://localhost:1234" },
			},
		});
		const candidates = plan().candidates;
		// The IDE transport is Claude's own scratch state, not a user server.
		expect(candidates.map((candidate) => candidate.name).sort()).toEqual(["broken", "legacy"]);
		const legacy = candidates.find((candidate) => candidate.name === "legacy");
		expect(legacy?.blocked?.kind).toBe("unsupported");
		expect(legacy?.blocked?.detail).toContain("sse");
		expect(legacy?.config).toBeUndefined();
		expect(candidates.find((candidate) => candidate.name === "broken")?.blocked?.detail).toBe("no command");
	});

	it("gives same-named servers from different sources distinct target names", () => {
		writeClaude({ mcpServers: { docs: { command: "claude-docs" } } });
		writeCodex('[mcp_servers.docs]\ncommand = "codex-docs"\n');
		const candidates = plan().candidates;
		expect(candidates.map((candidate) => candidate.targetName)).toEqual(["docs", "docs-codex"]);
		expect(candidates[1]?.config?.command).toBe("codex-docs");
	});

	it("renames around an unrelated server that already owns the name", () => {
		writeClaude({ mcpServers: { docs: { command: "claude-docs" } } });
		const seeded = planStepMcpImport({
			homeDir: home,
			env,
			existing: { docs: { command: "something-else" } },
		});
		expect(seeded.candidates[0]?.targetName).toBe("docs-claude");
	});

	it("treats an identical existing server as already imported", () => {
		writeClaude({
			mcpServers: { docs: { command: "claude-docs", args: ["--stdio"] } },
		});
		const seeded = planStepMcpImport({
			homeDir: home,
			env,
			existing: { docs: { command: "claude-docs", args: ["--stdio"] } },
		});
		expect(seeded.candidates[0]?.blocked?.kind).toBe("duplicate");
		expect(seeded.candidates[0]?.blocked?.detail).toContain("already in config.toml");
	});

	it("copies Codex secret references by name instead of dereferencing them", () => {
		writeCodex(
			[
				"[mcp_servers.remote]",
				'url = "https://example.test/mcp"',
				'bearer_token_env_var = "REMOTE_TOKEN"',
				"[mcp_servers.remote.env_http_headers]",
				'X-Api-Key = "REMOTE_KEY"',
			].join("\n"),
		);
		const candidate = plan().candidates[0];
		expect(candidate?.config?.bearer_token_env_var).toBe("REMOTE_TOKEN");
		expect(candidate?.config?.env_http_headers).toEqual({
			"X-Api-Key": "REMOTE_KEY",
		});
	});

	it("warns about keys it could not translate", () => {
		writeClaude({
			mcpServers: {
				docs: { command: "docs", transportOptions: { retries: 3 } },
			},
		});
		expect(plan().candidates[0]?.warnings.join(" ")).toContain("transportOptions");
	});
});

describe("applyStepMcpImport", () => {
	it("writes only the selected servers and leaves the source files untouched", () => {
		writeClaude({
			mcpServers: {
				docs: { command: "claude-docs" },
				extra: { command: "extra" },
			},
		});
		const before = plan();
		const result = applyStepMcpImport(before, ["docs"], env);
		expect(result.imported).toEqual(["docs"]);
		const document = readGlobalStepConfig(env);
		expect(Object.keys(document.mcp_servers ?? {})).toEqual(["docs"]);
		expect(document.mcp_servers?.docs?.command).toBe("claude-docs");
		// The foreign config is still exactly what we wrote.
		expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({
			mcpServers: {
				docs: { command: "claude-docs" },
				extra: { command: "extra" },
			},
		});
	});

	it("refuses to import a blocked server even when it is selected", () => {
		writeClaude({
			mcpServers: { legacy: { type: "sse", url: "https://example.test/sse" } },
		});
		const result = applyStepMcpImport(plan(), ["legacy"], env);
		expect(result.imported).toEqual([]);
		expect(result.skipped[0]?.name).toBe("legacy");
	});

	it("is idempotent across a second launch", () => {
		writeClaude({ mcpServers: { docs: { command: "claude-docs" } } });
		applyStepMcpImport(plan(), ["docs"], env);
		const second = plan();
		expect(second.candidates[0]?.blocked?.kind).toBe("duplicate");
		expect(applyStepMcpImport(second, ["docs"], env).imported).toEqual([]);
		expect(Object.keys(readGlobalStepConfig(env).mcp_servers ?? {})).toEqual(["docs"]);
	});

	it("keeps both same-named servers when both are selected", () => {
		writeClaude({ mcpServers: { docs: { command: "claude-docs" } } });
		writeCodex('[mcp_servers.docs]\ncommand = "codex-docs"\n');
		const result = applyStepMcpImport(plan(), ["docs", "docs-codex"], env);
		expect(result.imported).toEqual(["docs", "docs-codex"]);
		const servers = readGlobalStepConfig(env).mcp_servers ?? {};
		expect(servers.docs?.command).toBe("claude-docs");
		expect(servers["docs-codex"]?.command).toBe("codex-docs");
	});
});

describe("cross-source duplicates", () => {
	it("imports a server declared in both CLIs once, and still renames a genuine clash", () => {
		writeClaude({
			mcpServers: {
				figma: { type: "http", url: "https://mcp.figma.com/mcp" },
				docs: { command: "npx", args: ["claude-docs"] },
			},
		});
		writeCodex(
			[
				"[mcp_servers.figma]",
				'url = "https://mcp.figma.com/mcp"',
				"",
				"[mcp_servers.docs]",
				'command = "uvx"',
				'args = [ "codex-docs" ]',
				"",
			].join("\n"),
		);

		const result = plan();
		const byRow = result.candidates.map((candidate) => [candidate.source, candidate.name, candidate.targetName]);
		expect(byRow).toEqual([
			[".claude", "figma", "figma"],
			[".claude", "docs", "docs"],
			[".codex", "figma", "figma"],
			[".codex", "docs", "docs-codex"],
		]);

		// Identical config in both CLIs: one entry, and the row says why.
		const codexFigma = result.candidates[2];
		expect(codexFigma?.config).toBeUndefined();
		expect(codexFigma?.blocked?.detail).toContain("same server as Claude Code");

		// Same name, different server: renamed rather than dropped or clobbered.
		expect(result.candidates[3]?.config).toBeDefined();

		const applied = applyStepMcpImport(
			result,
			result.candidates.map((candidate) => candidate.targetName),
			env,
		);
		expect(applied.imported).toEqual(["figma", "docs", "docs-codex"]);
		// The de-duplicated twin shares 'figma' with the row that wrote it, so it
		// must not also be reported as skipped.
		expect(applied.skipped).toEqual([]);
		expect(Object.keys(readGlobalStepConfig(env).mcp_servers ?? {})).toEqual(["figma", "docs", "docs-codex"]);
		// The regression this guards: a second, identical `figma-codex` entry.
		expect(Object.keys(readGlobalStepConfig(env).mcp_servers ?? {})).not.toContain("figma-codex");
	});

	it("still reports an entry already present in config.toml as such", () => {
		writeClaude({
			mcpServers: { docs: { command: "npx", args: ["claude-docs"] } },
		});
		applyStepMcpImport(plan(), ["docs"], env);

		const second = plan().candidates[0];
		expect(second?.config).toBeUndefined();
		expect(second?.blocked?.detail).toContain("already in config.toml as 'docs'");
	});
});

describe("planPendingStepMcpImport allocation", () => {
	it("does not let a reviewed source block an identical server in a pending one", () => {
		// Same server in both agents, and the user was already asked about Claude
		// Code but never imported it. Codex's copy must still be importable.
		writeClaude({ mcpServers: { figma: { command: "npx", args: ["figma-mcp"] } } });
		writeCodex('[mcp_servers.figma]\ncommand = "npx"\nargs = ["figma-mcp"]\n');
		markStepMcpImportSourcesReviewed([".claude"], env);

		const { pending, plan } = planPendingStepMcpImport({ env, homeDir: home });
		expect(pending).toEqual([".codex"]);

		const figma = plan.candidates.find((candidate) => candidate.name === "figma");
		expect(figma?.blocked).toBeUndefined();
		expect(figma?.targetName).toBe("figma");

		expect(applyStepMcpImport(plan, ["figma"], env).imported).toEqual(["figma"]);
		expect(Object.keys(readGlobalStepConfig(env).mcp_servers ?? {})).toEqual(["figma"]);
	});
});

describe("mcp import state", () => {
	function configRoot(): string {
		return join(workspace, "config");
	}

	it("records the review in config.toml rather than a file of its own", () => {
		markStepMcpImportSourcesReviewed([".claude"], env);

		const config = readGlobalStepConfig(env) as { mcp_import?: { reviewed?: string[] } };
		expect(config.mcp_import?.reviewed).toEqual([".claude"]);
		expect(existsSync(join(configRoot(), "mcp-import.json"))).toBe(false);

		// Merges rather than replaces, so a racing process cannot erase the other.
		markStepMcpImportSourcesReviewed([".codex"], env);
		const state = readStepMcpImportState(env);
		expect(hasReviewedStepMcpImportSource(state, ".claude")).toBe(true);
		expect(hasReviewedStepMcpImportSource(state, ".codex")).toBe(true);
	});

	it("adopts the legacy mcp-import.json and deletes it", () => {
		mkdirSync(configRoot(), { recursive: true });
		writeFileSync(
			join(configRoot(), "mcp-import.json"),
			JSON.stringify({ schemaVersion: 1, reviewedSources: { ".claude": "2026-01-01T00:00:00.000Z" } }),
			"utf8",
		);

		// Read alone must honour it, so an upgrade does not re-prompt.
		expect(hasReviewedStepMcpImportSource(readStepMcpImportState(env), ".claude")).toBe(true);

		markStepMcpImportSourcesReviewed([".codex"], env);
		const config = readGlobalStepConfig(env) as { mcp_import?: { reviewed?: string[] } };
		expect(config.mcp_import?.reviewed?.sort()).toEqual([".claude", ".codex"]);
		expect(existsSync(join(configRoot(), "mcp-import.json"))).toBe(false);
	});

	it("keeps mcp_servers intact when the review is written", () => {
		writeClaude({ mcpServers: { docs: { command: "npx", args: ["claude-docs"] } } });
		applyStepMcpImport(plan(), ["docs"], env);
		markStepMcpImportSourcesReviewed([".claude", ".codex"], env);

		expect(Object.keys(readGlobalStepConfig(env).mcp_servers ?? {})).toEqual(["docs"]);
	});
});

describe("describeStepMcpImportOutcome", () => {
	it("reports a write and its skips, and stays silent when nothing happened", () => {
		expect(describeStepMcpImportOutcome({ kind: "cancelled" })).toBeUndefined();
		expect(
			describeStepMcpImportOutcome({
				kind: "skipped",
				reason: "already reviewed",
			}),
		).toBeUndefined();
		// Confirming with everything deselected changed nothing, so say nothing.
		expect(
			describeStepMcpImportOutcome({
				kind: "imported",
				result: { imported: [], skipped: [] },
			}),
		).toBeUndefined();

		const notice = describeStepMcpImportOutcome({
			kind: "imported",
			result: {
				imported: ["docs", "shared-codex"],
				skipped: [{ name: "broken", reason: "neither command nor url" }],
				configPath: "/home/u/.stepcode/config.toml",
			},
		});
		expect(notice).toContain("Imported 2 MCP servers into /home/u/.stepcode/config.toml");
		expect(notice).toContain("docs, shared-codex");
		// The prompt runs before MCP discovery, so nothing asks for a restart.
		expect(notice).not.toContain("Restart");
		expect(notice).toContain("Skipped broken: neither command nor url");

		// A failed write arrives as imported:[] plus a skip reason; it must not be silent.
		const failed = describeStepMcpImportOutcome({
			kind: "imported",
			result: {
				imported: [],
				skipped: [{ name: "docs", reason: "could not write config.toml (EACCES)" }],
			},
		});
		expect(failed).toBe("Skipped docs: could not write config.toml (EACCES)");
	});
});

describe("planPendingStepMcpImport", () => {
	it("stops offering a source once it has been reviewed, unless the debug flag is set", () => {
		writeClaude({
			mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } },
		});

		const first = planPendingStepMcpImport({ env, homeDir: home });
		expect(first.pending).toContain(".claude");

		markStepMcpImportSourcesReviewed([".claude", ".codex"], env);

		const second = planPendingStepMcpImport({ env, homeDir: home });
		expect(second.pending).toEqual([]);
		expect(second.plan.candidates).toEqual([]);

		const forced = planPendingStepMcpImport({
			env: { ...env, STEP_MCP_IMPORT_ALWAYS: "1" },
			homeDir: home,
		});
		expect(forced.pending).toContain(".claude");
		expect(forced.plan.candidates.map((candidate) => candidate.name)).toContain("docs");

		// A falsy value must not turn the debug mode on by accident.
		const off = planPendingStepMcpImport({
			env: { ...env, STEP_MCP_IMPORT_ALWAYS: "0" },
			homeDir: home,
		});
		expect(off.pending).toEqual([]);
	});
});

describe("StepMcpImportView", () => {
	function build(onConfirm: (names: string[]) => void): StepMcpImportView {
		const result = plan();
		return new StepMcpImportView(result.candidates, result.sources, {
			onConfirm,
			onCancel: () => {},
			requestRender: () => {},
		});
	}

	it("shows every server with its source and whether it can be imported", () => {
		writeClaude({
			mcpServers: {
				docs: { command: "claude-docs" },
				legacy: { type: "sse", url: "https://example.test/sse" },
			},
		});
		const screen = stripAnsi(
			build(() => {})
				.render(100)
				.join("\n"),
		);
		expect(screen).toContain("\u2713 docs");
		expect(screen).toContain("- legacy");
		// The source label must survive the column clamp; it used to be cut to "Claud".
		expect(screen).toContain("Claude Code");
		expect(screen).toContain("sse transport");
	});

	it("keeps a long name and its source label intact in the same row", () => {
		writeClaude({
			mcpServers: {
				"konva-documentation": { command: "npx", args: ["crawl-chat-mcp"] },
			},
		});
		const screen = stripAnsi(
			build(() => {})
				.render(100)
				.join("\n"),
		);
		expect(screen).toContain("\u2713 konva-documentation  Claude Code");
	});

	it("confirms only the servers left checked", () => {
		writeClaude({
			mcpServers: {
				docs: { command: "claude-docs" },
				extra: { command: "extra" },
			},
		});
		let confirmed: string[] | undefined;
		const view = build((names) => {
			confirmed = names;
		});
		view.handleInput(" ");
		view.handleInput(ENTER);
		expect(confirmed).toEqual(["extra"]);
	});

	it("cannot check a blocked server", () => {
		writeClaude({
			mcpServers: { legacy: { type: "sse", url: "https://example.test/sse" } },
		});
		let confirmed: string[] | undefined;
		const view = build((names) => {
			confirmed = names;
		});
		view.handleInput(" ");
		view.handleInput(ENTER);
		expect(confirmed).toEqual([]);
	});
});

const ENTER = "\r";

function stripAnsi(value: string): string {
	return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
