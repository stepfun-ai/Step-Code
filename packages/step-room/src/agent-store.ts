/**
 * Persistence for the room agent's own Feishu application credentials.
 *
 * One file per user: the app this person created for StepCode rooms. Once written it is reused on
 * every later run, so a user never accumulates a second application by accident.
 *
 * The secret lives only in this file, created with owner-only permissions. Nothing here logs,
 * echoes or copies it anywhere else.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RoomAgentRecord {
	appId: string;
	appSecret: string;
	botOpenId: string;
	botName: string;
	brand: "feishu" | "lark";
	createdAt: string;
}

export type RoomAgentReadResult =
	| { status: "missing" }
	| { status: "invalid"; reason: string }
	| { status: "found"; record: RoomAgentRecord };

export interface RoomAgentStoreOptions {
	/** Directory holding the record. Defaults to the caller's resolved storage root plus `lark`. */
	directory?: string;
	fileName?: string;
}

const DEFAULT_FILE = "room-agent.json";

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Validate an unknown value as a record. Unknown fields are dropped rather than carried forward. */
export function parseRoomAgentRecord(value: unknown): RoomAgentRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (!isNonEmptyString(raw.appId) || !isNonEmptyString(raw.appSecret)) return undefined;
	if (!isNonEmptyString(raw.botOpenId) || !isNonEmptyString(raw.botName)) return undefined;
	const brand = raw.brand === "lark" ? "lark" : raw.brand === "feishu" ? "feishu" : undefined;
	if (!brand) return undefined;
	if (!isNonEmptyString(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) return undefined;
	return {
		appId: raw.appId,
		appSecret: raw.appSecret,
		botOpenId: raw.botOpenId,
		botName: raw.botName,
		brand,
		createdAt: raw.createdAt,
	};
}

/**
 * File-backed record for one room agent.
 *
 * Reads distinguish "no record yet" from "a record we cannot use": the first is the normal first
 * run, the second must be reported so the user can re-authorize instead of silently creating a
 * second application.
 */
export class RoomAgentStore {
	private readonly filePath: string;

	constructor(options: RoomAgentStoreOptions = {}) {
		if (!options.directory) throw new Error("room agent store needs a directory");
		this.filePath = join(options.directory, options.fileName ?? DEFAULT_FILE);
	}

	get path(): string {
		return this.filePath;
	}

	async read(): Promise<RoomAgentReadResult> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
			return { status: "invalid", reason: "unreadable" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { status: "invalid", reason: "malformed" };
		}
		const record = parseRoomAgentRecord(parsed);
		if (!record) return { status: "invalid", reason: "incomplete" };
		return { status: "found", record };
	}

	/**
	 * Write atomically: a partially written record would look valid enough to be trusted on the next
	 * run, so the file is replaced by rename rather than truncated in place.
	 */
	async write(record: RoomAgentRecord): Promise<void> {
		const validated = parseRoomAgentRecord(record);
		if (!validated) throw new Error("invalid room agent record");
		await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, this.filePath);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async clear(): Promise<void> {
		await rm(this.filePath, { force: true });
	}
}
