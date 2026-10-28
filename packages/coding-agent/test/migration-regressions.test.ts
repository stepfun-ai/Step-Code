import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";
import { MigrationJournalStore } from "../src/step/migration/journal.ts";
import { pluginMcpMatches, sanitizedMcp } from "../src/step/migration/mcp.ts";
import { MigrationPaths } from "../src/step/migration/paths.ts";
import { MigrationService } from "../src/step/migration/service.ts";
import type { MigrationPreview } from "../src/step/migration/types.ts";

let home: string;
let agent: string;
let project: string;
let env: NodeJS.ProcessEnv;
let sessions: SessionImportService;
let service: MigrationService;
const services: MigrationService[] = [];
function put(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
function create(): MigrationService {
	const value = new MigrationService({ agentDir: agent, env, sessions });
	services.push(value);
	return value;
}
async function complete(preview: MigrationPreview) {
	const plan = await service.plan([{ previewId: preview.id, acknowledged: [] }]);
	const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: preview.id });
	await expect.poll(() => service.getJob(job.id).status).toBe("completed");
	return service.getJob(job.id);
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "migration-regressions-")));
	agent = join(home, ".profile", "agent");
	project = join(home, "project");
	mkdirSync(project);
	env = { HOME: home, USERPROFILE: home, STEP_CODING_AGENT_DIR: agent, STEPCODE_CONFIG_DIR: ".profile" };
	sessions = new SessionImportService({ agentDir: agent });
	service = create();
});
afterEach(async () => {
	await Promise.all(services.splice(0).map((s) => s.close()));
	await sessions.close();
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});
describe("confirmed migration regressions", () => {
	it.each([`\${KEY}`, `\${KEY:-}`])("preserves safe unexpanded reference %s", (value) => {
		expect(sanitizedMcp({ command: "fixture", env: { KEY: value } }, false).config.env).toEqual({ KEY: value });
	});
	it.each([`\${KEY:-PRIVATE_FALLBACK}`, `\${KEY:-\${OTHER:-PRIVATE_FALLBACK}}`])(
		"omits literal fallback %s without consent",
		async (value) => {
			expect(
				sanitizedMcp({ command: "fixture", env: { KEY: value }, http_headers: { Authorization: value } }, false),
			).toMatchObject({ stripped: true, config: { enabled: false } });
			expect(sanitizedMcp({ command: "fixture", env: { KEY: value } }, false).config.env).toBeUndefined();
			expect(
				sanitizedMcp({ command: "fixture", http_headers: { Authorization: value } }, false).config.http_headers,
			).toBeUndefined();
			expect(sanitizedMcp({ command: "fixture", args: [value, "--ordinary"] }, false).config.args).toEqual([
				"--ordinary",
			]);
			put(
				join(home, ".claude.json"),
				JSON.stringify({ mcpServers: { fixture: { command: "fixture", env: { KEY: value } } } }),
			);
			const c = (await service.scan({ kinds: ["mcp"] })).candidates[0]!;
			const p = await service.preview({ candidateId: c.id });
			expect(JSON.stringify(p)).not.toContain("PRIVATE_FALLBACK");
			await complete(p);
			expect(readFileSync(join(dirname(agent), "config.toml"), "utf8")).not.toContain("PRIVATE_FALLBACK");
			const explicit = await service.preview({ candidateId: c.id, includeSensitiveValues: true });
			expect(explicit.requiredAcknowledgements).toContain("sensitive-values");
			const consent = await service.preview({
				candidateId: c.id,
				includeSensitiveValues: true,
				targetName: "consented",
			});
			await expect(service.plan([{ previewId: consent.id, acknowledged: [] }])).rejects.toMatchObject({
				code: "acknowledgement-required",
			});
			const plan = await service.plan([{ previewId: consent.id, acknowledged: ["sensitive-values"] }]);
			const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: consent.id });
			await expect.poll(() => service.getJob(job.id).status).toBe("completed");
			expect(service.getJob(job.id).items[0]?.status).toBe("imported");
			expect(readFileSync(join(dirname(agent), "config.toml"), "utf8")).toContain(value);
			expect(JSON.stringify(consent)).not.toContain("PRIVATE_FALLBACK");
		},
	);
	it("rejects a deleted selected project before any batch write", async () => {
		put(join(home, ".claude", "commands", "fixture.md"), "fixture");
		put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
		const c = (await service.scan({ kinds: ["prompts"], projectCwds: [project] })).candidates[0]!;
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		const global = await service.preview({ candidateId: c.id, target: { kind: "global" } });
		const plan = await service.plan([
			{ previewId: global.id, acknowledged: [] },
			{ previewId: p.id, acknowledged: [] },
		]);
		rmSync(project, { recursive: true });
		await expect(service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: p.id })).rejects.toMatchObject(
			{ code: "invalid-projects" },
		);
		expect(existsSync(project)).toBe(false);
		expect(existsSync(join(agent, "migration"))).toBe(false);
		expect(existsSync(join(agent, "prompts", "fixture.md"))).toBe(false);
	});
	it.each(["preview", "plan", "start"])("rejects replaced project identity at %s", async (phase) => {
		put(join(home, ".claude", "commands", "fixture.md"), "fixture");
		put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
		const c = (await service.scan({ kinds: ["prompts"], projectCwds: [project] })).candidates[0]!;
		const input = { candidateId: c.id, target: { kind: "project" as const, cwd: project } };
		const p = phase === "preview" ? undefined : await service.preview(input);
		const plan = phase === "start" ? await service.plan([{ previewId: p!.id, acknowledged: [] }]) : undefined;
		renameSync(project, join(home, "old-project"));
		mkdirSync(project);
		const action =
			phase === "preview"
				? service.preview(input)
				: phase === "plan"
					? service.plan([{ previewId: p!.id, acknowledged: [] }])
					: service.start({ planId: plan!.id, digest: plan!.digest, idempotencyKey: p!.id });
		await expect(action).rejects.toMatchObject({ code: "invalid-projects" });
		expect(existsSync(join(project, ".profile"))).toBe(false);
	});
	it("does not recreate a project deleted after its durable resource intent", async () => {
		put(join(home, ".claude", "commands", "fixture.md"), "fixture");
		put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
		const c = (await service.scan({ kinds: ["prompts"], projectCwds: [project] })).candidates[0]!;
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		const write = MigrationJournalStore.prototype.write;
		vi.spyOn(MigrationJournalStore.prototype, "write").mockImplementation(function (
			this: MigrationJournalStore,
			journal,
		) {
			write.call(this, journal);
			if (journal.intents.length && existsSync(project)) rmSync(project, { recursive: true });
		});
		const job = await complete(p);
		expect(job.items[0]).toMatchObject({ status: "failed", diagnostics: [{ code: "invalid-projects" }] });
		expect(existsSync(project)).toBe(false);
	});
	it.each([
		["skills", ".ignore"],
		["prompts", ".ignore"],
		["skills", ".gitignore"],
		["prompts", ".gitignore"],
		["skills", ".fdignore"],
		["prompts", ".fdignore"],
	] as const)("reports ignored destination %s via %s and fingerprints ignore content", async (kind, ignoreName) => {
		put(
			kind === "skills"
				? join(home, ".codex", "skills", "fixture", "SKILL.md")
				: join(home, ".codex", "prompts", "fixture.md"),
			kind === "skills" ? "---\nname: fixture\ndescription: Fixture\n---\nFixture" : "Fixture",
		);
		const ignore = join(agent, kind, ignoreName);
		put(ignore, kind === "skills" ? "fixture/\n" : "fixture.md\n");
		const c = (await service.scan({ kinds: [kind] })).candidates.find((v) => v.source === "codex")!;
		const p = await service.preview({ candidateId: c.id });
		expect(p.activation).toBe("disabled");
		expect(p.warnings).toContainEqual({ code: "target-disabled" });
		const plan = await service.plan([{ previewId: p.id, acknowledged: [] }]);
		put(ignore, `${kind === "skills" ? "fixture/\n" : "fixture.md\n"}# changed, still ignored\n`);
		await expect(service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: p.id })).rejects.toMatchObject(
			{ code: "preview-changed" },
		);
	});
	it.each(["", "subdir", "../escape"])("matches runtime plugin cwd normalization for %s", (cwd) => {
		const root = join(home, ".profile", "plugins", "fixture");
		put(
			join(root, "step.plugin.json"),
			JSON.stringify({ id: "fixture", mcpServers: { fixture: { command: "fixture", cwd } } }),
		);
		const paths = new MigrationPaths(agent, env);
		const expected = cwd === "subdir" ? join(root, cwd) : root;
		expect(pluginMcpMatches(paths, { command: "fixture", cwd: expected })).toHaveLength(1);
		if (cwd === "subdir") expect(pluginMcpMatches(paths, { command: "fixture", cwd: root })).toHaveLength(0);
	});
	it.each([false, true])("reports unsupported embedded project MCP even with top-level servers=%s", async (top) => {
		put(
			join(home, ".claude.json"),
			JSON.stringify({
				mcpServers: top ? { global: { command: "fixture" } } : {},
				projects: {
					"/UNSELECTED_PRIVATE_CWD": {
						mcpServers: { private: { command: "PRIVATE_COMMAND", env: { TOKEN: "PRIVATE_SECRET" } } },
					},
				},
			}),
		);
		const scan = await service.scan({ kinds: ["mcp"] });
		expect(scan.sources.some((s) => s.diagnostics.some((d) => d.code === "project-mcp-source-unsupported"))).toBe(
			true,
		);
		expect(scan.candidates).toHaveLength(top ? 1 : 0);
		expect(JSON.stringify(scan)).not.toMatch(/PRIVATE_COMMAND|PRIVATE_SECRET|UNSELECTED_PRIVATE_CWD/u);
	});
	it("reconciles reimport intent using verified existing cwd rather than requested cwd", async () => {
		const other = join(home, "other");
		mkdirSync(other);
		put(
			join(home, ".codex", "sessions", "rollout-fixture.jsonl"),
			[
				{ type: "session_meta", payload: { id: "regression", cwd: project } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture history" }] },
				},
			]
				.map((v) => JSON.stringify(v))
				.join("\n"),
		);
		const c = (await service.scan({ kinds: ["sessions"], projectCwds: [project, other] })).candidates[0]!;
		await complete(await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } }));
		const job = await complete(await service.preview({ candidateId: c.id, target: { kind: "project", cwd: other } }));
		await service.close();
		const path = join(agent, "migration", `${job.id}.json`);
		const journal = JSON.parse(readFileSync(path, "utf8"));
		journal.job.status = "running";
		journal.job.items[0].status = "running";
		delete journal.job.items[0].actualTarget;
		journal.intents[0].committed = false;
		put(path, JSON.stringify(journal));
		expect(create().getJob(job.id).items[0]).toMatchObject({
			actualTarget: { scope: { kind: "project", cwd: project } },
		});
		delete journal.intents[0].actualScope;
		put(path, JSON.stringify(journal));
		expect(create().getJob(job.id).items[0]).toMatchObject({
			status: "failed",
			diagnostics: [{ code: "publication-uncertain" }],
		});
		journal.intents[0].actualScope = { kind: "project", cwd: "relative/private" };
		put(path, JSON.stringify(journal));
		expect(() => create()).toThrow("invalid-journal");
	});
});
