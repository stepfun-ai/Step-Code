/**
 * Parsing for the `/room` command's argument string.
 *
 * The host hands an extension command the whole tail of the line, so `/room join 48291730` arrives
 * as `"join 48291730"`. Reading only the first token would silently drop the code, and treating the
 * whole string as the code rejects a command the user typed correctly, so this lives in one tested
 * place instead of being re-derived at the call site.
 */

export type RoomCommandAction =
	| { kind: "start" }
	| { kind: "join"; code: string }
	| { kind: "leave" }
	| { kind: "invalid"; input: string };

/** The minimum a room code must look like; the service enforces the real lifetime rules. */
const CODE_PATTERN = /^\d{6,12}$/;

/**
 * Interpret the argument tail. An empty tail starts a room; `join <code>` and a bare code both join,
 * because a person who just pasted the number should not be told they forgot a keyword.
 */
export function parseRoomCommand(input: string): RoomCommandAction {
	const value = input.trim();
	if (!value) return { kind: "start" };
	if (value === "leave" || value === "off") return { kind: "leave" };
	const joined = /^join(?:\s+(.*))?$/s.exec(value);
	const candidate = joined ? (joined[1] ?? "").trim() : value;
	if (!CODE_PATTERN.test(candidate)) return { kind: "invalid", input: value };
	return { kind: "join", code: candidate };
}
