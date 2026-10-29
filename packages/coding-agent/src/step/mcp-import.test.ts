import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGlobalStepConfig, updateGlobalMcpConfig } from "./config-toml.ts";
import {
	allocateStepMcpImportCandidates,
	applyStepMcpImport,
	parseStepMcpImportSource,
	planStepMcpImport,
} from "./mcp-import.ts";
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

describe("parseStepMcpImportSource", () => {
	it("parses user-scoped Claude servers and counts but does not import project scope", () => {
		const raw = JSON.stringify({
			mcpServers: { docs: { command: "docs" }, ide: { type: "ws-ide" } },
			projects: { "/fixture": { mcpServers: { local: { command: "local" } } } },
		});
		const read = parseStepMcpImportSource(".claude", raw);
		expect(read.state).toBe("ok");
		expect(read.projectScopedCount).toBe(1);
		expect(read.servers.map((server) => server.name)).toEqual(["docs"]);
		expect(read.warnings[0]).toContain("1 project-scoped");
		writeClaude(JSON.parse(raw));
		expect(plan().candidates[0]?.config).toEqual(read.servers[0]?.config);
	});

	it("parses Codex tool restrictions without widening an empty allowlist", () => {
		const read = parseStepMcpImportSource(".codex", '[mcp_servers.docs]\ncommand = "docs"\nenabled_tools = []\n');
		expect(read.state).toBe("ok");
		expect(read.servers[0]?.config?.enabled_tools).toEqual([]);
	});

	it("reports empty and malformed input without echoing raw parser errors", () => {
		expect(parseStepMcpImportSource(".claude", "{}").state).toBe("empty");
		expect(parseStepMcpImportSource(".codex", "").state).toBe("empty");
		for (const source of [".claude", ".codex"] as const) {
			const read = parseStepMcpImportSource(source, "fixture-private-marker = !");
			expect(read.state).toBe("error");
			expect(read.servers).toEqual([]);
			expect(JSON.stringify(read)).not.toContain("fixture-private-marker");
		}
	});

	it.each(["null", "[]", '{"mcpServers":[]}'])("rejects invalid source structure %s", (raw) => {
		expect(parseStepMcpImportSource(".claude", raw).state).toBe("error");
	});
});

describe("MCP import diagnostics", () => {
	it("carries only safe codes and counts alongside backwards-compatible warnings", () => {
		const claude = parseStepMcpImportSource(
			".claude",
			JSON.stringify({
				mcpServers: {
					"fixture-name": { type: "fixture-transport" },
					broken: { type: "http" },
					docs: { command: "docs", "fixture-field": "fixture-value", extra: true },
				},
			}),
		);
		expect(claude.servers.map((server) => server.diagnostics)).toEqual([
			[{ code: "mcp-unsupported-transport" }],
			[{ code: "mcp-incomplete-config" }],
			[{ code: "mcp-fields-not-translated", count: 2 }],
		]);
		expect(claude.servers[2]?.warnings[0]).toContain("fixture-field");
		writeCodex('[mcp_servers.docs]\ncommand = "docs"\nenabled_tools = false\n');
		expect(plan().candidates[0]?.diagnostics).toEqual([{ code: "mcp-invalid-tool-filter" }]);
		const codex = parseStepMcpImportSource(
			".codex",
			[
				"[mcp_servers.docs]",
				'command = "docs"',
				'env_vars = [{ name = "fixture-env", source = "remote" }, "inherited"]',
			].join("\n"),
		);
		expect(codex.servers[0]?.diagnostics).toEqual([{ code: "mcp-remote-env-unsupported", count: 1 }]);
		expect(codex.servers[0]?.warnings[0]).toContain("fixture-env");
		expect(JSON.stringify([...claude.servers, ...codex.servers].map((server) => server.diagnostics))).not.toContain(
			"fixture",
		);
	});
});

describe("allocateStepMcpImportCandidates", () => {
	it("defaults to strict config equality and the CLI name chain", () => {
		const { servers } = parseStepMcpImportSource(".claude", '{"mcpServers":{"docs":{"command":"docs"}}}');
		expect(allocateStepMcpImportCandidates(servers, { other: { command: "docs" } })[0]?.targetName).toBe("docs");
		const existing = { docs: { command: "docs", enabled: false } };
		const strict = allocateStepMcpImportCandidates(servers, existing);
		expect(strict[0]?.targetName).toBe("docs-claude");
		expect(strict[0]?.diagnostics).toEqual([{ code: "mcp-name-conflict" }]);
		const custom = allocateStepMcpImportCandidates(servers, existing, {
			sameConfig: (left, right) => left.command === right.command,
		});
		expect(custom[0]?.blocked?.kind).toBe("duplicate");
		expect(custom[0]?.diagnostics).toEqual([{ code: "mcp-duplicate" }]);
		expect(existing).toEqual({ docs: { command: "docs", enabled: false } });
		expect(servers[0]?.diagnostics).toEqual([]);
	});

	it("can match any existing or earlier allocated name with caller equality", () => {
		const { servers } = parseStepMcpImportSource(
			".claude",
			'{"mcpServers":{"docs":{"command":"docs"},"renamed":{"command":"docs"}}}',
		);
		const options = {
			matchAnyName: true,
			sameConfig: (left: { command?: string }, right: { command?: string }) => left.command === right.command,
		};
		const existing = allocateStepMcpImportCandidates(
			servers,
			{ unrelated: { command: "docs", enabled: false } },
			options,
		);
		expect(existing.map((candidate) => candidate.targetName)).toEqual(["unrelated", "unrelated"]);
		expect(existing.every((candidate) => candidate.blocked?.kind === "duplicate")).toBe(true);
		const pending = allocateStepMcpImportCandidates(servers, {}, options);
		expect(pending.map((candidate) => candidate.targetName)).toEqual(["docs", "docs"]);
		expect(pending[1]?.blocked?.detail).toContain("same server as Claude Code");
	});

	it("carries translation and normalization diagnostics into renamed candidates", () => {
		const { servers } = parseStepMcpImportSource(
			".claude",
			'{"mcpServers":{"docs.name":{"command":"docs","extra":true}}}',
		);
		const result = allocateStepMcpImportCandidates(servers, { "docs-name": { command: "other" } });
		expect(result[0]?.targetName).toBe("docs-name-claude");
		expect(result[0]?.diagnostics).toEqual([
			{ code: "mcp-fields-not-translated", count: 1 },
			{ code: "mcp-name-normalized" },
			{ code: "mcp-name-conflict" },
		]);
	});

	it("reports exhausted fallback names without overwriting or dropping the row", () => {
		const { servers } = parseStepMcpImportSource(".claude", '{"mcpServers":{"docs":{"command":"docs"}}}');
		const names = ["docs", "docs-claude", ...Array.from({ length: 63 }, (_, index) => `docs-claude-${index + 2}`)];
		const result = allocateStepMcpImportCandidates(
			servers,
			Object.fromEntries(names.map((name) => [name, { command: "other" }])),
		);
		expect(result[0]?.config).toBeUndefined();
		expect(result[0]?.blocked?.kind).toBe("name-exhausted");
		expect(result[0]?.diagnostics).toEqual([{ code: "mcp-name-conflict" }, { code: "mcp-name-exhausted" }]);
	});
});

describe("planStepMcpImport", () => {
	it("prefers explicit source files over CODEX_HOME without reading defaults", () => {
		const override = join(home, "profile", "config.toml");
		mkdirSync(dirname(override), { recursive: true });
		writeFileSync(override, '[mcp_servers.profile]\ncommand="profile"\n');
		const custom = join(home, "chosen.toml");
		writeFileSync(custom, '[mcp_servers.chosen]\ncommand="chosen"\n');
		const options = { homeDir: home, env: { ...env, CODEX_HOME: dirname(override) }, existing: {} };
		expect(planStepMcpImport(options).candidates.map((c) => c.name)).toEqual(["profile"]);
		expect(
			planStepMcpImport({ ...options, sourcePaths: { ".codex": custom } }).candidates.map((c) => c.name),
		).toEqual(["chosen"]);
	});
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

	it("preserves an explicit empty tool allowlist through import", () => {
		writeCodex('[mcp_servers.docs]\ncommand = "docs"\nenabled_tools = []\ndisabled_tools = []\nenabled = false\n');
		const preview = plan();
		expect(preview.candidates[0]?.config?.enabled_tools).toEqual([]);
		expect(preview.candidates[0]?.config?.disabled_tools).toEqual([]);
		expect(applyStepMcpImport(preview, ["docs"], env).imported).toEqual(["docs"]);
		expect(readGlobalStepConfig(env).mcp_servers?.docs).toMatchObject({
			enabled_tools: [],
			disabled_tools: [],
			enabled: false,
		});
	});

	it.each([
		["enabled_tools", '"read"'],
		["disabled_tools", "true"],
		["enabled_tools", '["read", 1]'],
		["disabled_tools", '["write", false]'],
	])("blocks invalid %s = %s without widening permissions", (field, value) => {
		writeCodex(`[mcp_servers.docs]\ncommand = "docs"\n${field} = ${value}\n`);
		const preview = plan();
		expect(preview.candidates[0]?.config).toBeUndefined();
		expect(preview.candidates[0]?.blocked?.kind).toBe("incomplete");
		expect(applyStepMcpImport(preview, ["docs"], env).imported).toEqual([]);
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
	it("does not overwrite a different config created after preview", () => {
		writeClaude({ mcpServers: { docs: { command: "imported-docs" }, extra: { command: "extra" } } });
		const preview = plan();
		updateGlobalMcpConfig(env, () => ({ docs: { command: "new-docs", enabled: false } }));
		const result = applyStepMcpImport(preview, ["docs", "extra"], env);
		expect(result.imported).toEqual(["extra"]);
		expect(result.skipped).toEqual([{ name: "docs", reason: expect.stringContaining("different") }]);
		expect(readGlobalStepConfig(env).mcp_servers).toEqual({
			docs: { command: "new-docs", enabled: false },
			extra: { command: "extra" },
		});
	});

	it("skips an identical config when the same plan is replayed", () => {
		writeClaude({ mcpServers: { docs: { command: "docs" } } });
		const preview = plan();
		expect(applyStepMcpImport(preview, ["docs"], env).imported).toEqual(["docs"]);
		const replay = applyStepMcpImport(preview, ["docs"], env);
		expect(replay.imported).toEqual([]);
		expect(replay.skipped).toEqual([{ name: "docs", reason: expect.stringContaining("already") }]);
		expect(readGlobalStepConfig(env).mcp_servers).toEqual({ docs: { command: "docs" } });
	});
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
