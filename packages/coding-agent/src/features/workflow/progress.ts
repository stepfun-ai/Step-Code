import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createWorkflowRunPaths, resolveWorkflowRoot, writeWorkflowFileAtomic } from "./journal.ts";
import { isWorkflowPathInside } from "./tool-profile.ts";
import type { WorkflowProgress, WorkflowProgressAgent } from "./types.ts";

/** Small persistence adapter for the live progress projection. */
export class WorkflowProgressStore {
	private readonly path: string;
	private readonly now: () => number;
	private state: WorkflowProgress;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(progressPath: string, initial: WorkflowProgress, now: () => number = Date.now) {
		this.path = path.resolve(progressPath);
		this.now = now;
		this.state = { ...initial, agents: [...initial.agents] };
	}

	current(): WorkflowProgress {
		return { ...this.state, agents: this.state.agents.map((agent) => ({ ...agent })) };
	}

	async update(patch: Partial<WorkflowProgress> & { agent?: WorkflowProgressAgent }): Promise<WorkflowProgress> {
		const nextAgents = patch.agent
			? upsertAgent(this.state.agents, patch.agent)
			: this.state.agents.map((agent) => ({ ...agent }));
		const { agent: _agent, ...rest } = patch;
		this.state = {
			...this.state,
			...rest,
			agents: nextAgents,
			updatedAt: this.now(),
			completedAgents: nextAgents.filter((agent) => agent.status === "completed" || agent.status === "cached")
				.length,
			totalAgents: Math.max(this.state.totalAgents, nextAgents.length),
		};
		// Each caller observes its own immutable transition, even when later
		// updates arrive while this snapshot is waiting for its disk write.
		const snapshot = this.current();
		const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
		this.writeQueue = this.writeQueue.then(() => writeWorkflowFileAtomic(this.path, serialized));
		await this.writeQueue;
		return snapshot;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}
}

function upsertAgent(agents: readonly WorkflowProgressAgent[], agent: WorkflowProgressAgent): WorkflowProgressAgent[] {
	const next = agents.map((candidate) => (candidate.id === agent.id ? { ...candidate, ...agent } : { ...candidate }));
	if (!next.some((candidate) => candidate.id === agent.id)) next.push({ ...agent });
	return next;
}

export interface WorkflowRunSummary {
	runId: string;
	path: string;
	progress?: WorkflowProgress;
	modifiedAt?: number;
}

export async function listWorkflowRuns(cwd: string): Promise<WorkflowRunSummary[]> {
	const runsRoot = path.join(resolveWorkflowRoot(cwd), "runs");
	if (!isWorkflowPathInside(cwd, runsRoot)) return [];
	let entries: Dirent[];
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const summaries: WorkflowRunSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runId = entry.name;
		let paths: ReturnType<typeof createWorkflowRunPaths>;
		try {
			paths = createWorkflowRunPaths(cwd, runId);
		} catch {
			// Ignore directories that do not use the workflow run-id format.
			continue;
		}
		const runPath = paths.runDir;
		let progress: WorkflowProgress | undefined;
		try {
			if (isWorkflowPathInside(cwd, paths.progressPath)) {
				progress = JSON.parse(await readFile(paths.progressPath, "utf8")) as WorkflowProgress;
			}
		} catch {
			// A run may be visible before its first progress write.
		}
		let modifiedAt: number | undefined;
		try {
			modifiedAt = (await stat(runPath)).mtimeMs;
		} catch {
			// Best effort only.
		}
		summaries.push({
			runId,
			path: runPath,
			...(progress ? { progress } : {}),
			...(modifiedAt ? { modifiedAt } : {}),
		});
	}
	return summaries.sort(
		(left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0) || left.runId.localeCompare(right.runId),
	);
}

export async function listSavedWorkflows(cwd: string, homeRoot?: string): Promise<string[]> {
	const projectSaved = path.join(path.resolve(cwd), ".stepcode", "workflows", "saved");
	const candidates = [
		...(isWorkflowPathInside(cwd, projectSaved) ? [projectSaved] : []),
		...(homeRoot ? [path.join(path.resolve(homeRoot), "workflows", "saved")] : []),
	];
	const names = new Set<string>();
	for (const directory of candidates) {
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".js")) names.add(entry.name.slice(0, -3));
			}
		} catch {
			// Missing saved-workflow directories are normal.
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

export function formatWorkflowStatus(runs: readonly WorkflowRunSummary[], saved: readonly string[]): string {
	const lines: string[] = [];
	if (saved.length > 0) lines.push(`Saved workflows: ${saved.join(", ")}`);
	else lines.push("Saved workflows: none");
	if (runs.length === 0) lines.push("Runs: none");
	else {
		lines.push("Runs:");
		for (const run of runs.slice(0, 20)) {
			const state = run.progress
				? `${run.progress.status}, ${run.progress.completedAgents}/${run.progress.totalAgents} agents`
				: "starting";
			lines.push(`- ${run.runId}: ${state}`);
		}
	}
	lines.push("");
	lines.push(
		'Usage: prefix a message with "ultraloop:" (or "ultracode:") to opt in for one turn, or run /ultraloop on for the whole session.',
	);
	return lines.join("\n");
}
