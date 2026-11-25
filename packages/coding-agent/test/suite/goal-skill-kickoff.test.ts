import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@step-harness/providers/compat";
import { afterEach, describe, expect, it } from "vitest";
import { readSavedSkillInstructions } from "../../src/core/compaction/skill-instructions.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createStepGoalExtension } from "../../src/features/step-schedule.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * A goal objective may name skills the way a prompt does. The kickoff turn loads
 * them, and every later round continues without injecting a second copy: the
 * instructions are already in the transcript, which is also what compaction
 * keeps. Loading them again each round would grow the context by a full body per
 * round and re-bill it.
 */
describe("/goal with skill commands", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) {
			const dir = dirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function skillFile(directory: string, name: string) {
		const filePath = join(directory, `${name}.md`);
		writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\nBODY_${name.toUpperCase()}\n`);
		return {
			name,
			description: name,
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

	async function goalHarness() {
		const directory = join(tmpdir(), `goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		dirs.push(directory);
		const skills = ["alpha", "beta"].map((name) => skillFile(directory, name));
		// A custom loader must carry the extensions result itself, or the session
		// never sees the goal command.
		const extensionsResult = await createTestExtensionsResult(
			[createStepGoalExtension({ enabled: true })],
			directory,
		);
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSkills: () => ({ skills, diagnostics: [] }),
			},
		});
		harnesses.push(harness);
		return harness;
	}

	const goalRounds = (harness: Harness) =>
		harness.session.messages
			.filter((message) => (message as { customType?: string }).customType === "step-goal")
			.map((message) => ({
				iteration: (message as { details?: { iteration?: number } }).details?.iteration,
				text: getMessageText(message),
			}));

	it("loads the objective's skills on the kickoff and not again on later rounds", async () => {
		const harness = await goalHarness();
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("working")));

		await harness.session.prompt("/goal /skill:alpha /skill:beta 做一个页面");
		await harness.session.waitForIdle();

		const rounds = goalRounds(harness);
		expect(rounds.length).toBeGreaterThan(1);
		const [kickoff, ...later] = rounds;
		expect(kickoff?.iteration).toBe(0);
		expect(kickoff?.text.startsWith('<skill name="alpha"')).toBe(true);
		expect(kickoff?.text).toContain("BODY_ALPHA");
		expect(kickoff?.text).toContain("BODY_BETA");
		// The objective keeps the text the user wrote.
		expect(kickoff?.text).toContain("/skill:alpha /skill:beta 做一个页面");
		for (const round of later) expect(round.text).not.toContain("<skill name=");
	});

	it("keeps both bodies through compaction", async () => {
		const harness = await goalHarness();
		harness.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage("working")));

		await harness.session.prompt("/goal /skill:alpha /skill:beta 做一个页面");
		await harness.session.waitForIdle();

		harness.setResponses([
			fauxAssistantMessage("Summary without skill instructions"),
			fauxAssistantMessage("Turn summary without skill instructions"),
		]);
		const result = await harness.session.compact();

		expect(readSavedSkillInstructions(result.details).map((skill) => skill.content.split("\n").pop())).toEqual([
			"BODY_ALPHA",
			"BODY_BETA",
		]);
	});
});
