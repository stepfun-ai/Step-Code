import type { TranslateFn } from "../../i18n";
import type { ToolTimelineItem } from "../../state/types";

export type ToolKind = "read" | "write" | "edit" | "bash" | "search" | "list" | "other";

const KIND_BY_TOOL: Readonly<Record<string, ToolKind>> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	powershell: "bash",
	grep: "search",
	find: "search",
	ls: "list",
};

export function toolKind(item: Pick<ToolTimelineItem, "toolName">): ToolKind {
	return Object.hasOwn(KIND_BY_TOOL, item.toolName) ? KIND_BY_TOOL[item.toolName] : "other";
}

/** State comes from the host, never from output text or the whole turn's activity. */
export function toolLabel(item: Pick<ToolTimelineItem, "toolName" | "state">, t: TranslateFn): string {
	if (item.state === "unknown") return item.toolName || t("toolStatus.unknown");
	const kind = toolKind(item);
	const action = item.toolName === "find" ? "find" : kind;
	return t(`toolAction.${action}.${item.state}`, { name: item.toolName || t("approvalTool") });
}
