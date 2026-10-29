import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";
import * as settings from "../src/core/settings-manager.ts";
import { MigrationService } from "../src/step/migration/service.ts";
import type { MigrationAcknowledgement, MigrationKind, MigrationPreview } from "../src/step/migration/types.ts";

let home: string;
let agent: string;
let project: string;
let service: MigrationService;
let sessions: SessionImportService;
let env: NodeJS.ProcessEnv;
const services: MigrationService[] = [];
function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function skill(name: string): string {
	return `---\nname: ${name}\ndescription: Fixture skill\n---\nRead references/help.md.\n`;
}
function create(): MigrationService {
	const instance = new MigrationService({ agentDir: agent, env, sessions });
	services.push(instance);
	return instance;
}
async function candidate(kind: MigrationKind, name?: string) {
	const scan = await service.scan({ kinds: [kind], projectCwds: [project] });
	const item = scan.candidates.find((c) => !name || c.name === name);
	expect(item, JSON.stringify(scan)).toBeDefined();
	return item!;
}
async function complete(preview: MigrationPreview, acknowledged: MigrationAcknowledgement[] = []) {
	const plan = await service.plan([{ previewId: preview.id, acknowledged }]);
	const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: `test-${preview.id}` });
	await expect
		.poll(() => service.getJob(job.id).status, { timeout: 5000, interval: 10 })
		.toMatch(/^(completed|cancelled|interrupted)$/u);
	return service.getJob(job.id);
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "migration-fixture-")));
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

describe("migration safety boundaries", () => {
	it("uses an explicitly chosen target without treating it as a source project", async () => {
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const target = join(home, "new-target");
		mkdirSync(target);
		put(join(agent, "trust.json"), JSON.stringify({ [target]: true }));
		put(join(target, ".claude", "skills", "private", "SKILL.md"), skill("private"));
		const scan = await service.scan({ kinds: ["skills"], projectCwds: [] });
		const source = scan.candidates.find((item) => item.name === "review");
		expect(source).toBeDefined();
		const preview = await service.preview({ candidateId: source!.id, target: { kind: "project", cwd: target } });
		expect(preview.target.scope).toEqual({ kind: "project", cwd: target });
		expect(preview.blockers).toEqual([]);
		const again = await service.scan({ kinds: ["skills"], projectCwds: [] });
		expect(again.candidates.some((item) => item.name === "private")).toBe(false);
		const job = await complete(preview, preview.requiredAcknowledgements);
		expect(job.items[0]?.status).toBe("imported");
		expect(readFileSync(join(preview.target.path, "SKILL.md"), "utf8")).toContain("Fixture skill");
	});

	it("does not recreate an explicitly selected destination removed after preview", async () => {
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const source = await candidate("skills", "review");
		const target = join(home, "new-target");
		mkdirSync(target);
		const preview = await service.preview({ candidateId: source.id, target: { kind: "project", cwd: target } });
		rmSync(target, { recursive: true });
		await expect(
			service.plan([{ previewId: preview.id, acknowledged: preview.requiredAcknowledgements }]),
		).rejects.toThrow();
		expect(existsSync(target)).toBe(false);
	});
	it("reconciles a published intent after interruption without replay or source text in the journal", async () => {
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const c = await candidate("skills");
		const p = await service.preview({ candidateId: c.id });
		const job = await complete(p);
		await service.close();
		const path = join(agent, "migration", `${job.id}.json`);
		const journal = JSON.parse(readFileSync(path, "utf8"));
		expect(JSON.stringify(journal)).not.toContain("SOURCE_TEXT_ONLY_IN_RESOURCE");
		journal.job.status = "running";
		journal.job.items[0].status = "running";
		journal.intents[0].committed = false;
		put(path, JSON.stringify(journal));
		const before = readFileSync(path, "utf8");
		const restarted = create();
		expect(restarted.getJob(job.id)).toMatchObject({
			status: "interrupted",
			items: [{ status: "imported", diagnostics: [{ code: "publication-reconciled" }] }],
		});
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("performs MCP target CAS inside the shared settings lock", async () => {
		put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { local: { command: "fixture-server" } } }));
		const target = join(dirname(agent), "config.toml");
		put(target, 'defaultModel="before"\n');
		const c = await candidate("mcp");
		const p = await service.preview({ candidateId: c.id });
		const lock = settings.acquireSettingsLockSync;
		vi.spyOn(settings, "acquireSettingsLockSync").mockImplementation((path) => {
			if (path === target) put(target, 'defaultModel="concurrent-editor"\n');
			return lock(path);
		});
		const job = await complete(p);
		expect(job).toMatchObject({
			status: "completed",
			items: [{ status: "failed", diagnostics: [{ code: "target-changed" }] }],
		});
		expect(readFileSync(target, "utf8")).toBe('defaultModel="concurrent-editor"\n');
	});

	it("writes multiple independent MCP entries in one job without losing unrelated fields", async () => {
		put(
			join(home, ".claude.json"),
			JSON.stringify({ mcpServers: { one: { command: "one" }, two: { command: "two" } } }),
		);
		const scan = await service.scan({ kinds: ["mcp"] });
		const previews = await Promise.all(scan.candidates.map((c) => service.preview({ candidateId: c.id })));
		const plan = await service.plan(previews.map((p) => ({ previewId: p.id, acknowledged: [] })));
		const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: "multi-mcp" });
		await expect.poll(() => service.getJob(job.id).status).toBe("completed");
		expect(service.getJob(job.id).items.map((i) => i.status)).toEqual(["imported", "imported"]);
		const target = readFileSync(join(dirname(agent), "config.toml"), "utf8");
		expect(target).toContain("mcp_servers.one");
		expect(target).toContain("mcp_servers.two");
	});

	it("honors injected source and plugin paths without expanding environment secrets", async () => {
		const codex = join(home, "foreign-profile");
		const storage = join(home, "plugin-storage");
		put(join(codex, "config.toml"), '[mcp_servers.remote]\nurl="https://fixture.invalid/mcp"\n');
		put(
			join(storage, "plugins", "fixture", "step.plugin.json"),
			JSON.stringify({
				id: "fixture",
				mcpServers: { remote: { url: "https://fixture.invalid/mcp", enabled: false } },
			}),
		);
		env = { ...env, CODEX_HOME: codex, STEPCODE_STORAGE_ROOT_DIR: storage, FIXTURE_TOKEN: "NEVER_EXPAND_THIS" };
		service = create();
		const c = await candidate("mcp");
		expect(c).toMatchObject({
			sourcePath: join(codex, "config.toml"),
			holding: "plugin",
			readiness: "disabled",
			needsMigration: false,
		});
		const p = await service.preview({ candidateId: c.id });
		expect(p.action).toBe("skip");
		expect(JSON.stringify(p)).not.toContain("NEVER_EXPAND_THIS");
		expect(existsSync(agent)).toBe(false);
	});

	it("rejects target links, traversal and unselected projects before publication", async () => {
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const c = await candidate("skills");
		await expect(service.preview({ candidateId: c.id, targetName: "../escape" })).rejects.toMatchObject({
			code: "invalid-resource-name",
		});
		const untrusted = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: home } });
		expect(untrusted.blockers).toContainEqual({ code: "target-untrusted" });
		await expect(
			service.plan([{ previewId: untrusted.id, acknowledged: untrusted.requiredAcknowledgements }]),
		).rejects.toThrow();
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(home, "outside"));
		symlinkSync(join(home, "outside"), join(agent, "skills"));
		await expect(service.preview({ candidateId: c.id })).rejects.toMatchObject({ code: "unsafe-link" });
		expect(readdirSync(join(home, "outside"))).toEqual([]);
	});

	it("does not detach plugin-owned skills or silently shadow them with a new copy", async () => {
		const plugin = join(home, ".profile", "plugins", "fixture");
		put(join(plugin, "step.plugin.json"), JSON.stringify({ id: "fixture", skills: ["skills"] }));
		put(join(plugin, "skills", "demo", "SKILL.md"), skill("demo"));
		put(join(home, ".codex", "skills", "demo", "SKILL.md"), skill("demo"));
		const scan = await service.scan({ kinds: ["skills"] });
		const owned = scan.candidates.find((c) => c.source === "plugin")!;
		expect(owned).toMatchObject({ holding: "plugin", needsMigration: false, readiness: "ready" });
		const keep = await service.preview({ candidateId: owned.id });
		expect(keep).toMatchObject({
			action: "skip",
			target: { path: join(plugin, "skills", "demo", "SKILL.md") },
			allowedActions: ["skip"],
		});
		const external = scan.candidates.find((c) => c.source === "codex")!;
		const copy = await service.preview({ candidateId: external.id });
		expect(copy.blockers.map((b) => b.code)).toContain("skill-name-conflict");
	});

	it("matches nested-worktree rule precedence without executing Git", async () => {
		const nested = join(project, "nested");
		const gitDir = join(project, ".git", "worktrees", "nested");
		put(join(project, "AGENTS.md"), "Main repository rule");
		put(join(nested, "AGENTS.md"), "Worktree rule");
		put(join(nested, ".git"), `gitdir: ${gitDir}\n`);
		put(join(gitDir, "HEAD"), "ref: refs/heads/fixture\n");
		put(join(gitDir, "commondir"), "../..\n");
		put(join(home, ".claude", "CLAUDE.md"), "Replacement rule");
		const scan = await service.scan({ kinds: ["rules"], projectCwds: [nested] });
		const source = scan.candidates.find((c) => c.sourceScope.kind === "global")!;
		const p = await service.preview({
			candidateId: source.id,
			target: { kind: "project", cwd: nested },
			action: "replace",
		});
		expect(p.ruleImpact?.before).toContain(join(nested, "AGENTS.md"));
		expect(p.ruleImpact?.before).not.toContain(join(project, "AGENTS.md"));
		expect(p.ruleImpact?.after).not.toContain(join(project, "AGENTS.md"));
	});

	it("never overwrites an existing skill directory", async () => {
		put(join(home, ".codex", "skills", "demo", "SKILL.md"), skill("demo"));
		put(join(agent, "skills", "demo", "keep.txt"), "unchanged");
		const c = await candidate("skills", "demo");
		const p = await service.preview({ candidateId: c.id });
		expect(p.blockers.map((b) => b.code)).toContain("target-conflict");
		await expect(service.plan([{ previewId: p.id, acknowledged: [] }])).rejects.toMatchObject({
			code: "migration-blocked",
		});
		expect(readFileSync(join(agent, "skills", "demo", "keep.txt"), "utf8")).toBe("unchanged");
	});

	it("invalidates consent when the original source changes", async () => {
		const source = join(home, ".claude", "CLAUDE.md");
		put(source, "before");
		const c = await candidate("rules");
		const p = await service.preview({ candidateId: c.id });
		put(source, "after");
		await expect(service.plan([{ previewId: p.id, acknowledged: ["rules-impact"] }])).rejects.toMatchObject({
			code: "preview-changed",
		});
		expect(existsSync(join(agent, "AGENTS.md"))).toBe(false);
	});
});

describe("unified session publication", () => {
	it("redacts callback warning details without hiding a successful publication", async () => {
		await service.close();
		await sessions.close();
		sessions = new SessionImportService({
			agentDir: agent,
			onPersisted: () => {
				throw new Error("PRIVATE_CALLBACK_DETAIL");
			},
		});
		service = create();
		put(
			join(home, ".codex", "sessions", "rollout-warning.jsonl"),
			[
				{ type: "session_meta", payload: { id: "warning-fixture", cwd: project } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture history" }] },
				},
			]
				.map((value) => JSON.stringify(value))
				.join("\n"),
		);
		const c = await candidate("sessions");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		const job = await complete(p);
		expect(job.items[0]).toMatchObject({
			status: "imported",
			diagnostics: [{ code: "session-publication-warning" }],
		});
		expect(JSON.stringify(job)).not.toContain("PRIVATE_CALLBACK_DETAIL");
		expect(readFileSync(join(agent, "migration", `${job.id}.json`), "utf8")).not.toContain("PRIVATE_CALLBACK_DETAIL");
	});

	it("reads the actual existing cwd after losing an atomic publication race", async () => {
		const other = join(home, "other");
		mkdirSync(other);
		put(
			join(home, ".codex", "sessions", "rollout-race.jsonl"),
			[
				{ type: "session_meta", payload: { id: "race-fixture", cwd: project } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture history" }] },
				},
			]
				.map((value) => JSON.stringify(value))
				.join("\n"),
		);
		const scan = await service.scan({ kinds: ["sessions"], projectCwds: [project, other] });
		const c = scan.candidates[0]!;
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: other } });
		const native = await sessions.preview(c.id);
		const winner = await sessions.reserve([{ candidateId: c.id, fingerprint: native.fingerprint, cwd: project }]);
		const reserve = sessions.reserve.bind(sessions);
		vi.spyOn(sessions, "reserve").mockImplementation(async (selections) => {
			const loser = await reserve(selections);
			expect(loser.items[0]?.existing).toBeUndefined();
			await winner.items[0]!.publish();
			return loser;
		});
		try {
			const job = await complete(p);
			expect(job.items[0]).toMatchObject({
				status: "skipped",
				requestedTarget: { scope: { cwd: other } },
				actualTarget: { scope: { cwd: project } },
			});
		} finally {
			await winner.release();
		}
	});

	it("uses the injected reservation without a nested job and reports the existing target cwd", async () => {
		put(
			join(home, ".codex", "sessions", "rollout-fixture.jsonl"),
			[
				{ type: "session_meta", payload: { id: "unified-fixture", cwd: project } },
				{
					type: "response_item",
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Reviewed fixture history" }],
					},
				},
			]
				.map((value) => JSON.stringify(value))
				.join("\n"),
		);
		const legacyStart = vi.spyOn(sessions, "start");
		const reserve = vi.spyOn(sessions, "reserve");
		const c = await candidate("sessions");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		const first = await complete(p);
		expect(first.items[0]?.status).toBe("imported");
		expect(reserve).toHaveBeenCalledTimes(1);
		expect(legacyStart).not.toHaveBeenCalled();
		expect(await sessions.listJobs()).toEqual([]);
		const actual = first.items[0]!.actualTarget!.path;
		expect(readFileSync(actual, "utf8")).toContain("Reviewed fixture history");
		const other = join(home, "other");
		mkdirSync(other);
		const rescanned = await service.scan({ kinds: ["sessions"], projectCwds: [other] });
		const again = await service.preview({
			candidateId: rescanned.candidates[0]!.id,
			target: { kind: "project", cwd: other },
		});
		const second = await complete(again);
		expect(second.items[0]).toMatchObject({
			status: "skipped",
			requestedTarget: { scope: { cwd: other } },
			actualTarget: { scope: { cwd: project }, path: actual },
		});
	});

	it("waits for a current session publication and its reservation release on close", async () => {
		put(
			join(home, ".codex", "sessions", "rollout-fixture.jsonl"),
			[
				{ type: "session_meta", payload: { id: "close-fixture", cwd: project } },
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Close fixture" }] },
				},
			]
				.map((value) => JSON.stringify(value))
				.join("\n"),
		);
		let allowPublication!: () => void;
		const gate = new Promise<void>((resolve) => {
			allowPublication = resolve;
		});
		let entered!: () => void;
		const publishing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let released = false;
		const original = sessions.reserve.bind(sessions);
		vi.spyOn(sessions, "reserve").mockImplementation(async (selections) => {
			const reservation = await original(selections);
			return {
				items: reservation.items.map((item) => ({
					...item,
					async publish() {
						entered();
						await gate;
						return item.publish();
					},
				})),
				async release() {
					await reservation.release();
					released = true;
				},
			};
		});
		const c = await candidate("sessions");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		const plan = await service.plan([{ previewId: p.id, acknowledged: [] }]);
		const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: "closing" });
		await publishing;
		let closed = false;
		const closing = service.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		allowPublication();
		await closing;
		expect(released).toBe(true);
		expect(service.getJob(job.id).items[0]?.status).toBe("imported");
		expect(
			(
				await sessions.scan({
					codexRoot: join(home, ".codex"),
					claudeRoot: join(home, "missing-claude"),
					workbuddyRoot: join(home, "missing-workbuddy"),
					qoderRoot: join(home, "missing-qoder"),
				})
			).candidates.length,
		).toBe(1);
	});
});

describe("offline migration rules and jobs", () => {
	it("requires consent for NEW rules, displays shadowed paths, and creates no fake backup", async () => {
		put(join(home, ".claude", "CLAUDE.md"), "Write tests first.");
		put(join(agent, "CLAUDE.md"), "Existing lower-priority rules.");
		const c = await candidate("rules");
		const p = await service.preview({ candidateId: c.id });
		expect(p.ruleImpact).toMatchObject({
			before: expect.arrayContaining([join(agent, "CLAUDE.md")]),
			after: expect.arrayContaining([join(agent, "AGENTS.md")]),
			shadowed: [join(agent, "CLAUDE.md")],
			backupRequired: false,
		});
		// Rule writes no longer require a separate impact acknowledgement; the preview is the consent surface.
		expect(existsSync(join(agent, "AGENTS.md"))).toBe(false);
		const job = await complete(p, []);
		expect(job.items[0]?.status).toBe("imported");
		expect(job.items[0]?.backupId).toBeUndefined();
		expect(readFileSync(join(agent, "AGENTS.md"), "utf8")).toBe("Write tests first.");
	});

	it("invalidates the entire batch if a source, target or effective rule set changes", async () => {
		put(join(home, ".claude", "CLAUDE.md"), "Reviewed rules.");
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const rule = await candidate("rules");
		const resource = await candidate("skills");
		const p = await service.preview({ candidateId: rule.id });
		const q = await service.preview({ candidateId: resource.id });
		const plan = await service.plan([
			{ previewId: q.id, acknowledged: [] },
			{ previewId: p.id, acknowledged: ["rules-impact"] },
		]);
		put(join(agent, "AGENTS.override.md"), "New higher-priority rules");
		await expect(
			service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: "stale-plan" }),
		).rejects.toMatchObject({ code: "preview-changed", status: 409 });
		expect(existsSync(join(agent, "skills", "review", "SKILL.md"))).toBe(false);
		expect(service.listJobs()).toEqual([]);
		const blocked = await service.preview({ candidateId: rule.id });
		expect(blocked.blockers.map((b) => b.code)).toContain("rule-higher-priority-override");
	});

	it("keeps a foreign MCP importable when StepCode storage sits under a symlinked root", async () => {
		// macOS /var and /tmp are symlinks; a raw storage root must not fail plugin inspection.
		const real = join(home, "real-storage");
		mkdirSync(join(real, "plugins"), { recursive: true });
		// Reach the storage through a symlink, the way /var and /tmp resolve on macOS.
		const storage = join(home, "linked-storage");
		symlinkSync(real, storage);
		put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { command: "fixture-docs" } } }));
		env = { ...env, STEPCODE_STORAGE_ROOT_DIR: storage };
		service = create();
		const scan = await service.scan({ kinds: ["mcp"] });
		const docs = scan.candidates.find((c) => c.name === "docs");
		expect(docs?.readiness).toBe("ready");
		expect(docs?.needsMigration).toBe(true);
		expect(docs?.diagnostics).toEqual([]);
	});

	it("lists one rule file once on case-insensitive filesystems", async () => {
		put(join(home, ".codex", "AGENTS.md"), "# Codex fixture rules\n");
		const scan = await service.scan({ kinds: ["rules"] });
		const codex = scan.candidates.filter((c) => c.source === "codex");
		// AGENTS.md and AGENTS.MD name the same file here; only one may be offered.
		assert.equal(codex.length, 1);
		assert.equal(codex[0]?.name, "AGENTS.md");
		const preview = await service.preview({ candidateId: codex[0]!.id });
		assert.equal(preview.action, "create");
	});

	it("preserves project root rules already consumed by the loader", async () => {
		put(join(project, "CLAUDE.md"), "Project rules");
		const c = await candidate("rules");
		expect(c).toMatchObject({ holding: "reference", needsMigration: false });
		const p = await service.preview({ candidateId: c.id });
		expect(p.action).toBe("skip");
		expect(p.requiredAcknowledgements).toEqual([]);
	});

	it("backs up rule replacements and requires independent recovery consent and unchanged target", async () => {
		put(join(home, ".claude", "CLAUDE.md"), "New rules");
		put(join(agent, "AGENTS.md"), "Original rules");
		const c = await candidate("rules");
		const p = await service.preview({ candidateId: c.id, action: "replace" });
		expect(p).toMatchObject({
			sourceText: "New rules",
			targetText: "Original rules",
			resultText: "New rules",
			ruleImpact: { backupRequired: true },
		});
		const job = await complete(p, ["rules-impact"]);
		expect(job.items[0]?.status).toBe("imported");
		const recovery = service.previewRecovery(job.id, p.id);
		expect(() => service.recover({ previewId: recovery.id, acknowledged: [] })).toThrow("acknowledgement-required");
		put(join(agent, "AGENTS.md"), "Edited later");
		expect(() => service.recover({ previewId: recovery.id, acknowledged: ["rules-impact"] })).toThrow(
			"recovery-target-changed",
		);
		put(join(agent, "AGENTS.md"), "New rules");
		expect(service.recover({ previewId: recovery.id, acknowledged: ["rules-impact"] })).toEqual({ restored: true });
		expect(readFileSync(join(agent, "AGENTS.md"), "utf8")).toBe("Original rules");
	});

	it("persists idempotency across service instances without replaying writes", async () => {
		put(join(home, ".codex", "skills", "review", "SKILL.md"), skill("review"));
		const c = await candidate("skills");
		const p = await service.preview({ candidateId: c.id });
		const plan = await service.plan([{ previewId: p.id, acknowledged: [] }]);
		const job = await complete(p);
		await service.close();
		const restarted = create();
		const replay = await restarted.start({ planId: plan.id, digest: plan.digest, idempotencyKey: `test-${p.id}` });
		expect(replay.id).toBe(job.id);
		expect(restarted.listJobs()).toHaveLength(1);
		await expect(
			restarted.start({ planId: plan.id, digest: "different", idempotencyKey: `test-${p.id}` }),
		).rejects.toMatchObject({ code: "idempotency-conflict" });
	});

	it("cancels before the first publication and protects one active job per agent directory", async () => {
		put(join(home, ".codex", "skills", "one", "SKILL.md"), skill("one"));
		put(join(home, ".codex", "skills", "two", "SKILL.md"), skill("two"));
		const c = await candidate("skills", "one");
		const p = await service.preview({ candidateId: c.id });
		const plan = await service.plan([{ previewId: p.id, acknowledged: [] }]);
		const other = create();
		const otherCandidate = (await other.scan({ kinds: ["skills"] })).candidates[0]!;
		const otherPreview = await other.preview({ candidateId: otherCandidate.id });
		const otherPlan = await other.plan([{ previewId: otherPreview.id, acknowledged: [] }]);
		const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: "cancel" });
		await expect(
			other.start({ planId: otherPlan.id, digest: otherPlan.digest, idempotencyKey: "other" }),
		).rejects.toMatchObject({ code: "migration-busy" });
		service.cancel(job.id);
		await service.close();
		expect(service.getJob(job.id)).toMatchObject({ status: "cancelled", items: [{ status: "not-run" }] });
		expect(existsSync(join(agent, "skills", "one", "SKILL.md"))).toBe(false);
	});
});

describe("offline migration resources", () => {
	it("scans and previews without creating config, trust, locks or jobs", async () => {
		put(
			join(home, ".claude.json"),
			JSON.stringify({ mcpServers: { search: { command: "fixture-mcp", args: ["--safe"] } } }),
		);
		const before = readdirSync(home);
		const c = await candidate("mcp");
		const preview = await service.preview({ candidateId: c.id });
		expect(preview.blockers).toEqual([]);
		expect(preview.sourceText).not.toContain("fixture-mcp");
		expect(readdirSync(home)).toEqual(before);
		expect(existsSync(agent)).toBe(false);
	});

	it("writes global MCP disabled, strips literal secrets, preserves references and unrelated settings", async () => {
		put(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.lookup]\nurl="https://fixture.invalid/mcp?token=PRIVATE_QUERY"\nbearer_token_env_var="FIXTURE_TOKEN"\n[mcp_servers.lookup.http_headers]\nAuthorization="PRIVATE_HEADER"\n',
		);
		put(
			join(dirname(agent), "config.toml"),
			'# retained header\ndefaultModel="fixture-model"\n[mcp_import]\nreviewed=true\n',
		);
		const c = await candidate("mcp");
		expect(c.needsMigration).toBe(true);
		const p = await service.preview({ candidateId: c.id });
		expect(JSON.stringify(p)).not.toMatch(/PRIVATE_QUERY|PRIVATE_HEADER|fixture.invalid/u);
		const job = await complete(p);
		expect(job.items[0]?.status).toBe("imported");
		const target = readFileSync(join(dirname(agent), "config.toml"), "utf8");
		expect(target).toContain("enabled = false");
		expect(target).toContain("FIXTURE_TOKEN");
		expect(target).toContain("fixture-model");
		expect(target).not.toMatch(/PRIVATE_QUERY|PRIVATE_HEADER/u);
		const journal = readFileSync(join(agent, "migration", `${job.id}.json`), "utf8");
		expect(journal).not.toMatch(/PRIVATE_QUERY|PRIVATE_HEADER|fixture.invalid|FIXTURE_TOKEN/u);
	});

	it("requires explicit sensitive inclusion and writes a project MCP target", async () => {
		put(
			join(home, ".claude.json"),
			JSON.stringify({ mcpServers: { local: { command: "server", env: { API_KEY: "PRIVATE_LITERAL" } } } }),
		);
		put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
		const c = await candidate("mcp");
		const projectPreview = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		expect(projectPreview.blockers).toEqual([]);
		expect(projectPreview.target.path).toBe(join(project, ".profile", "config.toml"));
		const p = await service.preview({ candidateId: c.id, includeSensitiveValues: true });
		expect(JSON.stringify(p)).not.toContain("PRIVATE_LITERAL");
		await expect(service.plan([{ previewId: p.id, acknowledged: [] }])).rejects.toMatchObject({
			code: "acknowledgement-required",
		});
		const job = await complete(p, ["sensitive-values"]);
		expect(job.items[0]?.status).toBe("imported");
		expect(readFileSync(join(dirname(agent), "config.toml"), "utf8")).toContain("PRIVATE_LITERAL");
	});

	it("writes an MCP server into a trusted project config and leaves the global one alone", async () => {
		put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { local: { command: "server" } } }));
		put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
		const c = await candidate("mcp");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		expect(p.blockers).toEqual([]);
		const job = await complete(p);
		expect(job.items[0]?.status).toBe("imported");
		const written = readFileSync(join(project, ".profile", "config.toml"), "utf8");
		expect(written).toContain("[mcp_servers.local]");
		expect(written).toContain('command = "server"');
		expect(written).toContain("enabled = false");
		// The global config must not gain the server; an empty file may exist from reads.
		const global = existsSync(join(dirname(agent), "config.toml"))
			? readFileSync(join(dirname(agent), "config.toml"), "utf8")
			: "";
		expect(global).not.toContain("mcp_servers.local");
		// Re-previewing against the same project must report it as already configured.
		const again = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		expect(again.action).toBe("skip");
		expect(again.blockers).toEqual([]);
	});

	it("compares complete MCP declarations without treating reviewed as proof of import", async () => {
		put(join(home, ".codex", "config.toml"), '[mcp_servers.a]\ncommand="server"\ndisabled_tools=["delete"]\n');
		put(join(dirname(agent), "config.toml"), '[mcp_servers.a]\ncommand="server"\ndisabled_tools=["other"]\n');
		const c = await candidate("mcp");
		expect(c.needsMigration).toBe(true);
		const p = await service.preview({ candidateId: c.id });
		expect(p.blockers).toEqual([]);
		expect(p.target.name).toBe("a-codex");
		expect(p.warnings.map((b) => b.code)).toContain("mcp-name-conflict");
		put(
			join(dirname(agent), "config.toml"),
			'[mcp_servers.other]\ncommand="server"\ndisabled_tools=["delete"]\nenabled=false\n',
		);
		const same = await candidate("mcp");
		expect(same).toMatchObject({ holding: "stepcode", readiness: "disabled", needsMigration: false });
	});

	it("refuses malformed target config rather than replacing it", async () => {
		put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { local: { command: "server" } } }));
		put(join(dirname(agent), "config.toml"), "broken = [");
		const c = await candidate("mcp");
		expect(c.readiness).toBe("unsupported");
		await expect(service.preview({ candidateId: c.id })).rejects.toMatchObject({ code: "invalid-target-config" });
		expect(readFileSync(join(dirname(agent), "config.toml"), "utf8")).toBe("broken = [");
	});

	it("distinguishes direct skills, disabled overrides, shadows and project trust", async () => {
		put(join(home, ".claude", "skills", "demo", "SKILL.md"), skill("demo"));
		let c = await candidate("skills", "demo");
		expect(c).toMatchObject({ holding: "reference", readiness: "ready", needsMigration: false });
		expect((await service.preview({ candidateId: c.id })).action).toBe("skip");
		put(join(dirname(agent), "config.toml"), 'skills=["!demo"]\n');
		c = await candidate("skills", "demo");
		expect(c.readiness).toBe("disabled");
		put(join(dirname(agent), "config.toml"), "");
		put(join(home, ".agents", "skills", "demo", "SKILL.md"), skill("demo"));
		c = await candidate("skills", "demo");
		expect(c.readiness).toBe("shadowed");
		put(join(project, ".claude", "skills", "local", "SKILL.md"), skill("local"));
		c = await candidate("skills", "local");
		expect(c.readiness).toBe("untrusted");
	});

	it("requires a new logical name and consent for an entire independent skill package", async () => {
		const source = join(home, ".claude", "skills", "demo");
		put(join(source, "SKILL.md"), skill("demo"));
		put(join(source, "references", "help.md"), "fixture reference");
		const c = await candidate("skills", "demo");
		const blocked = await service.preview({ candidateId: c.id, action: "copy" });
		expect(blocked.blockers.map((b) => b.code)).toContain("independent-copy-needs-new-name");
		const p = await service.preview({ candidateId: c.id, action: "copy", targetName: "demo-copy" });
		await expect(service.plan([{ previewId: p.id, acknowledged: [] }])).rejects.toMatchObject({
			code: "acknowledgement-required",
		});
		const job = await complete(p, ["independent-copy"]);
		expect(job.items[0]?.status).toBe("imported");
		expect(readFileSync(join(agent, "skills", "demo-copy", "references", "help.md"), "utf8")).toBe(
			"fixture reference",
		);
		expect(readFileSync(join(agent, "skills", "demo-copy", "SKILL.md"), "utf8")).toContain('"name": "demo-copy"');
		expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(skill("demo"));
	});

	it("rejects symlink payloads and never overwrites a skill directory", async () => {
		const source = join(home, ".codex", "skills", "demo");
		put(join(source, "SKILL.md"), skill("demo"));
		put(join(home, "private"), "private");
		symlinkSync(join(home, "private"), join(source, "linked"));
		const c = await candidate("skills", "demo");
		await expect(service.preview({ candidateId: c.id })).rejects.toMatchObject({ code: "unsafe-link" });
	});
});
