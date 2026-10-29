import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";
import { MigrationService } from "../src/step/migration/service.ts";
import type { MigrationPlan, MigrationPreview } from "../src/step/migration/types.ts";

let home: string;
let agent: string;
let service: MigrationService;
let sessions: SessionImportService;
function put(path: string, data: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}
function claude(servers: unknown): void {
	put(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
}
async function previews(): Promise<MigrationPreview[]> {
	const scan = await service.scan({ kinds: ["mcp"] });
	return Promise.all(scan.candidates.map((c) => service.preview({ candidateId: c.id })));
}
async function plan(items: MigrationPreview[]): Promise<MigrationPlan> {
	return service.plan(items.map((p) => ({ previewId: p.id, acknowledged: p.requiredAcknowledgements })));
}
async function run(p: MigrationPlan) {
	const job = await service.start({ planId: p.id, digest: p.digest, idempotencyKey: p.id });
	await expect.poll(() => service.getJob(job.id).status).toBe("completed");
	return service.getJob(job.id);
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "mcp-reuse-")));
	agent = join(home, ".profile", "agent");
	sessions = new SessionImportService({ agentDir: agent });
	service = new MigrationService({
		agentDir: agent,
		env: { HOME: home, USERPROFILE: home, STEP_CODING_AGENT_DIR: agent, STEPCODE_CONFIG_DIR: ".profile" },
		sessions,
	});
});
afterEach(async () => {
	await service.close();
	await sessions.close();
	rmSync(home, { recursive: true, force: true });
});

describe("shared MCP migration planning", () => {
	it("shows a server whose name StepCode config.toml already holds without offering it", async () => {
		claude({ docs: { command: "incoming" } });
		put(join(home, ".profile", "config.toml"), '[mcp_servers.docs]\ncommand="existing"\n');
		const scan = await service.scan({ kinds: ["mcp"] });
		expect(scan.candidates[0]).toMatchObject({ name: "docs", holding: "stepcode", needsMigration: false });
		expect(scan.candidates[0]?.diagnostics).toContainEqual(
			expect.objectContaining({ code: "mcp-exists-in-stepcode", path: expect.stringContaining("config.toml") }),
		);
		const skipped = await service.preview({ candidateId: scan.candidates[0]!.id });
		expect(skipped.action).toBe("skip");
		const forced = await service.preview({ candidateId: scan.candidates[0]!.id, action: "import" });
		expect(forced.blockers).toContainEqual({ code: "mcp-exists-in-stepcode" });
	});

	it("offers only the Claude Code server when Codex declares the same name", async () => {
		claude({ docs: { command: "claude-server" }, other: { command: "claude-other" } });
		put(join(home, ".codex", "config.toml"), '[mcp_servers.docs]\ncommand="codex-server"\n');
		const scan = await service.scan({ kinds: ["mcp"] });
		const codex = scan.candidates.find((c) => c.source === "codex");
		expect(codex).toMatchObject({ name: "docs", needsMigration: false });
		expect(codex?.diagnostics).toContainEqual({ code: "mcp-exists-in-claude-code" });
		expect(scan.candidates.filter((c) => c.source === "claude-code").every((c) => c.needsMigration)).toBe(true);
		const forced = await service.preview({ candidateId: codex!.id, action: "import" });
		expect(forced.blockers).toContainEqual({ code: "mcp-exists-in-claude-code" });
		const claudeItems = await Promise.all(
			scan.candidates.filter((c) => c.source === "claude-code").map((c) => service.preview({ candidateId: c.id })),
		);
		const p = await plan(claudeItems);
		expect(p.items.map((i) => i.target.name)).toEqual(["docs", "other"]);
		expect((await run(p)).items.map((i) => i.status)).toEqual(["imported", "imported"]);
	});

	it("does not offer default MCP sources the CLI import review already handled", async () => {
		claude({ docs: { command: "claude-server" } });
		put(join(home, ".codex", "config.toml"), '[mcp_servers.other]\ncommand="codex-server"\n');
		put(join(home, ".profile", "config.toml"), '[mcp_import]\nreviewed = [".claude"]\n');
		const partial = await service.scan({ kinds: ["mcp"] });
		expect(partial.candidates.map((c) => c.source)).toEqual(["codex"]);
		expect(partial.sources.find((r) => r.source === "claude-code")?.diagnostics).toContainEqual({
			code: "mcp-reviewed-by-cli",
		});
		put(join(home, ".profile", "config.toml"), '[mcp_import]\nreviewed = [".claude", ".codex"]\n');
		expect((await service.scan({ kinds: ["mcp"] })).candidates).toEqual([]);
		const custom = join(home, "chosen.json");
		put(custom, JSON.stringify({ mcpServers: { chosen: { command: "chosen" } } }));
		const chosen = await service.scan({ kinds: ["mcp"], mcpSourcePaths: { "claude-code": custom } });
		expect(chosen.candidates.map((c) => c.name)).toEqual(["chosen"]);
	});

	it("uses explicit MCP source files without changing other source roots or creating a target", async () => {
		claude({ defaultServer: { command: "default" } });
		const custom = join(home, "other-profile", "chosen.json");
		put(custom, JSON.stringify({ mcpServers: { chosen: { command: "chosen" } } }));
		const scan = await service.scan({ kinds: ["mcp"], mcpSourcePaths: { "claude-code": custom } });
		expect(scan.candidates.map((c) => c.name)).toEqual(["chosen"]);
		expect(scan.candidates[0]?.sourcePath).toBe(custom);
		expect(existsSync(join(home, ".profile", "config.toml"))).toBe(false);
		await expect(service.scan({ kinds: ["mcp"], mcpSourcePaths: { codex: "relative.toml" } })).rejects.toThrow();
		const reset = await service.scan({ kinds: ["mcp"] });
		expect(reset.candidates.map((c) => c.name)).toEqual(["defaultServer"]);
	});

	it("does not deduplicate distinct source credentials merely because both were omitted", async () => {
		claude({
			one: { command: "server", env: { TOKEN: "FIRST_LITERAL" } },
			two: { command: "server", env: { TOKEN: "SECOND_LITERAL" } },
		});
		const selected = await previews();
		const p = await plan(selected);
		expect(p.items.map((i) => i.action)).toEqual(["import", "import"]);
		expect(JSON.stringify(p)).not.toMatch(/FIRST_LITERAL|SECOND_LITERAL/);
		expect((await run(p)).items.map((i) => i.status)).toEqual(["imported", "imported"]);
	});

	it("keeps per-server parse diagnostics without leaking raw command, URL or warning values", async () => {
		claude({
			ide: { type: "ws-ide" },
			unsupported: { type: "sse", url: "https://private.invalid/SECRET" },
			broken: {},
			"docs/unsafe-name": { command: "SECRET_EXECUTABLE", customSecretField: "SECRET" },
		});
		const scan = await service.scan({ kinds: ["mcp"] });
		expect(scan.candidates).toHaveLength(3);
		expect(scan.candidates.find((c) => c.name === "unsupported")?.diagnostics).toContainEqual({
			code: "mcp-unsupported-transport",
		});
		expect(scan.candidates.find((c) => c.name === "broken")?.diagnostics).toContainEqual({
			code: "mcp-incomplete-config",
		});
		expect(scan.candidates.find((c) => c.name === "docs/unsafe-name")?.readiness).toBe("ready");
		expect(JSON.stringify(scan)).not.toContain("SECRET");
		expect(existsSync(join(home, ".profile", "config.toml"))).toBe(false);
	});
});
