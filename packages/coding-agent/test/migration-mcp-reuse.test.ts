import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	it("renames around an existing different server before confirmation", async () => {
		claude({ docs: { command: "incoming" } });
		put(join(home, ".profile", "config.toml"), '[mcp_servers.docs]\ncommand="existing"\n');
		const [preview] = await previews();
		expect(preview?.blockers).toEqual([]);
		expect(preview?.target.name).toBe("docs-claude");
		const job = await run(await plan([preview!]));
		expect(job.items[0]?.status).toBe("imported");
		const text = readFileSync(join(home, ".profile", "config.toml"), "utf8");
		expect(text).toContain('command = "existing"');
		expect(text).toContain("mcp_servers.docs-claude");
	});

	it("allocates the selected cross-source names in the returned immutable plan", async () => {
		claude({ docs: { command: "claude-server" } });
		put(join(home, ".codex", "config.toml"), '[mcp_servers.docs]\ncommand="codex-server"\n');
		const selected = await previews();
		const p = await plan(selected);
		expect(p.items.map((i) => i.target.name)).toEqual(["docs", "docs-codex"]);
		expect((await run(p)).items.map((i) => i.status)).toEqual(["imported", "imported"]);
	});

	it("allows selecting either source of a duplicate and writes a selected duplicate group once", async () => {
		claude({ docs: { command: "same" } });
		put(join(home, ".codex", "config.toml"), '[mcp_servers.docs]\ncommand="same"\n');
		const selected = await previews();
		const onlySecond = await plan([selected[1]!]);
		expect(onlySecond.items[0]?.action).toBe("import");
		const both = await plan(selected);
		expect(both.items.map((i) => i.action)).toEqual(["import", "skip"]);
		expect((await run(both)).items.map((i) => i.status)).toEqual(["imported", "skipped"]);
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
