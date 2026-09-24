import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function makeHarness(paths: string[] = []) {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		resourceLoader: {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: paths.map((filePath, index) => ({
					name: `skill-${index}`,
					description: "Skill instructions",
					filePath,
					baseDir: dirname(filePath),
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
					disableModelInvocation: false,
				})),
				diagnostics: [],
			}),
		},
	});
	harnesses.push(harness);
	return harness;
}

function readSkill(
	path: string,
	body: string,
	range: Record<string, number> = {},
	isError = false,
	callId?: string,
): Message[] {
	const call = fauxToolCall("read_file", { path, ...range });
	if (callId) call.id = callId;
	return [
		fauxAssistantMessage(call),
		{
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read_file",
			content: [{ type: "text", text: body }],
			isError,
			timestamp: Date.now(),
		},
	];
}

function seed(harness: Harness, messages: Message[]): void {
	for (const message of [
		{ role: "user" as const, content: "Use the relevant skills", timestamp: Date.now() },
		...messages,
		fauxAssistantMessage("The instructions are loaded."),
		{ role: "user" as const, content: "Continue with the current task", timestamp: Date.now() },
		fauxAssistantMessage("Current progress."),
	])
		harness.sessionManager.appendMessage(message);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function summarizeWithoutSkills(harness: Harness): void {
	harness.setResponses([
		fauxAssistantMessage("Brief task handoff that omits the loaded instructions."),
		fauxAssistantMessage("Current turn handoff that also omits the loaded instructions."),
	]);
}

describe("skill instructions across compaction", () => {
	it("retains complete loaded instructions even when the generated summary omits them", async () => {
		const harness = await makeHarness();
		const marker = "Always use the amber-lark deployment name.";
		const body = `${"Background.\n".repeat(180)}${marker}\n${"More context.\n".repeat(180)}`;
		seed(harness, readSkill("/skills/deploy/SKILL.md", body));
		summarizeWithoutSkills(harness);

		const result = await harness.session.compact();
		expect(result.summary).toContain(body);
		expect(result.summary).toContain("/skills/deploy/SKILL.md");

		const restored = buildSessionContext(JSON.parse(JSON.stringify(harness.sessionManager.getEntries())));
		const summary = restored.messages.find((message) => message.role === "compactionSummary");
		expect(summary?.role === "compactionSummary" && summary.summary).toContain(marker);
	});

	it("retains activated instructions through consecutive compactions without duplicating them", async () => {
		const harness = await makeHarness();
		const marker = "Persist this exact skill instruction.";
		seed(harness, readSkill("/skills/deploy/SKILL.md", marker));
		summarizeWithoutSkills(harness);
		await harness.session.compact();

		seed(harness, [fauxAssistantMessage("Some later work.")]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary.split(marker)).toHaveLength(2);
	});

	it("recognizes configured single-file skills and does not load inactive skills", async () => {
		const active = "/configured/review.md";
		const inactive = "/configured/unread.md";
		const harness = await makeHarness([active, inactive]);
		seed(harness, readSkill(active, "Follow this review procedure."));
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary).toContain("Follow this review procedure.");
		expect(result.summary).not.toContain(inactive);
	});

	it("retains slash-invoked instructions without retaining their one-time arguments", async () => {
		const harness = await makeHarness();
		seed(harness, [
			{
				role: "user",
				timestamp: Date.now(),
				content:
					'<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nUse the review checklist.\n</skill>\n\nONE_TIME_ARGUMENT',
			},
		]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary).toContain("Use the review checklist.");
		expect(result.summary).not.toContain("ONE_TIME_ARGUMENT");
	});

	it("keeps distinct read ranges and deduplicates repeated reads of a range", async () => {
		const harness = await makeHarness();
		const path = "/skills/review/SKILL.md";
		seed(harness, [
			...readSkill(path, "FIRST_PART_INSTRUCTIONS", { start_line: 1, end_line: 40 }),
			...readSkill(path, "SECOND_PART_INSTRUCTIONS", { start_line: 41, end_line: 80 }),
			...readSkill(path, "SECOND_PART_INSTRUCTIONS", { start_line: 41, end_line: 80 }),
		]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary.split("FIRST_PART_INSTRUCTIONS")).toHaveLength(2);
		expect(result.summary.split("SECOND_PART_INSTRUCTIONS")).toHaveLength(2);
	});

	it("replaces stale instructions when the full skill is read again", async () => {
		const harness = await makeHarness();
		const path = "/skills/review/SKILL.md";
		seed(harness, [...readSkill(path, "OUTDATED_INSTRUCTIONS"), ...readSkill(path, "CURRENT_INSTRUCTIONS")]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary).toContain("CURRENT_INSTRUCTIONS");
		expect(result.summary).not.toContain("OUTDATED_INSTRUCTIONS");
	});

	it("does not retain failed reads or ordinary file contents as skill instructions", async () => {
		const harness = await makeHarness();
		seed(harness, [
			...readSkill("/skills/review/SKILL.md", "READ_FAILURE_OUTPUT", {}, true),
			...readSkill("/project/README.md", "ORDINARY_FILE_CONTENT"),
		]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary).not.toContain("READ_FAILURE_OUTPUT");
		expect(result.summary).not.toContain("ORDINARY_FILE_CONTENT");
	});

	it("correlates reused tool-call IDs with the preceding call", async () => {
		const harness = await makeHarness();
		seed(harness, [
			...readSkill("/skills/first/SKILL.md", "FIRST_SKILL_RULE", {}, false, "reused"),
			...readSkill("/project/README.md", "ORDINARY_README", {}, false, "reused"),
			...readSkill("/skills/second/SKILL.md", "SECOND_SKILL_RULE", {}, false, "reused"),
		]);
		summarizeWithoutSkills(harness);
		const result = await harness.session.compact();
		expect(result.summary).toContain("FIRST_SKILL_RULE");
		expect(result.summary).toContain("SECOND_SKILL_RULE");
		expect(result.summary).not.toContain("ORDINARY_README");
	});
});
