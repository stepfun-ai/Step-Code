import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const READ_ONLY_TOOLS = ["read_file", "search_files", "find_files", "list_directory", "find_tools"];
const DEVELOPER_TOOLS = [...READ_ONLY_TOOLS, "write_file", "edit_file", "run_command"];

export const WORKFLOW_TOOL_PROFILES: Readonly<Record<string, readonly string[]>> = {
	planner: [...READ_ONLY_TOOLS, "clarify_user"],
	developer: DEVELOPER_TOOLS,
	qa: [...READ_ONLY_TOOLS, "run_command"],
	"hoh-planner": [...READ_ONLY_TOOLS, "clarify_user"],
	"hoh-developer": DEVELOPER_TOOLS,
	"hoh-qa": [...READ_ONLY_TOOLS, "run_command"],
};

export function resolveWorkflowToolProfile(profile: string | readonly string[] | undefined): string[] | undefined {
	if (profile === undefined) return undefined;
	const normalized = typeof profile === "string" ? profile.trim() : profile;
	if (normalized === "*") return undefined;
	const values = typeof normalized === "string" ? WORKFLOW_TOOL_PROFILES[normalized] : normalized;
	if (!values) throw new Error(`Unknown workflow tool profile "${String(profile)}"`);
	if (values.includes("*")) return undefined;
	const result = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
	if (result.length === 0) throw new Error("Workflow tool profile cannot be empty");
	return result;
}

export interface WorkflowAcl {
	readonly readOnly?: readonly string[];
	readonly writable?: readonly string[];
}

export type WorkflowPathOperation = "read" | "write" | "execute";

export interface WorkflowAclDecision {
	readonly allowed: boolean;
	readonly operation: WorkflowPathOperation;
	readonly target?: string;
	readonly reason?: string;
}

/** Canonicalize a path while resolving symlinks in its existing ancestor. */
export function canonicalWorkflowPath(cwd: string, target: string): string {
	const absolute = path.resolve(cwd, target);
	let cursor = absolute;
	const missing: string[] = [];
	while (!existsSync(cursor)) {
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		missing.push(path.basename(cursor));
		cursor = parent;
	}
	let canonicalBase: string;
	try {
		canonicalBase = realpathSync.native(cursor);
	} catch {
		canonicalBase = path.resolve(cursor);
	}
	for (let index = missing.length - 1; index >= 0; index -= 1) {
		canonicalBase = path.join(canonicalBase, missing[index] ?? "");
	}
	return path.normalize(canonicalBase);
}

function isWithin(candidate: string, root: string): boolean {
	const normalizedCandidate = path.normalize(candidate);
	const normalizedRoot = path.normalize(root);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function isWorkflowPathInside(cwd: string, target: string): boolean {
	return isWithin(canonicalWorkflowPath(cwd, target), canonicalWorkflowPath(cwd, cwd));
}

function canonicalRoots(cwd: string, roots: readonly string[] | undefined): string[] {
	return (roots ?? []).map((root) => canonicalWorkflowPath(cwd, root));
}

export function checkWorkflowPathAccess(
	cwd: string,
	target: string,
	operation: WorkflowPathOperation,
	acl: WorkflowAcl,
): WorkflowAclDecision {
	const normalizedTarget = target.trim();
	if (!normalizedTarget)
		return { allowed: false, operation, reason: "Workflow tool call did not provide a target path" };
	const canonicalTarget = canonicalWorkflowPath(cwd, normalizedTarget);
	const readOnlyRoots = canonicalRoots(cwd, acl.readOnly);
	const writableRoots = canonicalRoots(cwd, acl.writable);
	const constrained = readOnlyRoots.length + writableRoots.length > 0;
	if (
		operation === "read" &&
		constrained &&
		![...readOnlyRoots, ...writableRoots].some((root) => isWithin(canonicalTarget, root))
	) {
		return {
			allowed: false,
			operation,
			target: canonicalTarget,
			reason: `Workflow ACL blocked read access: target is outside configured mounts (${[
				...(acl.readOnly ?? []),
				...(acl.writable ?? []),
			].join(", ")})`,
		};
	}
	if (operation !== "read" && readOnlyRoots.some((root) => isWithin(canonicalTarget, root))) {
		return {
			allowed: false,
			operation,
			target: canonicalTarget,
			reason: `Workflow ACL blocked ${operation} access: target is under readOnly mount ${normalizedTarget}`,
		};
	}
	if (
		(operation === "write" || operation === "execute") &&
		constrained &&
		!writableRoots.some((root) => isWithin(canonicalTarget, root))
	) {
		return {
			allowed: false,
			operation,
			target: canonicalTarget,
			reason: `Workflow ACL blocked ${operation} access: target is outside writable mounts (${(acl.writable ?? []).join(", ")})`,
		};
	}
	return { allowed: true, operation, target: canonicalTarget };
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "write", "edit"]);
const READ_TOOL_NAMES = new Set(["read_file", "find_files", "search_files", "list_directory", "read"]);
const EXECUTE_TOOL_NAMES = new Set(["run_command", "bash", "powershell"]);
const NON_FILESYSTEM_TOOL_NAMES = new Set(["clarify_user", "find_tools"]);

/**
 * Inspect a child tool call before it crosses the workflow ACL boundary.
 * Shell parsing is intentionally conservative: direct paths and common
 * redirection/copy commands are checked, while the child still remains
 * responsible for normal command validation.
 */
export function checkWorkflowToolCall(
	cwd: string,
	toolName: string,
	input: unknown,
	acl: WorkflowAcl,
): WorkflowAclDecision {
	const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	if (NON_FILESYSTEM_TOOL_NAMES.has(toolName)) return { allowed: true, operation: "read" };
	if (READ_TOOL_NAMES.has(toolName)) {
		const target = ["path", "filePath", "directory", "cwd"]
			.map((key) => value[key])
			.find((item): item is string => typeof item === "string");
		return checkWorkflowPathAccess(cwd, target ?? ".", "read", acl);
	}
	if (WRITE_TOOL_NAMES.has(toolName)) {
		const target = ["path", "filePath", "target", "filename"]
			.map((key) => value[key])
			.find((item) => typeof item === "string");
		return checkWorkflowPathAccess(cwd, typeof target === "string" ? target : "", "write", acl);
	}
	if (EXECUTE_TOOL_NAMES.has(toolName)) {
		const commandCwd = typeof value.cwd === "string" ? value.cwd : ".";
		const cwdDecision = checkWorkflowPathAccess(cwd, commandCwd, "read", acl);
		if (!cwdDecision.allowed) return cwdDecision;
		const commandBase = path.resolve(cwd, commandCwd);
		const command =
			typeof value.command === "string" ? value.command : typeof value.cmd === "string" ? value.cmd : "";
		for (const target of commandWriteTargets(command)) {
			const decision = checkWorkflowPathAccess(commandBase, target, "execute", acl);
			if (!decision.allowed) return decision;
		}
		return { allowed: true, operation: "execute" };
	}
	if ((acl.readOnly?.length ?? 0) + (acl.writable?.length ?? 0) === 0) {
		return { allowed: true, operation: "read" };
	}
	return {
		allowed: false,
		operation: "execute",
		reason: `Workflow ACL blocked unclassified tool "${toolName}"`,
	};
}

function commandWriteTargets(command: string): string[] {
	if (!command.trim()) return [];
	const targets: string[] = [];
	const redirectPattern = /(?:^|[\s|;&])(?:\d*|&)>{1,2}\s*(?:'([^']*)'|"([^"]*)"|([^\s|;&]+))/gu;
	for (const match of command.matchAll(redirectPattern)) {
		const target = match[1] ?? match[2] ?? match[3];
		if (target) targets.push(target);
	}
	for (const match of command.matchAll(/\b(?:mv|cp)\b\s+[^|;&]*?\s+([^\s|;&]+)(?:\s|$)/gu)) {
		if (match[1]) targets.push(stripShellQuotes(match[1]));
	}
	for (const match of command.matchAll(/\btee\b(?:\s+-\S+)*\s+([^\s|;&]+)/gu)) {
		if (match[1]) targets.push(stripShellQuotes(match[1]));
	}
	for (const match of command.matchAll(/\bof=(?:'([^']*)'|"([^"]*)"|([^\s|;&]+))/gu)) {
		const target = match[1] ?? match[2] ?? match[3];
		if (target) targets.push(target);
	}
	return targets;
}

function stripShellQuotes(value: string): string {
	return value.replace(
		/^(?:'([^']*)'|"([^"]*)")$/u,
		(_full: string, single: string | undefined, double: string | undefined) => single ?? double ?? value,
	);
}
