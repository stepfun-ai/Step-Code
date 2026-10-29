import type { SubagentLaneSnapshot } from "@step-harness/coding-agent";

/** Presentation cache only: the kernel owns execution and durable outcomes. */
export function retainSubagentLane(
	cache: Map<string, SubagentLaneSnapshot>,
	lane: SubagentLaneSnapshot,
	finishedLimit = 16,
): void {
	cache.set(lane.laneId, lane);
	const finished = [...cache.values()]
		.filter((item) => item.status !== "running")
		.sort((left, right) => (left.details.updatedAt ?? 0) - (right.details.updatedAt ?? 0));
	for (const item of finished.slice(0, Math.max(0, finished.length - finishedLimit))) cache.delete(item.laneId);
}
