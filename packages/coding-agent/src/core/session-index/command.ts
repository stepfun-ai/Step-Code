import { existsSync } from "node:fs";
import { defaultSessionIndexRoots, openSessionIndex, type SessionIndexRoot } from "./client.ts";
import { deleteIndexDatabase, getSessionIndexPath } from "./schema.ts";

export interface SessionIndexCommandOptions {
	agentDir: string;
	/** Session roots in addition to `<agentDir>/sessions`, e.g. a configured session directory. */
	extraRoots?: readonly string[];
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

const USAGE = `Usage: step session-index <command> [options]

Manage the local session search index. Session files are never modified;
the index can be deleted and rebuilt at any time.

Commands:
  status            Show index state and coverage
  reindex [--full]  Index new and changed sessions (--full rebuilds everything)
  clear             Delete the index database

Options:
  --json            Print machine-readable output (status, reindex)
`;

/** `step session-index status | reindex | clear`. Returns the process exit code. */
export async function runSessionIndexCommand(
	args: readonly string[],
	options: SessionIndexCommandOptions,
): Promise<number> {
	const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
	const [command, ...rest] = args;
	if (command === undefined || command === "--help" || command === "-h" || rest.includes("--help")) {
		stdout(USAGE);
		return command === undefined ? 1 : 0;
	}
	const json = rest.includes("--json");
	const allowed = command === "reindex" ? ["--json", "--full"] : command === "status" ? ["--json"] : [];
	const unknown = rest.find((arg) => !allowed.includes(arg));
	if (unknown !== undefined) {
		stderr(`Unknown option "${unknown}" for "session-index ${command}".\n`);
		return 1;
	}
	const dbPath = getSessionIndexPath(options.agentDir);

	if (command === "clear") {
		const existed = existsSync(dbPath);
		deleteIndexDatabase(dbPath);
		stdout(existed ? `Deleted ${dbPath}\n` : `No session index at ${dbPath}\n`);
		return 0;
	}
	if (command !== "status" && command !== "reindex") {
		stderr(`Unknown command "${command}".\n\n${USAGE}`);
		return 1;
	}

	const roots: SessionIndexRoot[] = [
		...defaultSessionIndexRoots(options.agentDir),
		...(options.extraRoots ?? []).map((path) => ({ path, kind: "custom" as const })),
	];
	const index = await openSessionIndex({ agentDir: options.agentDir, roots, backfill: false });
	try {
		if (command === "reindex") {
			const status = await index.status();
			if (status.state === "degraded") {
				stderr(`Session index unavailable: ${status.degradedReason ?? "unknown reason"}\n`);
				return 1;
			}
			let lastReport = 0;
			for await (const progress of index.reindex({ full: rest.includes("--full") })) {
				if (json || (!progress.done && Date.now() - lastReport < 500)) continue;
				lastReport = Date.now();
				stderr(`Indexed ${progress.indexed}/${progress.total} sessions${progress.done ? "" : "..."}\n`);
			}
		}
		const status = await index.status();
		if (json) {
			stdout(`${JSON.stringify(status)}\n`);
		} else if (status.state === "degraded") {
			stdout(`State: degraded (searches scan session files)\nReason: ${status.degradedReason ?? "unknown"}\n`);
		} else {
			stdout(
				`State: ${status.indexed < status.total ? "incomplete" : "ready"}\nIndexed: ${status.indexed}/${status.total} sessions\nPending: ${status.pending}\nErrors: ${status.errors}\nDatabase: ${dbPath}\n`,
			);
		}
		return status.state === "degraded" && command === "reindex" ? 1 : 0;
	} finally {
		await index.close();
	}
}
