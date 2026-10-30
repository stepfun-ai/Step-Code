import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { MigrationError, type MigrationJob, type MigrationPreview, type MigrationRecoveryPreview } from "@step-harness/coding-agent";
import { migrationRoute, type MigrationRouteService } from "../src/migration-routes.ts";

const JOB_ID = "12345678-1234-4123-8123-123456789abc";
const job: MigrationJob = { id: JOB_ID, createdAt: new Date(0).toISOString(), revision: 1, status: "queued", items: [] };
const location = { scope: { kind: "global" as const }, path: "/fixture/prompts/example.md", name: "example" };
const preview: MigrationPreview = {
	id: "preview-1", candidate: { id: "candidate-1", kind: "prompts", source: "shared", name: "example",
		sourcePath: "/fixture/source", sourceScope: { kind: "global" }, holding: "external", readiness: "ready",
		needsMigration: true, diagnostics: [] }, fingerprint: "digest", expiresAt: new Date(0).toISOString(),
	target: location, action: "copy", allowedActions: ["copy"], sourceText: "fixture", requiredAcknowledgements: ["independent-copy"],
	warnings: [], blockers: [], activation: "next-resource-load",
};
const recovery: MigrationRecoveryPreview = { id: "recovery-1", jobId: JOB_ID, itemId: "item-1", target: location,
	currentText: "new", restoredText: "old", expiresAt: new Date(0).toISOString(), requiredAcknowledgements: ["rules-impact"], diagnostics: [] };
function service(): MigrationRouteService {
	return {
		scan: mock.fn(async () => ({ candidates: [], sources: [], truncated: false })),
		preview: mock.fn(async () => preview), plan: mock.fn(async () => ({ id: "plan-1", digest: "digest", expiresAt: "expiry", items: [preview] })),
		start: mock.fn(async () => job), listJobs: mock.fn(() => [job]), getJob: mock.fn(() => job), cancel: mock.fn(() => job),
		previewRecovery: mock.fn(() => recovery), recover: mock.fn(() => ({ restored: true })),
	};
}
async function dispatch(s: MigrationRouteService, parts: string[], method = "POST", value: unknown = {},
	options: { raw?: string; query?: string; headers?: Record<string, string>; known?: (cwd: string | null) => Promise<string | undefined>; broken?: boolean } = {}) {
	const socket = new Socket();
	const request = new IncomingMessage(socket);
	request.method = method;
	request.headers = options.headers ?? { "content-type": "application/json" };
	const response = new ServerResponse(request);
	let output = "";
	let headers: unknown;
	mock.method(response, "writeHead", (status: number, input: unknown) => { response.statusCode = status; headers = input; return response; });
	mock.method(response, "end", (chunk: unknown) => { output = String(chunk); return response; });
	if (options.broken) request.destroy(new Error("private source exception"));
	else { request.complete = true; request.push(options.raw ?? JSON.stringify(value)); request.push(null); }
	try {
		await migrationRoute(s, parts, new URL(`http://127.0.0.1/api/v1/migrations${parts.length ? `/${parts.join("/")}` : ""}${options.query ?? ""}`), request, response,
			options.known ?? (async () => undefined));
		return { status: response.statusCode, value: JSON.parse(output), headers };
	} finally { socket.destroy(); }
}

test("accepts explicit MCP source files but rejects unknown sources and relative paths", async () => {
	const s = service();
	assert.equal((await dispatch(s, ["scan"], "POST", { kinds: ["mcp"], mcpSourcePaths: { codex: "/fixture/custom.toml" } })).status, 200);
	assert.equal((await dispatch(s, ["scan"], "POST", { mcpSourcePaths: { codex: "relative.toml" } })).status, 400);
	assert.equal((await dispatch(s, ["scan"], "POST", { mcpSourcePaths: { unknown: "/fixture/custom.toml" } })).status, 400);
});

test("dispatches all operations with awaited responses and no-store JSON", async () => {
	const s = service();
	assert.deepEqual((await dispatch(s, [], "GET")).value, { jobs: [job] });
	const started = await dispatch(s, [], "POST", { planId: "plan-1", digest: "digest", idempotencyKey: "retry-key" });
	assert.equal(started.status, 202);
	assert.deepEqual(started.value, job);
	assert.deepEqual(started.headers, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	assert.deepEqual((await dispatch(s, [JOB_ID], "GET")).value, job);
	assert.deepEqual((await dispatch(s, [JOB_ID, "cancel"])).value, job);
	assert.deepEqual((await dispatch(s, [JOB_ID, "cancel"], "POST", {}, { raw: "" })).value, job);
	assert.deepEqual((await dispatch(s, ["recoveries", "preview"], "POST", { jobId: JOB_ID, itemId: "item-1" })).value, recovery);
	assert.deepEqual((await dispatch(s, ["recoveries", "apply"], "POST", { previewId: "recovery-1", acknowledged: ["rules-impact"] })).value, { restored: true });
});

test("forwards explicit preview and plan consent without synthesizing acknowledgement", async () => {
	const s = service();
	let received: unknown;
	s.preview = async (input) => { received = input; return preview; };
	const input = { candidateId: "candidate-1", target: { kind: "global" }, action: "copy", targetName: "copy", includeSensitiveValues: true };
	assert.equal((await dispatch(s, ["preview"], "POST", input)).status, 200);
	assert.deepEqual(received, input);
	s.plan = async (selections) => { received = selections; return { id: "plan-1", digest: "digest", expiresAt: "expiry", items: [preview] }; };
	const selections = [{ previewId: "preview-1", acknowledged: ["independent-copy", "sensitive-values"] }];
	assert.equal((await dispatch(s, ["plans"], "POST", { selections })).status, 200);
	assert.deepEqual(received, selections);
});

test("requires known canonical source projects but allows an explicitly selected new target without registering it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "migration-routes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const project = join(root, "project");
	await mkdir(project);
	const canonical = await realpath(project);
	const alias = join(root, "alias");
	await symlink(project, alias);
	const s = service();
	let received: unknown;
	s.scan = async (input) => { received = input; return { candidates: [], sources: [], truncated: false }; };
	// Any existing canonical directory may be a read-only scan source, registered or not.
	assert.equal((await dispatch(s, ["scan"], "POST", { projectCwds: [alias] })).status, 200);
	assert.deepEqual(received, { kinds: undefined, projectCwds: [canonical] });
	assert.equal((await dispatch(s, ["scan"], "POST", { kinds: ["rules"], projectCwds: [alias] })).status, 200);
	assert.deepEqual(received, { kinds: ["rules"], projectCwds: [canonical] });
	s.preview = async (input) => { received = input; return preview; };
	assert.equal((await dispatch(s, ["preview"], "POST", { candidateId: "candidate-1", target: { kind: "project", cwd: alias } })).status, 200);
	assert.deepEqual(received, { candidateId: "candidate-1", target: { kind: "project", cwd: canonical } });
	// Missing destinations are forwarded for product-level preview blockers, never authorized as writable targets.
	assert.equal((await dispatch(s, ["preview"], "POST", { candidateId: "candidate-1", target: { kind: "project", cwd: join(root, "missing") } })).status, 200);
	assert.equal((await dispatch(s, ["scan"], "POST", { projectCwds: [join(root, "missing")] })).status, 400);
	const file = join(root, "file");
	await writeFile(file, "fixture");
	for (const cwd of ["relative", file, "\0"]) {
		assert.equal((await dispatch(s, ["preview"], "POST", { candidateId: "candidate-1", target: { kind: "project", cwd } })).status, 400);
		assert.equal((await dispatch(s, ["scan"], "POST", { projectCwds: [cwd] })).status, 400);
	}
});

test("rejects malformed JSON, unknown keys, wrong types, oversize and unreadable requests", async () => {
	const s = service();
	for (const raw of ["{", "null", "[]", "", "true"]) {
		assert.equal((await dispatch(s, ["scan"], "POST", {}, { raw })).status, 400);
	}
	const cases: [string[], unknown][] = [
		[["scan"], { sourceRoot: "/arbitrary" }], [["scan"], { kinds: ["credentials"] }],
		[["scan"], { projectCwds: "string" }], [["preview"], { candidateId: "x", includeSensitiveValues: "yes" }],
		[["preview"], { candidateId: "x", action: "execute" }], [["preview"], { candidateId: "x", target: { kind: "global", cwd: "/tmp" } }],
		[["preview"], { candidateId: "x", target: { kind: "project", cwd: "/tmp", trust: true } }],
		[["plans"], { selections: [{ previewId: "x", acknowledged: ["yes"] }] }],
		[["plans"], { selections: [{ previewId: "x", acknowledged: [], digest: "extra" }] }],
		[[], { planId: "x", digest: "d", idempotencyKey: "k", confirmed: true }],
		[[JOB_ID, "cancel"], { target: "/tmp" }], [["recoveries", "apply"], { previewId: "x", acknowledged: [], extra: true }],
	];
	for (const [parts, input] of cases) assert.equal((await dispatch(s, parts, "POST", input)).status, 400);
	assert.equal((await dispatch(s, ["scan"], "POST", {}, { raw: "x".repeat(65537) })).status, 413);
	assert.equal((await dispatch(s, ["scan"], "POST", {}, { headers: { "content-length": "65537" } })).status, 413);
	assert.equal((await dispatch(s, ["scan"], "POST", {}, { headers: { "content-type": "text/plain" } })).status, 415);
	assert.equal((await dispatch(s, ["scan"], "POST", {}, { headers: { "content-length": "20" } })).status, 400);
	assert.equal((await dispatch(s, ["scan"], "POST", {}, { broken: true })).status, 400);
});

test("checks URL, ids and route methods and never leaks raw source failures", async () => {
	const s = service();
	for (const [parts, method] of [[[], "DELETE"], [["scan"], "GET"], [[JOB_ID, "cancel"], "GET"], [[JOB_ID, "unknown"], "POST"], [["recoveries", "other"], "POST"]] as const) {
		assert.equal((await dispatch(s, [...parts], method)).status, 404);
	}
	for (const parts of [["../escape"], ["encoded%2fpath"], ["x\\y"], [""]]) assert.equal((await dispatch(s, parts, "GET")).status, 400);
	assert.equal((await dispatch(s, [], "GET", {}, { query: "?cwd=/private" })).status, 400);
	s.scan = async () => { throw new MigrationError("source-changed", 409); };
	assert.deepEqual((await dispatch(s, ["scan"])).value, { error: "source-changed", code: "source-changed" });
	s.scan = async () => { throw new Error("source contains a private credential"); };
	const result = await dispatch(s, ["scan"]);
	assert.equal(result.status, 503);
	assert.deepEqual(result.value, { error: "migration-unavailable", code: "migration-unavailable" });
});
