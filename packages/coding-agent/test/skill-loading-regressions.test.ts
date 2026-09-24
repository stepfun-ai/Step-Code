import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../agent-core/src/harness/env/nodejs.ts";
import { loadSkills as loadCoreSkills } from "../../agent-core/src/harness/skills.ts";
import { createFileOps, extractFileOpsFromMessage, serializeConversation } from "../src/core/compaction/utils.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirs: string[] = [];
const harnesses: Harness[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "step-skill-discovery-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd };
}
function putSkill(dir: string, name = "audit-skill", body = "AUDIT_SKILL_BODY", prefix = "") {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, `${prefix}---\nname: ${name}\ndescription: Audit example\n---\n${body}\n`);
	return filePath;
}
function resourceLoader(cwd: string, agentDir: string) {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		configDirName: ".stepcode",
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
}
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("skill loading regressions", () => {
	it("ordinary skill discovery and project precedence work", async () => {
		const { cwd, agentDir } = fixture();
		putSkill(join(agentDir, "skills", "audit-skill"));
		const projectPath = putSkill(join(cwd, ".stepcode", "skills", "audit-skill"));
		const loader = resourceLoader(cwd, agentDir);
		await loader.reload();
		expect(loader.getSkills().skills.find((s) => s.name === "audit-skill")?.filePath).toBe(projectPath);
	});

	it("skill loading instruction must name a tool that the Step profile registers", () => {
		const { cwd, agentDir } = fixture();
		putSkill(join(agentDir, "skills", "audit-skill"));
		const { skills } = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" });
		const names = createStepToolProfile(cwd, { agentDir }).map((t) => t.name);
		const prompt = buildSystemPrompt({ cwd, skills, selectedTools: names });
		const instructedTool = prompt.match(/Use the (\S+) tool to load a skill's file/)?.[1];
		expect(names).toContain("read_file");
		expect(names).toContain(instructedTool);
	});

	it("directory symlink cycles must not load the same skill dozens of times", () => {
		const { agentDir } = fixture();
		const skillsDir = join(agentDir, "skills");
		putSkill(join(skillsDir, "z-skill"));
		symlinkSync(".", join(skillsDir, "loop"));
		const result = loadSkillsFromDir({ dir: skillsDir, source: "user" });
		expect(result.skills.filter((s) => s.name === "audit-skill")).toHaveLength(1);
	});

	it("nested gitignore basename patterns must apply to all descendants in that scope", async () => {
		const { root, cwd, agentDir } = fixture();
		execFileSync("git", ["init", "-q", root]);
		const group = join(agentDir, "skills", "group");
		const ignoredSkill = putSkill(join(group, "deeper", "audit-skill"));
		writeFileSync(join(group, ".gitignore"), "SKILL.md\n");
		// Independent reference for the expected ignore semantics.
		expect(
			execFileSync("git", ["-C", root, "check-ignore", "--no-index", ignoredSkill], { encoding: "utf8" }).trim(),
		).toBe(ignoredSkill);
		const loader = resourceLoader(cwd, agentDir);
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.filePath === ignoredSkill)).toBe(false);
	});

	it.each([" ", "\n", "\t", "\r\n"])(
		"explicit skill invocation accepts whitespace separator %j",
		async (separator) => {
			const { agentDir } = fixture();
			putSkill(join(agentDir, "skills", "audit-skill"));
			const result = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" });
			const harness = await createHarness({
				resourceLoader: {
					...createTestResourceLoader(),
					getSkills: () => result,
				},
			});
			harnesses.push(harness);
			let delivered = "";
			harness.setResponses([
				(ctx) => {
					const msg = ctx.messages.find((m) => m.role === "user");
					delivered = getMessageText(msg);
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt(`/skill:audit-skill${separator}apply this`);
			expect(delivered).toContain("AUDIT_SKILL_BODY");
			expect(delivered).toContain("apply this");
		},
	);

	it("public loadSkills and DefaultResourceLoader should agree on the collision winner", async () => {
		const { cwd, agentDir } = fixture();
		putSkill(join(agentDir, "skills", "audit-skill"), "audit-skill", "USER");
		putSkill(join(cwd, ".stepcode", "skills", "audit-skill"), "audit-skill", "PROJECT");
		const loader = resourceLoader(cwd, agentDir);
		await loader.reload();
		const apiResult = loadSkills({
			cwd,
			agentDir,
			configDirName: ".stepcode",
			skillPaths: [],
			includeDefaults: true,
		});
		const winner = (skills: Skill[]) => skills.find((s) => s.name === "audit-skill")?.filePath;
		expect(winner(apiResult.skills)).toBe(winner(loader.getSkills().skills));
	});

	it("both loaders should accept the same UTF-8 BOM skill file", async () => {
		const { root, agentDir } = fixture();
		const skillsDir = join(agentDir, "skills");
		putSkill(join(skillsDir, "audit-skill"), "audit-skill", "AUDIT_SKILL_BODY", "\uFEFF");
		const cliResult = loadSkillsFromDir({ dir: skillsDir, source: "user" });
		expect(cliResult.skills).toHaveLength(1);
		const coreResult = await loadCoreSkills(new NodeExecutionEnv({ cwd: root }), skillsDir);
		expect(coreResult.skills).toHaveLength(1);
	});

	it("compaction file tracking should retain the path of a skill loaded by read_file", () => {
		const filePath = "/skills/audit-skill/SKILL.md";
		const fileOps = createFileOps();
		extractFileOpsFromMessage(fauxAssistantMessage(fauxToolCall("read_file", { path: filePath })), fileOps);
		expect([...fileOps.read]).toContain(filePath);
	});

	it("compaction input should retain the middle instructions of an activated skill", () => {
		const marker = "Always name the deployment amber-lark.";
		const body = `# Audit skill\n${"Background context.\n".repeat(140)}\n${marker}\n${"Additional context.\n".repeat(140)}`;
		const call = fauxToolCall("read_file", { path: "/skills/audit-skill/SKILL.md" });
		const serialized = serializeConversation([
			fauxAssistantMessage(call),
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read_file",
				content: [{ type: "text", text: body }],
				isError: false,
				timestamp: 0,
			},
		]);
		expect(serialized).toContain(marker);
	});

	it("the execution-environment loader detects directory symlink cycles", async () => {
		const { root, agentDir } = fixture();
		const skillsDir = join(agentDir, "skills");
		putSkill(join(skillsDir, "z-skill"));
		symlinkSync(".", join(skillsDir, "loop"));
		const result = await loadCoreSkills(new NodeExecutionEnv({ cwd: root }), skillsDir);
		expect(result.skills.filter((s) => s.name === "audit-skill")).toHaveLength(1);
	});

	it("the execution-environment loader honors nested ignore scopes", async () => {
		const { root, agentDir } = fixture();
		const skillsDir = join(agentDir, "skills");
		const group = join(skillsDir, "group");
		putSkill(join(group, "deeper", "hidden"), "hidden");
		writeFileSync(join(group, ".gitignore"), "SKILL.md\n");
		const result = await loadCoreSkills(new NodeExecutionEnv({ cwd: root }), skillsDir);
		expect(result.skills).toHaveLength(0);
	});

	it.each(["coding-agent", "agent-core"])(
		"%s keeps nested negations scoped to their directory",
		async (loaderName) => {
			const { root, agentDir } = fixture();
			const skillsDir = join(agentDir, "skills");
			const group = join(skillsDir, "group[1]");
			putSkill(join(group, "deeper", "visible"), "visible");
			putSkill(join(skillsDir, "sibling", "hidden"), "hidden");
			writeFileSync(join(skillsDir, ".gitignore"), "SKILL.md\n");
			writeFileSync(join(group, ".gitignore"), "!SKILL.md\n");
			const result =
				loaderName === "coding-agent"
					? loadSkillsFromDir({ dir: skillsDir, source: "user" })
					: await loadCoreSkills(new NodeExecutionEnv({ cwd: root }), skillsDir);
			expect(result.skills.map((skill) => skill.name)).toEqual(["visible"]);
		},
	);
});
