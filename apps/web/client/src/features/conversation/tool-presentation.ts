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

/** Presentation-only grouping of historical tool names; execution names are never rewritten. */
const IMPORTED_KIND_BY_TOOL: Readonly<Record<string, ToolKind>> = {
	exec_command: "bash",
	shell: "bash",
	bash: "bash",
	run_terminal_cmd: "bash",
	read: "read",
	read_file: "read",
	cat: "read",
	write: "write",
	write_file: "write",
	apply_patch: "write",
	create_file: "write",
	edit: "edit",
	edit_file: "edit",
	str_replace_editor: "edit",
	search_replace: "edit",
	grep: "search",
	glob: "search",
	search_files: "search",
	codebase_search: "search",
	web_search: "search",
	ls: "list",
	list_dir: "list",
	list_directory: "list",
};

export function toolKind(item: Pick<ToolTimelineItem, "toolName" | "imported">): ToolKind {
	if (item.imported) {
		const name = item.toolName.toLowerCase();
		return Object.hasOwn(IMPORTED_KIND_BY_TOOL, name) ? IMPORTED_KIND_BY_TOOL[name] : "other";
	}
	return Object.hasOwn(KIND_BY_TOOL, item.toolName) ? KIND_BY_TOOL[item.toolName] : "other";
}

/** State comes from the host, never from output text or the whole turn's activity. */
export function toolLabel(item: Pick<ToolTimelineItem, "toolName" | "state" | "imported">, t: TranslateFn): string {
	if (item.state === "unknown") return item.toolName || t("toolStatus.unknown");
	const kind = toolKind(item);
	const action = item.toolName === "find" ? "find" : kind;
	return t(`toolAction.${action}.${item.state}`, { name: item.toolName || t("approvalTool") });
}
