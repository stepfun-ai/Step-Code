#!/usr/bin/env node

// "The wire projection is the only policy" check.
//
// A serialized transport (--mode json, --mode rpc) writes session events to a
// stdout a harness may redirect to a file, so that file has to contain facts and
// not live frames. The decision lives in `modes/json-event.ts`:
// `toJsonEvent(event, { includeLiveEvents })` returns `undefined` for a frame
// whose caller did not opt in, and projects the events that would otherwise
// re-send a message it already wrote.
//
// The incident this guards against (a 4,992 MiB subagent log) started as one
// transport writing every event, and the first fix put the filter at the call
// site. Two call sites are tolerable; a third pair is how the filter silently
// stops being one policy. So:
//
//   Rule 1 — one projection. `toJsonEvent` is called only from the transports
//            that are allowed to serialize session events, plus its own module
//            and the package barrel.
//   Rule 2 — no call-site policy. `isEphemeralSessionEvent` /
//            `sessionEventDurability` may be referenced only by the projection,
//            its own module, and the barrel. A transport that filters before
//            calling `toJsonEvent` fails here, because that is the divergence
//            rule 1 exists to prevent.
//
// Rule 2 keeps the classification available to non-transport callers by
// allowing the barrel: importing it from `@step-harness/coding-agent` in a new
// host is a deliberate act with a written reason, not a copy-paste in a
// transport's subscribe callback.
//
// This is a "forgot to classify" guard, not a security boundary. It reads text,
// so it does not stop a namespace import (`import * as p; p.toJsonEvent(...)`),
// a hand-rolled `JSON.stringify(event)`, a wrapper module outside the scanned
// roots, or an edit to the transport allowlist above. Those are deliberate acts
// visible in review.
//
// What it does catch is narrower than "a new transport": it catches a new
// *caller of the projection* that is not in the allowlist, a transport whose
// call stopped threading the option, and the call-site filter coming back. It
// does **not** catch a new transport that never calls the projection at all —
// one that subscribes to the session and serializes the events itself, as the
// framed SDK host does. Nothing here can tell that apart from an in-process
// subscriber without knowing the file writes a stream, so that case relies on
// review of the `session.subscribe` call site.
//
// No new dependency; same node + --self-test convention as the sibling
// check-*.mjs scripts. Pure classification in analyzeFile(path, text).
//
// Run:  node scripts/check-session-event-transports.mjs
//       node scripts/check-session-event-transports.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

const PROJECTION = "packages/coding-agent/src/modes/json-event.ts";
const BARREL = "packages/coding-agent/src/index.ts";
const DURABILITY = "packages/coding-agent/src/core/session-event-durability.ts";

/** Transports that serialize session events, and the option each must thread. */
const TRANSPORTS = new Set([
	"packages/coding-agent/src/modes/print-mode.ts",
	"packages/coding-agent/src/modes/rpc/rpc-mode.ts",
]);

const PROJECTION_CALL = "toJsonEvent";
const POLICY_REFERENCES = ["isEphemeralSessionEvent", "sessionEventDurability"];

// --- pure classification -------------------------------------------------------------

function normalize(p) {
	return p.replace(/\\/g, "/");
}

/** Strip comments and string literals so prose cannot trip the rules. */
function stripNonCode(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function namesIdentifier(code, name) {
	// A bare mention in code: not a property access (`.name`) and not part of a
	// longer identifier (`xName`, `nameOf`).
	return new RegExp(`(^|[^.\\w$])${name}\\b(?!\\s*:)`, "m").test(code);
}

/**
 * Split an argument list at its own top level (commas not nested in (), [], {}).
 */
function splitTopLevelArguments(source) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const char of source) {
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") depth -= 1;
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) parts.push(current);
	return parts;
}

/**
 * Every `toJsonEvent(...)` call, with its own top-level arguments.
 *
 * All occurrences are scanned, including nested ones, so
 * `toJsonEvent(toJsonEvent(event), { ... })` reports the inner call. Whitespace
 * before `(` is allowed: `toJsonEvent (event)` is still a call.
 */
function projectionCalls(code) {
	const calls = [];
	const needle = new RegExp(`${PROJECTION_CALL}\\s*\\(`, "g");
	for (const match of code.matchAll(needle)) {
		let depth = 1;
		let cursor = (match.index ?? 0) + match[0].length;
		while (cursor < code.length && depth > 0) {
			const char = code[cursor];
			if (char === "(" || char === "[" || char === "{") depth += 1;
			else if (char === ")" || char === "]" || char === "}") depth -= 1;
			cursor += 1;
		}
		calls.push(splitTopLevelArguments(code.slice((match.index ?? 0) + match[0].length, cursor - 1)));
	}
	return calls;
}

function isProjectionHome(p) {
	const n = normalize(p);
	return n === PROJECTION || n === BARREL;
}

function analyzeFile(repoRelPath, text) {
	const n = normalize(repoRelPath);
	const code = stripNonCode(text);
	const violations = [];

	if (namesIdentifier(code, PROJECTION_CALL) && !isProjectionHome(n) && !TRANSPORTS.has(n)) {
		violations.push(
			`${n}: calls ${PROJECTION_CALL} — serialize session events only from a known transport (${[...TRANSPORTS].join(", ")}); add the new transport there and to this allowlist`,
		);
	}
	if (TRANSPORTS.has(n)) {
		for (const args of projectionCalls(code)) {
			// The options object is the policy, and it has to be this call's own
			// second argument: `toJsonEvent(f(e, { includeLiveEvents: true }))`
			// contains the text but threads nothing.
			const options = args[1]?.trim() ?? "";
			if (args.length < 2 || !options.startsWith("{") || !/includeLiveEvents/.test(options)) {
				violations.push(
					`${n}: ${PROJECTION_CALL}(${args.map((arg) => arg.trim()).join(", ").slice(0, 60)}) does not pass \`{ includeLiveEvents }\` as its own second argument — every serialized transport must state whether it opted into live frames`,
				);
			}
		}
	}
	for (const policy of POLICY_REFERENCES) {
		if (!namesIdentifier(code, policy)) continue;
		if (isProjectionHome(n) || n === DURABILITY) continue;
		violations.push(
			`${n}: references ${policy} — the frame/durable decision belongs to ${PROJECTION}; a call-site filter is a second policy that will drift`,
		);
	}
	return violations;
}

// --- filesystem ----------------------------------------------------------------------

function collectTsFiles(absoluteDir) {
	const files = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
				files.push(full);
			}
		}
	};
	walk(absoluteDir);
	return files;
}

function runReal() {
	const roots = [join(repoRoot, "packages", "coding-agent", "src"), join(repoRoot, "apps", "cli", "src")];
	const violations = [];
	for (const root of roots) {
		for (const file of collectTsFiles(root)) {
			const repoRel = relative(repoRoot, file);
			for (const violation of analyzeFile(repoRel, readFileSync(file, "utf8"))) violations.push(violation);
		}
	}
	if (violations.length > 0) {
		console.error("session-event-transports check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("session-event-transports check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const expectClean = (path, text) => {
		if (analyzeFile(path, text).length > 0) failures.push(`expected clean: ${path} — ${analyzeFile(path, text)[0]}`);
	};
	const expectViolation = (path, text) => {
		if (analyzeFile(path, text).length === 0) failures.push(`expected violation: ${path}`);
	};

	const printMode = "packages/coding-agent/src/modes/print-mode.ts";
	const rpcMode = "packages/coding-agent/src/modes/rpc/rpc-mode.ts";

	// clean — the projection defines it, the barrel re-exports the classification,
	// both transports thread the option.
	expectClean(PROJECTION, `export function ${PROJECTION_CALL}(event) { return isEphemeralSessionEvent(event) ? undefined : event; }`);
	expectClean(BARREL, `export { ${POLICY_REFERENCES.join(", ")} } from "./core/session-event-durability.ts";`);
	expectClean(rpcMode, `const projected = ${PROJECTION_CALL}(event, { includeLiveEvents }); if (projected) output(projected);`);
	expectClean(printMode, `const projected = ${PROJECTION_CALL}(event, { includeLiveEvents });`);
	// clean — prose in a comment does not count.
	expectClean("apps/cli/src/modes/json.ts", `// each line is a ${PROJECTION_CALL} result; never calls ${POLICY_REFERENCES[0]}`);

	// violation — rule 1: a new transport, or a module that is not one.
	expectViolation(
		"apps/cli/src/modes/stdio.ts",
		`session.subscribe((event) => write(JSON.stringify(${PROJECTION_CALL}(event))));`,
	);
	expectViolation("packages/coding-agent/src/step/stdio-host.ts", `const line = ${PROJECTION_CALL}(event);`);

	// violation — rule 1: a transport that forgets to state the option in the call,
	// even when an `includeLiveEvents` variable exists elsewhere in the file.
	expectViolation(printMode, `const includeLiveEvents = false; writeRawStdout(${PROJECTION_CALL}(event));`);
	expectViolation(rpcMode, `output(${PROJECTION_CALL}(event));`);
	// violation — the option text is present but not this call's own argument.
	expectViolation(rpcMode, `output(${PROJECTION_CALL}(build(event, { includeLiveEvents: true })));`);
	// violation — a nested call hides its own missing option behind the outer one.
	expectViolation(rpcMode, `output(${PROJECTION_CALL}(${PROJECTION_CALL}(event), { includeLiveEvents: true }));`);
	// violation — whitespace before the paren is still a call.
	expectViolation(printMode, `writeRawStdout(${PROJECTION_CALL} (event));`);

	// violation — rule 2: the old call-site filter comes back.
	expectViolation(rpcMode, `if (!live && ${POLICY_REFERENCES[0]}(event)) return; output(event);`);
	expectViolation(
		"apps/cli/src/modes/json.ts",
		`if (${POLICY_REFERENCES[1]}(event) === "ephemeral") return;`,
	);
	// clean — a property of the same name is not a reference to the policy.
	expectClean(printMode, `const options = { includeLiveEvents: config.${POLICY_REFERENCES[0]} };`);
	// clean — the option is this call's own second argument, however it is spelled.
	expectClean(rpcMode, `output(${PROJECTION_CALL}(event, { includeLiveEvents: options.live }));`);
	expectClean(printMode, `writeRawStdout(${PROJECTION_CALL}(event, { includeLiveEvents }));`);
	// clean — comments still do not count, including one that names the call.
	expectClean(printMode, `/* never call ${PROJECTION_CALL}() here */ const x = 1;`);

	if (failures.length > 0) {
		console.error("session-event-transports self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("session-event-transports self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
