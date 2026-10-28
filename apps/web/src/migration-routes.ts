import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
	type MigrationAcknowledgement,
	type MigrationAction,
	type MigrationKind,
	type MigrationPreviewRequest,
	type MigrationScope,
	type MigrationSelection,
	type MigrationService,
	MigrationError as MigrationServiceError,
} from "@step-harness/coding-agent";

export type MigrationRouteService = Pick<
	MigrationService,
	"scan" | "preview" | "plan" | "start" | "listJobs" | "getJob" | "cancel" | "previewRecovery" | "recover"
>;
const KINDS: MigrationKind[] = ["sessions", "skills", "mcp", "prompts", "rules"];
const ACTIONS: MigrationAction[] = ["copy", "import", "create", "append", "replace", "skip"];
const ACKS: MigrationAcknowledgement[] = ["rules-impact", "scope-expansion", "independent-copy", "sensitive-values"];
const BODY_LIMIT = 64 * 1024;

function fail(code = "invalid-migration-request", status = 400): never {
	throw new MigrationServiceError(code, status);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail();
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !keys.includes(key))) fail();
	return result;
}
function text(value: unknown, limit = 512): string {
	if (typeof value !== "string" || !value.length || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail();
	return value;
}
function id(value: unknown): string {
	const result = text(value, 256);
	if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail("invalid-migration-id");
	return result;
}
function choice<T extends string>(value: unknown, choices: T[]): T {
	if (typeof value !== "string" || !choices.includes(value as T)) fail();
	return value as T;
}
function array<T>(value: unknown, parse: (item: unknown) => T, max: number): T[] {
	if (!Array.isArray(value) || value.length > max) fail();
	return value.map(parse);
}
function selection(value: unknown): MigrationSelection {
	const input = object(value, ["previewId", "acknowledged"]);
	return { previewId: id(input.previewId), acknowledged: array(input.acknowledged, (ack) => choice(ack, ACKS), 4) };
}
async function body(request: IncomingMessage, allowEmpty = false): Promise<unknown> {
	const contentType = request.headers["content-type"];
	if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) fail("invalid-content-type", 415);
	const length = request.headers["content-length"];
	if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))
		fail("migration-body-too-large", 413);
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += buffer.length;
			if (size > BODY_LIMIT) fail("migration-body-too-large", 413);
			chunks.push(buffer);
		}
	} catch (error) {
		if (error instanceof MigrationServiceError) throw error;
		fail("migration-body-unreadable");
	}
	if (request.aborted || (length !== undefined && Number(length) !== size)) fail("migration-body-unreadable");
	if (allowEmpty && size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		fail("invalid-migration-json");
	}
}
async function directory(value: unknown): Promise<string> {
	const path = text(value, 4096);
	if (!isAbsolute(path)) fail("invalid-migration-path");
	try {
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) fail("invalid-migration-path");
		return canonical;
	} catch {
		fail("invalid-migration-path");
	}
}
async function sourceDirectory(
	value: unknown,
	knownWorkspace: (input: string | null) => Promise<string | undefined>,
): Promise<string> {
	const canonical = await directory(value);
	const known = await knownWorkspace(canonical);
	if (!known || (await directory(known)) !== canonical) fail("migration-workspace-forbidden", 403);
	return canonical;
}
async function target(value: unknown): Promise<MigrationScope> {
	const input = object(value, ["kind", "cwd"]);
	if (input.kind === "global") {
		if ("cwd" in input) fail();
		return { kind: "global" };
	}
	if (input.kind !== "project") fail();
	return { kind: "project", cwd: await directory(input.cwd) };
}
function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

/**
 * Dispatch only after the caller has authorized the Host cookie and Origin.
 * Scan source projects must be registered; scanning never registers or trusts a project.
 * An explicit preview target may be any existing canonical directory (including an unregistered
 * source cwd). Selection authorizes a destination, not source reads or workspace registration;
 * the product service still owns immutable plans, consent, containment and publication.
 */
export async function migrationRoute(
	service: MigrationRouteService,
	parts: string[],
	url: URL,
	request: IncomingMessage,
	response: ServerResponse,
	knownWorkspace: (input: string | null) => Promise<string | undefined>,
): Promise<void> {
	try {
		const expectedPath = `/api/v1/migrations${parts.length ? `/${parts.join("/")}` : ""}`;
		if (
			url.pathname !== expectedPath ||
			url.search ||
			url.hash ||
			parts.some((part) => !part || /[/\\%\x00-\x1f]/.test(part))
		)
			fail("invalid-migration-url");
		const method = request.method;
		if (parts.length === 0 && method === "GET") return reply(response, 200, { jobs: await service.listJobs() });
		if (parts.length === 0 && method === "POST") {
			const input = object(await body(request), ["planId", "digest", "idempotencyKey"]);
			return reply(
				response,
				202,
				await service.start({
					planId: id(input.planId),
					digest: text(input.digest),
					idempotencyKey: text(input.idempotencyKey),
				}),
			);
		}
		if (parts.length === 1 && method === "POST" && parts[0] === "scan") {
			const input = object(await body(request), ["kinds", "projectCwds"]);
			const kinds = input.kinds === undefined ? undefined : array(input.kinds, (kind) => choice(kind, KINDS), 5);
			const projects = input.projectCwds === undefined ? undefined : array(input.projectCwds, (cwd) => cwd, 30);
			const projectCwds =
				projects === undefined
					? undefined
					: await Promise.all(projects.map((cwd) => sourceDirectory(cwd, knownWorkspace)));
			return reply(response, 200, await service.scan({ kinds, projectCwds }));
		}
		if (parts.length === 1 && method === "POST" && parts[0] === "preview") {
			const input = object(await body(request), [
				"candidateId",
				"target",
				"action",
				"targetName",
				"includeSensitiveValues",
			]);
			const preview: MigrationPreviewRequest = { candidateId: id(input.candidateId) };
			if (input.target !== undefined) preview.target = await target(input.target);
			if (input.action !== undefined) preview.action = choice(input.action, ACTIONS);
			if (input.targetName !== undefined) preview.targetName = text(input.targetName, 255);
			if (input.includeSensitiveValues !== undefined) {
				if (typeof input.includeSensitiveValues !== "boolean") fail();
				preview.includeSensitiveValues = input.includeSensitiveValues;
			}
			return reply(response, 200, await service.preview(preview));
		}
		if (parts.length === 1 && method === "POST" && parts[0] === "plans") {
			const input = object(await body(request), ["selections"]);
			return reply(response, 200, await service.plan(array(input.selections, selection, 200)));
		}
		if (parts.length === 2 && method === "POST" && parts[0] === "recoveries") {
			if (parts[1] === "preview") {
				const input = object(await body(request), ["jobId", "itemId"]);
				return reply(response, 200, await service.previewRecovery(id(input.jobId), id(input.itemId)));
			}
			if (parts[1] === "apply") return reply(response, 200, await service.recover(selection(await body(request))));
		}
		if (parts.length === 1 && method === "GET" && !["scan", "preview", "plans", "recoveries"].includes(parts[0]!))
			return reply(response, 200, await service.getJob(id(parts[0])));
		if (parts.length === 2 && parts[1] === "cancel" && method === "POST") {
			object(await body(request, true), []);
			return reply(response, 200, await service.cancel(id(parts[0])));
		}
		fail("migration-route-not-found", 404);
	} catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		const code = error instanceof MigrationServiceError ? error.code : "migration-unavailable";
		reply(response, error instanceof MigrationServiceError ? error.status : 503, { error: code, code });
	}
}
