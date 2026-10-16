/** A bounded JSON parser that validates ignored content without allocating it. */
export class UsageProjectionLimit extends Error {}

const top = new Set([
	"type",
	"id",
	"parentId",
	"timestamp",
	"version",
	"cwd",
	"parentSession",
	"message",
	"usage",
	"customType",
	"data",
	"thinkingLevel",
]);
const usageKeys = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const dataKeys = new Set([
	"version",
	"usage",
	"missingUsage",
	"attemptId",
	"requestId",
	"sessionId",
	"originSessionId",
	"sourceLeafId",
	"usageEntryId",
	"reasoningAtDispatch",
	"requestedProvider",
	"requestedModel",
	"runId",
	"kind",
	"stage",
	"name",
	"resourceId",
	"pluginId",
	"startedAt",
	"sessionRole",
	"skillDiscovery",
	"skillActivation",
	"pluginInvocation",
	"parentSessionId",
	"parentCwd",
	"origins",
	"key",
	"complete",
	"path",
	"ino",
	"dev",
	"size",
	"mtime",
	"parsedBytes",
	"header",
	"entries",
	"chunk",
	"limited",
]);

function keepPath(path: string[]): boolean {
	if (path[0] === "data" && path[1] === "digest") return path.length === 2;
	if (path[0] === "data" && ["entries", "header"].includes(path[1])) return keepPath(path.slice(2));
	if (path.length === 0) return true;
	if (!top.has(path[0])) return false;
	if (path.length === 1) return true;
	if (path[0] === "usage") return path.length === 2 && usageKeys.has(path[1]);
	if (path[0] === "message") {
		if (path.length === 2)
			return ["role", "usage", "provider", "model", "responseModel", "timestamp"].includes(path[1]);
		return path[1] === "usage" && path.length === 3 && usageKeys.has(path[2]);
	}
	if (path[0] === "data") {
		if (!dataKeys.has(path[1])) return false;
		if (path[1] === "usage") return path.length === 2 || (path.length === 3 && usageKeys.has(path[2]));
		if (path[1] === "origins")
			return path.length <= 3 || (path.length === 4 && ["sessionId", "cwd", "role"].includes(path[3]));
		return path.length === 2;
	}
	return false;
}

export function projectUsageJson(source: string): Record<string, unknown> {
	let cursor = 0,
		tokens = 0,
		retained = 0;
	const deadline = performance.now() + 1000;
	const timeBudget = (): void => {
		if (performance.now() > deadline) throw new UsageProjectionLimit("Session parsing time budget exceeded");
	};
	const fail = (): never => {
		throw new SyntaxError("Invalid session JSON");
	};
	const budget = (n = 1): void => {
		tokens += n;
		if ((tokens & 255) === 0) timeBudget();
		if (tokens > 200000 || retained > 256 * 1024) throw new UsageProjectionLimit("Session record budget exceeded");
	};
	const space = (): void => {
		while (cursor < source.length && /[\t\n\r ]/u.test(source[cursor])) cursor++;
	};
	const string = (keep: boolean): string => {
		if (source[cursor++] !== '"') return fail();
		let result = "";
		while (cursor < source.length) {
			if ((cursor & 32767) === 0) timeBudget();
			let ch = source[cursor++];
			if (ch === '"') {
				if (keep) {
					retained += Buffer.byteLength(result);
					budget(0);
				}
				return result;
			}
			if (ch.charCodeAt(0) < 32) return fail();
			if (ch === "\\") {
				const escaped = source[cursor++];
				if (escaped === "u") {
					const code = source.slice(cursor, cursor + 4);
					if (!/^[0-9a-fA-F]{4}$/u.test(code)) return fail();
					cursor += 4;
					ch = String.fromCharCode(Number.parseInt(code, 16));
				} else {
					const escapes: Record<string, string> = {
						'"': '"',
						"\\": "\\",
						"/": "/",
						b: "\b",
						f: "\f",
						n: "\n",
						r: "\r",
						t: "\t",
					};
					if (!(escaped in escapes)) return fail();
					ch = escapes[escaped];
				}
			}
			if (keep) {
				result += ch;
				if (result.length > 4096) throw new UsageProjectionLimit("Session string budget exceeded");
			}
		}
		return fail();
	};
	const value = (path: string[] | undefined, depth: number): unknown => {
		budget();
		if (depth > 64) throw new UsageProjectionLimit("Session nesting budget exceeded");
		space();
		const keep = path !== undefined && keepPath(path),
			ch = source[cursor];
		if (keep) {
			retained += 16;
			budget(0);
		}
		if (ch === '"') return string(keep);
		if (ch === "{" || ch === "[") {
			const object = ch === "{",
				end = object ? "}" : "]",
				result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
			cursor++;
			space();
			if (source[cursor] === end) {
				cursor++;
				return keep ? result : undefined;
			}
			for (;;) {
				let key = "";
				if (object) {
					space();
					key = string(keep);
					space();
					if (source[cursor++] !== ":") return fail();
				}
				const nextPath = keep && path ? (object ? [...path, key] : path) : undefined;
				const selected = nextPath !== undefined && keepPath(nextPath),
					parsed = value(selected ? nextPath : undefined, depth + 1);
				if (keep && selected) {
					if (object) {
						if (Object.hasOwn(result, key)) return fail();
						(result as Record<string, unknown>)[key] = parsed;
					} else (result as unknown[]).push(parsed);
				}
				space();
				const separator = source[cursor++];
				if (separator === end) break;
				if (separator !== ",") return fail();
			}
			return keep ? result : undefined;
		}
		for (const [literal, parsed] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (source.startsWith(literal, cursor)) {
				cursor += literal.length;
				return keep ? parsed : undefined;
			}
		}
		const start = cursor;
		while (cursor < source.length && !/[\t\n\r ,}\]]/u.test(source[cursor])) cursor++;
		const number = source.slice(start, cursor);
		if (number.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(number)) return fail();
		const parsed = Number(number);
		if (keep && !Number.isFinite(parsed)) return fail();
		return keep ? parsed : undefined;
	};
	const parsed = value([], 0);
	budget(0);
	space();
	if (cursor !== source.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
	return parsed as Record<string, unknown>;
}
