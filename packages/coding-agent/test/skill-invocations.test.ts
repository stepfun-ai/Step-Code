import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@step-harness/providers/compat";
import { fauxAssistantMessage } from "@step-harness/providers/compat";
import { afterEach, describe, expect, it } from "vitest";
import { collectSkillInstructions } from "../src/core/compaction/skill-instructions.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	MAX_SKILL_COMMANDS,
	messageSkillInvocations,
	renderSkillInstructions,
	skillInstructionBody,
	takeLeadingSkillCommands,
} from "../src/utils/skill-block.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

/** A skill file on disk plus the loader entry that advertises it. */
function skillFixture(directory: string, name: string, body: string) {
	const filePath = join(directory, `${name}.md`);
	writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}`);
	return {
		name,
		description: `${name} skill`,
		filePath,
		disableModelInvocation: false,
		baseDir: directory,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			origin: "top-level",
			baseDir: directory,
		}),
	};
}

describe("leading skill commands", () => {
	it("reads every leading command in order and leaves the request", () => {
		expect(takeLeadingSkillCommands("/skill:a /skill:b 做一个页面")).toEqual({
			names: ["a", "b"],
			duplicates: [],
			overflow: [],
			rest: "做一个页面",
		});
	});

	it("stops at the first word that is not a command", () => {
		expect(takeLeadingSkillCommands("/skill:a 先看 /skill:b 再看")).toEqual({
			names: ["a"],
			duplicates: [],
			overflow: [],
			rest: "先看 /skill:b 再看",
		});
	});

	it("loads a repeated command once and keeps the repeat as text", () => {
		expect(takeLeadingSkillCommands("/skill:a /skill:a task")).toEqual({
			names: ["a"],
			duplicates: ["a"],
			overflow: [],
			rest: "/skill:a task",
		});
	});

	it("caps the commands one message loads and keeps the rest as text", () => {
		const commands = Array.from({ length: MAX_SKILL_COMMANDS + 2 }, (_, index) => `/skill:s${index}`);
		const result = takeLeadingSkillCommands(`${commands.join(" ")} task`);
		expect(result.names).toEqual(commands.slice(0, MAX_SKILL_COMMANDS).map((_, index) => `s${index}`));
		expect(result.overflow).toEqual(["s5", "s6"]);
		expect(result.rest).toBe("/skill:s5 /skill:s6 task");
	});

	it("keeps the newline a declined command was written with", () => {
		expect(takeLeadingSkillCommands("/skill:a /skill:a\ntask")).toEqual({
			names: ["a"],
			duplicates: ["a"],
			overflow: [],
			rest: "/skill:a\ntask",
		});
	});

	it("leaves a message with no leading command untouched", () => {
		expect(takeLeadingSkillCommands("explain /skill:a")).toEqual({
			names: [],
			duplicates: [],
			overflow: [],
			rest: "explain /skill:a",
		});
	});
});

describe("rendering skill instructions", () => {
	const entry = { name: "a", location: "/skills/a.md", baseDir: "/skills", body: "BODY_A" };

	it("matches the single-skill wrapper recorded before spans existed", () => {
		expect(renderSkillInstructions([entry], "do it").text).toBe(
			'<skill name="a" location="/skills/a.md">\nReferences are relative to /skills.\n\nBODY_A\n</skill>\n\ndo it',
		);
	});

	it("records spans that slice each body out of the frozen text", () => {
		const second = { name: "b", location: "/skills/b.md", baseDir: "/skills", body: "BODY_B" };
		const rendered = renderSkillInstructions([entry, second], "do it");
		expect(rendered.text).toBe(
			'<skill name="a" location="/skills/a.md">\nReferences are relative to /skills.\n\nBODY_A\n</skill>\n\n' +
				'<skill name="b" location="/skills/b.md">\nReferences are relative to /skills.\n\nBODY_B\n</skill>\n\ndo it',
		);
		expect(rendered.skills.map((skill) => skill.name)).toEqual(["a", "b"]);
		// A span reads exactly like the content a legacy block parse returns.
		expect(rendered.skills.map((skill) => skillInstructionBody(rendered.text, skill))).toEqual([
			"References are relative to /skills.\n\nBODY_A",
			"References are relative to /skills.\n\nBODY_B",
		]);
		expect(messageSkillInvocations(rendered.text, rendered.skills)?.request).toBe("do it");
	});

	it("keeps the body byte-identical, including markup the wrapper would otherwise close", () => {
		const body = "Use `<skill>` and </skill> and & inside code.";
		const rendered = renderSkillInstructions([{ ...entry, body }], "");
		expect(rendered.text).toContain(body);
		// Nothing after the body can truncate the recorded span.
		const content = skillInstructionBody(rendered.text, rendered.skills[0]!);
		expect(content.endsWith(body)).toBe(true);
		expect(rendered.skills[0]!.digest).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
	});

	it("keeps a request that itself contains the closing marker", () => {
		const request = "explain when </skill> is written by hand";
		const rendered = renderSkillInstructions([entry], request);
		expect(messageSkillInvocations(rendered.text, rendered.skills)?.request).toBe(request);
	});

	it("passes a recorded message with spans to the transcript without re-parsing", () => {
		const rendered = renderSkillInstructions([entry], "do it");
		expect(messageSkillInvocations(rendered.text, rendered.skills)).toEqual({
			skills: [{ name: "a", content: "References are relative to /skills.\n\nBODY_A" }],
			request: "do it",
		});
	});

	it("reads a message recorded before spans existed exactly like one with spans", () => {
		const legacy =
			'<skill name="a" location="/skills/a.md">\nReferences are relative to /skills.\n\nBODY_A\n</skill>\n\ndo it';
		const rendered = renderSkillInstructions([entry], "do it");
		expect(messageSkillInvocations(legacy)).toEqual(messageSkillInvocations(rendered.text, rendered.skills));
	});
});

describe("recorded skill invocations", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const directory = tempDirs.pop();
			if (directory) rmSync(directory, { recursive: true, force: true });
		}
	});

	async function harnessWithSkills(names: readonly string[]) {
		const directory = join(tmpdir(), `skill-invocations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		tempDirs.push(directory);
		const skills = names.map((name) => skillFixture(directory, name, `BODY_${name.toUpperCase()}`));
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills, diagnostics: [] }) },
		});
		harnesses.push(harness);
		return harness;
	}

	it("loads every skill the prompt names, in order, before the request", async () => {
		const harness = await harnessWithSkills(["alpha", "beta"]);
		let sent = "";
		harness.setResponses([
			(context) => {
				sent = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:alpha /skill:beta 做一个页面");

		const alphaAt = sent.indexOf("BODY_ALPHA");
		const betaAt = sent.indexOf("BODY_BETA");
		expect(alphaAt).toBeGreaterThan(-1);
		expect(betaAt).toBeGreaterThan(alphaAt);
		expect(sent.trimEnd().endsWith("做一个页面")).toBe(true);
		expect(sent).not.toContain("/skill:beta");
	});

	it("records spans that locate each body in the message it recorded", async () => {
		const harness = await harnessWithSkills(["alpha", "beta"]);

		await harness.session.prompt("/skill:alpha /skill:beta 做一个页面");

		const recorded = harness.session.messages.find((message) => message.role === "user") as UserMessage;
		const text = getMessageText(recorded);
		expect(recorded.skills?.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
		expect(recorded.skills?.map((skill) => skillInstructionBody(text, skill).split("\n").pop())).toEqual([
			"BODY_ALPHA",
			"BODY_BETA",
		]);
		// The recorded text is the model-visible text, not the typed command.
		expect(text).toContain("BODY_ALPHA");
		expect(messageSkillInvocations(text, recorded.skills)?.request).toBe("做一个页面");
	});

	it("keeps a skill whose file is missing in the request instead of dropping it", async () => {
		const harness = await harnessWithSkills(["alpha"]);
		let sent = "";
		harness.setResponses([
			(context) => {
				sent = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:missing /skill:alpha 做一个页面");

		expect(sent).toContain("BODY_ALPHA");
		expect(sent).toContain("/skill:missing");
		expect(sent.trimEnd().endsWith("做一个页面")).toBe(true);
	});

	it("leaves a recorded message from before spans existed byte-identical for the model", () => {
		const legacy: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "BODY_A\n\ndo it" }],
			timestamp: 1,
		};
		const converted = convertToLlm([legacy]);
		// Same object: nothing re-renders or rewrites a recorded turn.
		expect(converted[0]).toBe(legacy);
	});

	it("projects a recorded message with spans without rewriting its text", () => {
		const text =
			'<skill name="a" location="/skills/a.md">\nReferences are relative to /skills.\n\nBODY_A\n</skill>\n\ndo it';
		const start = text.indexOf("References");
		const recorded: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			skills: [{ name: "a", location: "/skills/a.md", start, end: text.indexOf("\n</skill>"), digest: "digest" }],
			timestamp: 1,
		};
		const converted = convertToLlm([recorded]);
		// Spans stay available to transcript readers and compaction; adapters build
		// request parameters from role and content only.
		expect(converted[0]).toBe(recorded);
		expect(getMessageText(converted[0])).toBe(text);
	});

	it("expands every skill a forwarding command hands to the model", async () => {
		// `/plan <task>` forwards the task through sendUserMessage with prompt
		// expansion (see step-plan.ts), so a task that names several skills must
		// load them there too, not only when typed at the top level.
		const directory = join(tmpdir(), `skill-forward-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		tempDirs.push(directory);
		const skills = ["alpha", "beta"].map((name) => skillFixture(directory, name, `BODY_${name.toUpperCase()}`));
		const harness = await createHarness({
			resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills, diagnostics: [] }) },
		});
		harnesses.push(harness);
		let sent = "";
		harness.setResponses([
			(context) => {
				sent = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.sendUserMessage("/skill:alpha /skill:beta 做一个页面", { expandPromptTemplates: true });
		await harness.session.waitForIdle();

		expect(sent).toContain("BODY_ALPHA");
		expect(sent).toContain("BODY_BETA");
		expect(sent.trimEnd().endsWith("做一个页面")).toBe(true);
	});

	it("keeps the request byte-identical after the session is reloaded from disk", async () => {
		const directory = join(tmpdir(), `skill-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		tempDirs.push(directory);
		const skills = ["alpha", "beta"].map((name) => skillFixture(directory, name, `BODY_${name.toUpperCase()}`));
		const harness = await createHarness({
			sessionPersistence: true,
			resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills, diagnostics: [] }) },
		});
		harnesses.push(harness);
		let firstRequest = "";
		harness.setResponses([
			(context) => {
				firstRequest = getMessageText(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("/skill:alpha /skill:beta 做一个页面");

		const sessionFile = harness.session.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		// Reopen from disk, exactly as resuming does: the request must be the same
		// bytes, so every earlier turn still matches its provider cache prefix.
		const reopened = SessionManager.open(sessionFile!);
		const reloaded = convertToLlm(reopened.buildSessionContext().messages);
		expect(getMessageText(reloaded.find((message) => message.role === "user"))).toBe(firstRequest);
	});

	it("reads a session recorded before spans existed byte-identically", () => {
		const directory = join(tmpdir(), `skill-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		tempDirs.push(directory);
		const file = join(directory, "2020-01-01T00-00-00-000Z_legacy01.jsonl");
		const legacyText =
			'<skill name="old" location="/skills/old/SKILL.md">\nReferences are relative to /skills/old.\n\nOLD BODY\n</skill>\n\n做一个下载器';
		const entries = [
			{ type: "session", version: 3, id: "legacy01", timestamp: "2020-01-01T00:00:00.000Z", cwd: directory },
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: "2020-01-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: legacyText }], timestamp: 1 },
			},
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const reopened = SessionManager.open(file);
		const messages = convertToLlm(reopened.buildSessionContext().messages);
		expect(getMessageText(messages.find((message) => message.role === "user"))).toBe(legacyText);
	});

	it("keeps both skills through compaction", async () => {
		const harness = await harnessWithSkills(["alpha", "beta"]);

		await harness.session.prompt("/skill:alpha /skill:beta 做一个页面");

		const recorded = harness.session.messages.find((message) => message.role === "user") as UserMessage;
		const instructions = collectSkillInstructions(convertToLlm([recorded]));
		expect(instructions.map((instruction) => instruction.content.split("\n").pop())).toEqual([
			"BODY_ALPHA",
			"BODY_BETA",
		]);
	});
});
