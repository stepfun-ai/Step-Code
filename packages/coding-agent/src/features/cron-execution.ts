import { readFileSync } from "node:fs";
import type { Skill } from "../core/skills.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { renderLeadingSkillBlocks } from "../utils/skill-block.ts";
import type { CronJob } from "./step-cron.ts";

/** Schedule-write authorization for one host-admitted execution; never changes the model's tool catalog. */
export class CronExecutionScope {
	private active?: { sessionId: string; runId: string };

	/** Enter after idle admission. The host releases in finally after full settlement or cancellation. */
	begin(sessionId: string, runId: string): () => void {
		if (this.active) {
			throw new Error(
				`A scheduled execution is already active (session ${this.active.sessionId}, run ${this.active.runId})`,
			);
		}
		if (!sessionId.trim() || !runId.trim())
			throw new Error("Scheduled execution requires session and run identities");
		const active = { sessionId, runId };
		this.active = active;
		return () => {
			// A repeated cleanup must not lift the restriction on a newer execution.
			if (this.active === active) this.active = undefined;
		};
	}

	/** The execution gate is independent of prompt wording and the session's permission preset. */
	assertCanMutate(sessionId: string): void {
		if (this.active?.sessionId === sessionId) {
			throw new Error(
				"A scheduled execution cannot create, update, or delete scheduled tasks. Execute the current task instead.",
			);
		}
	}
}

/** An append-only assignment: saved task execution is not a request to create its schedule. */
export function renderCronExecution(
	job: Pick<CronJob, "id" | "cron" | "prompt" | "recurring" | "intervalHours" | "runAt" | "inputs">,
	runId: string,
	skills: readonly Skill[] = [],
): string {
	const entries = (job.inputs?.skills ?? []).flatMap((name) => {
		const skill = skills.find((candidate) => candidate.name === name);
		if (!skill) return [];
		try {
			return [
				{
					name: skill.name,
					location: skill.filePath,
					baseDir: skill.baseDir,
					body: stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim(),
				},
			];
		} catch {
			// A skill removed after discovery must not prevent the saved task from being delivered.
			return [];
		}
	});
	const schedule =
		!job.recurring && job.runAt !== undefined
			? `run-at-ms="${xml(String(job.runAt))}"`
			: job.intervalHours !== undefined
				? `interval-hours="${xml(String(job.intervalHours))}"`
				: `cron="${xml(job.cron)}"`;
	const assignment = [
		`<scheduled-task-execution task-id="${xml(job.id)}" run-id="${xml(runId)}" ${schedule} recurring="${job.recurring}">`,
		"This is one execution of an existing scheduled task, not a request to create a schedule. Execute the task below now and return its result.",
		"Do not create, update, or delete scheduled tasks during this execution; such changes are refused until it finishes. Scheduling and configured result delivery are handled by the host.",
		"XML entities in task and skill text denote literal characters; do not entity-encode the task's output.",
		"<task>",
		xml(job.prompt),
		"</task>",
		"</scheduled-task-execution>",
	].join("\n");
	// Leading skill blocks use the shared instruction-retention path, including multiple skills.
	const blocks = entries.length > 0 ? renderLeadingSkillBlocks(entries) : "";
	return blocks ? `${blocks}\n\n${assignment}` : assignment;
}

/** Text and double-quoted XML attributes share the same escaping. */
function xml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
