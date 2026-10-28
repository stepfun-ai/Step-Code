import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";
import { loadSkills } from "../src/core/skills.ts";
import { MigrationService } from "../src/step/migration/service.ts";
import type { MigrationPreview } from "../src/step/migration/types.ts";
import { discoverStepPluginResourcePaths } from "../src/step/plugins.ts";

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
function skill(name: string, body = "Fixture"): string {
	return `---\nname: ${name}\ndescription: Fixture\n---\n${body}`;
}
function create(): MigrationService {
	const value = new MigrationService({ agentDir: agent, env, sessions });
	services.push(value);
	return value;
}
async function complete(preview: MigrationPreview) {
	const plan = await service.plan([{ previewId: preview.id, acknowledged: preview.requiredAcknowledgements }]);
	const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: preview.id });
	await expect.poll(() => service.getJob(job.id).status).toBe("completed");
	const result = service.getJob(job.id);
	expect(result.items[0], JSON.stringify(result.items[0]?.diagnostics)).toMatchObject({ status: "imported" });
	return result;
}
async function source(kind: "skills" | "rules") {
	put(
		join(home, ".codex", kind === "skills" ? "skills/demo/SKILL.md" : "AGENTS.md"),
		kind === "skills" ? skill("demo") : "Imported rule",
	);
	return (await service.scan({ kinds: [kind], projectCwds: [] })).candidates.find((c) => c.source === "codex")!;
}
function projectPlugin(name = "demo"): string {
	const root = join(project, ".profile", "plugins", "fixture");
	put(join(root, "step.plugin.json"), JSON.stringify({ id: "fixture", skills: ["skills"] }));
	put(join(root, "skills", "different-directory", "SKILL.md"), skill(name, "Plugin fixture"));
	return root;
}
async function assertSourceIsolation(): Promise<void> {
	const scan = await service.scan({ kinds: ["skills", "rules"] });
	expect(scan.candidates.some((c) => c.sourceScope.kind === "project")).toBe(false);
	expect(scan.sources.some((s) => s.scope.kind === "project")).toBe(false);
	expect(JSON.stringify(scan)).not.toContain("private-source");
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "migration-target-")));
	agent = join(home, ".profile", "agent");
	project = join(home, "workspace", "target");
	mkdirSync(project, { recursive: true });
	env = { HOME: home, USERPROFILE: home, STEP_CODING_AGENT_DIR: agent, STEPCODE_CONFIG_DIR: ".profile" };
	put(join(agent, "trust.json"), JSON.stringify({ [project]: true }));
	put(join(project, ".codex", "skills", "private-source", "SKILL.md"), skill("private-source"));
	sessions = new SessionImportService({ agentDir: agent });
	service = create();
});
afterEach(async () => {
	await Promise.all(services.splice(0).map((s) => s.close()));
	await sessions.close();
	rmSync(home, { recursive: true, force: true });
});
describe("independently selected migration destinations", () => {
	it("blocks a destination-only project plugin identity but allows a unique renamed copy", async () => {
		const plugin = projectPlugin();
		const c = await source("skills");
		await assertSourceIsolation();
		const target = { kind: "project" as const, cwd: project };
		const p = await service.preview({ candidateId: c.id, target });
		expect(p.blockers).toContainEqual({ code: "skill-name-conflict" });
		const renamed = await service.preview({ candidateId: c.id, target, targetName: "imported-demo" });
		expect(renamed.blockers).toEqual([]);
		await complete(renamed);
		const resources = await discoverStepPluginResourcePaths({
			userDir: join(home, ".profile", "plugins"),
			projectDir: join(project, ".profile", "plugins"),
			projectTrusted: true,
		});
		const loaded = loadSkills({
			cwd: project,
			agentDir: agent,
			configDirName: ".profile",
			skillPaths: resources.skillPaths,
			includeDefaults: true,
		});
		expect(loaded.skills.find((s) => s.name === "demo")?.filePath).toBe(
			join(plugin, "skills", "different-directory", "SKILL.md"),
		);
		expect(loaded.skills.some((s) => s.name === "imported-demo")).toBe(true);
		await assertSourceIsolation();
	});
	describe.each(["plan", "start"] as const)("destination-only plugin consent at %s", (gate) => {
		it.each([
			"content",
			"manifest",
			"auxiliary",
			"ignore",
			"enabled",
			"trust",
			"config",
			"global-config",
			"installed",
			"installed-collision",
			"resource-added",
		])("invalidates reviewed %s changes before writes", async (change) => {
			const plugin = projectPlugin("other");
			if (change.startsWith("installed")) rmSync(plugin, { recursive: true });
			if (change === "resource-added") rmSync(join(plugin, "skills"), { recursive: true });
			const c = await source("skills");
			await assertSourceIsolation();
			const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
			expect(p.blockers).toEqual([]);
			const selections = [{ previewId: p.id, acknowledged: [] }];
			const plan = gate === "start" ? await service.plan(selections) : undefined;
			if (change === "content")
				put(join(plugin, "skills", "different-directory", "SKILL.md"), skill("other", "Changed without renaming"));
			if (change === "manifest")
				put(join(plugin, "step.plugin.json"), JSON.stringify({ id: "fixture", skills: ["skills"], version: "2" }));
			if (change === "auxiliary") put(join(plugin, "skills", "different-directory", "data.txt"), "Changed");
			if (change === "ignore") put(join(plugin, "skills", ".ignore"), "# changed\n");
			if (change === "enabled") put(join(project, ".profile", "config.toml"), 'skills=["!different-directory"]\n');
			if (change === "trust") put(join(agent, "trust.json"), JSON.stringify({ [project]: true, [home]: false }));
			if (change === "config") put(join(project, ".profile", "config.toml"), "# changed\n");
			if (change === "global-config") put(join(dirname(agent), "config.toml"), "# changed\n");
			if (change === "installed") projectPlugin("other");
			if (change === "installed-collision") projectPlugin("demo");
			if (change === "resource-added")
				put(join(plugin, "skills", "different-directory", "SKILL.md"), skill("other"));
			await expect(
				plan
					? service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: p.id })
					: service.plan(selections),
			).rejects.toMatchObject({ code: "preview-changed" });
			expect(existsSync(p.target.path)).toBe(false);
			await assertSourceIsolation();
		});
	});
	it.each(["ignore", "enabled", "empty-declaration"])(
		"does not collide with inactive destination-only plugin %s",
		async (control) => {
			const plugin = projectPlugin();
			if (control === "ignore") put(join(plugin, "skills", ".ignore"), "different-directory/\n");
			if (control === "enabled") put(join(project, ".profile", "config.toml"), 'skills=["!different-directory"]\n');
			if (control === "empty-declaration")
				put(join(plugin, "step.plugin.json"), JSON.stringify({ id: "fixture", skills: [] }));
			const c = await source("skills");
			const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
			expect(p.blockers).toEqual([]);
			await assertSourceIsolation();
		},
	);
	it.each(["compatible", "declared-file", "conventional"])(
		"detects destination-only plugin %s resources",
		async (format) => {
			const plugin = projectPlugin();
			if (format === "compatible") {
				rmSync(join(plugin, "step.plugin.json"));
				put(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
			}
			if (format === "declared-file")
				put(
					join(plugin, "step.plugin.json"),
					JSON.stringify({ id: "fixture", skills: ["skills/different-directory/SKILL.md"] }),
				);
			if (format === "conventional") put(join(plugin, "step.plugin.json"), JSON.stringify({ id: "fixture" }));
			const c = await source("skills");
			const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
			expect(p.blockers).toContainEqual({ code: "skill-name-conflict" });
			await assertSourceIsolation();
		},
	);
	it("rejects a logical name in another destination directory and allows a real rename", async () => {
		put(join(project, ".profile", "skills", "aaa", "SKILL.md"), skill("demo", "Existing"));
		const c = await source("skills");
		const target = { kind: "project" as const, cwd: project };
		const p = await service.preview({ candidateId: c.id, target });
		expect(p.blockers).toContainEqual({ code: "skill-name-conflict" });
		const renamed = await service.preview({ candidateId: c.id, target, targetName: "imported-demo" });
		expect(renamed.blockers).toEqual([]);
		await complete(renamed);
		const loaded = loadSkills({
			cwd: project,
			agentDir: agent,
			configDirName: ".profile",
			skillPaths: [],
			includeDefaults: true,
		});
		expect(loaded.skills.find((s) => s.name === "demo")?.filePath).toBe(
			join(project, ".profile", "skills", "aaa", "SKILL.md"),
		);
		expect(loaded.skills.some((s) => s.name === "imported-demo")).toBe(true);
		await assertSourceIsolation();
	});
	it("publishes multiple independent skills in one reviewed batch", async () => {
		await source("skills");
		put(join(home, ".codex", "skills", "second", "SKILL.md"), skill("second"));
		const candidates = (await service.scan({ kinds: ["skills"], projectCwds: [] })).candidates.filter(
			(c) => c.source === "codex",
		);
		const previews = await Promise.all(
			candidates.map((c) => service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } })),
		);
		const plan = await service.plan(previews.map((p) => ({ previewId: p.id, acknowledged: [] })));
		const job = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: plan.id });
		await expect.poll(() => service.getJob(job.id).status).toBe("completed");
		expect(service.getJob(job.id).items.map((item) => item.status)).toEqual(["imported", "imported"]);
	});
	it.each([".agents", ".claude", "global", "private"])(
		"detects effective %s skill shadows without source expansion",
		async (location) => {
			const root =
				location === "global"
					? join(home, ".agents")
					: location === "private"
						? agent
						: join(dirname(project), location);
			put(join(root, "skills", "aaa", "SKILL.md"), skill("demo", "Shadow"));
			const c = await source("skills");
			const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
			expect(p.blockers).toContainEqual({ code: "skill-name-conflict" });
			await assertSourceIsolation();
		},
	);
	it("does not treat an ignored destination name as an effective collision", async () => {
		put(join(project, ".profile", "skills", "aaa", "SKILL.md"), skill("demo"));
		put(join(project, ".profile", "skills", ".ignore"), "aaa/\n");
		const c = await source("skills");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		expect(p.blockers).toEqual([]);
		await complete(p);
	});
	it.each(["content", "ignore", "trust", "config", "boundary", "new-name"])(
		"invalidates a reviewed destination after %s changes",
		async (change) => {
			const root = join(project, ".profile", "skills");
			put(join(root, "aaa", "SKILL.md"), skill("other"));
			const c = await source("skills");
			const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
			const plan = await service.plan([{ previewId: p.id, acknowledged: [] }]);
			if (change === "content") put(join(root, "aaa", "SKILL.md"), skill("other", "Changed"));
			if (change === "ignore") put(join(root, ".ignore"), "# changed\n");
			if (change === "trust") put(join(agent, "trust.json"), JSON.stringify({ [project]: true, [home]: false }));
			if (change === "config") put(join(project, ".profile", "config.toml"), "# changed\n");
			if (change === "boundary") mkdirSync(join(project, ".git"));
			if (change === "new-name") put(join(root, "aaa", "SKILL.md"), skill("demo"));
			await expect(
				service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: p.id }),
			).rejects.toMatchObject({ code: "preview-changed" });
		},
	);
	it.each(["content", "replacement", "project", "missing", "symlink", "backup", "impact"])(
		"rejects changed recovery %s after service recreation",
		async (change) => {
			const path = join(project, "AGENTS.md");
			put(path, "Original rule");
			const c = await source("rules");
			const p = await service.preview({
				candidateId: c.id,
				target: { kind: "project", cwd: project },
				action: "append",
			});
			const job = await complete(p);
			await service.close();
			service = create();
			const recovery = service.previewRecovery(job.id, job.items[0]!.id);
			if (change === "content") put(path, "User edit");
			if (change === "replacement") {
				renameSync(path, `${path}.old`);
				put(path, recovery.currentText);
			}
			if (change === "project") {
				renameSync(project, `${project}-old`);
				mkdirSync(project);
				put(path, recovery.currentText);
			}
			if (change === "missing") rmSync(path);
			if (change === "symlink") {
				renameSync(path, `${path}.old`);
				symlinkSync(`${path}.old`, path);
			}
			if (change === "backup") put(join(agent, "migration", "backups", job.items[0]!.backupId!), "Changed backup");
			if (change === "impact") put(join(project, "AGENTS.override.md"), "Higher priority rule");
			const code =
				change === "project"
					? "invalid-projects"
					: change === "symlink"
						? "unsafe-link"
						: change === "impact"
							? "recovery-impact-changed"
							: "recovery-target-changed";
			expect(() => service.recover({ previewId: recovery.id, acknowledged: ["rules-impact"] })).toThrow(code);
			await assertSourceIsolation();
		},
	);
	it("invalidates consent before planning when a destination skill changes", async () => {
		const existing = join(project, ".profile", "skills", "aaa", "SKILL.md");
		put(existing, skill("other"));
		const c = await source("skills");
		const p = await service.preview({ candidateId: c.id, target: { kind: "project", cwd: project } });
		put(existing, skill("demo"));
		await expect(service.plan([{ previewId: p.id, acknowledged: [] }])).rejects.toMatchObject({
			code: "preview-changed",
		});
	});
	it.each(["replacement", "missing-identity"])(
		"rejects recovery preview for %s without repinning a project",
		async (change) => {
			put(join(project, "AGENTS.md"), "Original rule");
			const c = await source("rules");
			const p = await service.preview({
				candidateId: c.id,
				target: { kind: "project", cwd: project },
				action: "append",
			});
			const job = await complete(p);
			await service.close();
			if (change === "replacement") {
				renameSync(project, `${project}-old`);
				mkdirSync(project);
				put(join(project, "AGENTS.md"), p.resultText!);
			} else {
				const journalPath = join(agent, "migration", `${job.id}.json`);
				const journal = JSON.parse(readFileSync(journalPath, "utf8"));
				delete journal.projectIdentities;
				put(journalPath, JSON.stringify(journal));
			}
			service = create();
			expect(() => service.previewRecovery(job.id, job.items[0]!.id)).toThrow(
				change === "replacement" ? "invalid-projects" : "project-not-selected",
			);
			await assertSourceIsolation();
		},
	);
	it.each([false, true])("restores an independent rule target after recreated service=%s", async (restart) => {
		put(join(project, "AGENTS.md"), "Original rule");
		const c = await source("rules");
		const p = await service.preview({
			candidateId: c.id,
			target: { kind: "project", cwd: project },
			action: "append",
		});
		await expect(service.plan([{ previewId: p.id, acknowledged: [] }])).rejects.toMatchObject({
			code: "acknowledgement-required",
		});
		const job = await complete(p);
		if (restart) {
			await service.close();
			service = create();
		}
		const recovery = service.previewRecovery(job.id, job.items[0]!.id);
		expect(() => service.recover({ previewId: recovery.id, acknowledged: [] })).toThrow("acknowledgement-required");
		expect(service.recover({ previewId: recovery.id, acknowledged: ["rules-impact"] })).toEqual({ restored: true });
		expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("Original rule");
		await assertSourceIsolation();
	});
});
