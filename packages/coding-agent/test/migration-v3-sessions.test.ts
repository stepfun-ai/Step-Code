import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";
import { MigrationService } from "../src/step/migration/service.ts";

let home: string;
let agent: string;
let service: MigrationService;
let sessions: SessionImportService;
const put = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};
function history(id: string, cwd?: string, ageDays = 0) {
	const path = join(home, ".claude", "projects", "history", `${id}.jsonl`);
	put(
		path,
		JSON.stringify({
			type: "user",
			sessionId: id,
			...(cwd ? { cwd } : {}),
			uuid: id,
			timestamp: "2026-01-01T00:00:00Z",
			message: { role: "user", content: "Readable historical content" },
		}) + "\n",
	);
	const date = new Date(Date.now() - ageDays * 86400000);
	utimesSync(path, date, date);
}
async function complete(preview: Awaited<ReturnType<MigrationService["preview"]>>) {
	const plan = await service.plan([{ previewId: preview.id, acknowledged: [] }]);
	const started = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: `test-${preview.id}` });
	await expect.poll(() => service.getJob(started.id).status).toMatch(/^(completed|cancelled|interrupted)$/u);
	return service.getJob(started.id);
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "migration-v3-")));
	agent = join(home, ".stepcode", "agent");
	sessions = new SessionImportService({ agentDir: agent });
	service = new MigrationService({
		agentDir: agent,
		env: { HOME: home, USERPROFILE: home, STEP_CODING_AGENT_DIR: agent },
		sessions,
	});
});
afterEach(async () => {
	await service.close();
	await sessions.close();
	rmSync(home, { recursive: true, force: true });
});
it("previews history using an existing original workspace without requiring registration", async () => {
	const cwd = join(home, "original");
	mkdirSync(cwd);
	history("one", cwd);
	const scan = await service.scan({ kinds: ["sessions"] });
	const preview = await service.preview({ candidateId: scan.candidates[0]!.id });
	expect(preview.sourceText).toContain("Readable historical content");
	expect(preview.target.scope).toEqual({ kind: "project", cwd });
	expect(preview.blockers).toEqual([]);
	expect(existsSync(join(home, ".stepcode", "workspaces.json"))).toBe(false);
});
it.each(["missing", "unknown"])(
	"keeps %s-workspace history readable and blocks writes until a target is chosen",
	async (kind) => {
		history("one", kind === "missing" ? join(home, "removed") : undefined);
		const scan = await service.scan({ kinds: ["sessions"] });
		expect(scan.candidates).toHaveLength(1);
		const preview = await service.preview({ candidateId: scan.candidates[0]!.id });
		expect(preview.sourceText).toContain("Readable historical content");
		expect(preview.blockers).toContainEqual({
			code: kind === "missing" ? "session-original-directory-missing" : "session-workspace-not-recorded",
		});
		await expect(service.plan([{ previewId: preview.id, acknowledged: [] }])).rejects.toThrow("migration-blocked");
		const cwd = join(home, "chosen");
		mkdirSync(cwd);
		const valid = await service.preview({ candidateId: scan.candidates[0]!.id, target: { kind: "project", cwd } });
		expect(valid.blockers).toEqual([]);
	},
);
it("reports a bounded record count without changing discovery or preview", async () => {
	history("one", join(home, "original"));
	history("two", join(home, "original"), 2);
	// A second record in one source must be counted, not assumed.
	const longer = join(home, ".claude", "projects", "history", "one.jsonl");
	writeFileSync(
		longer,
		`${readFileSync(longer, "utf8")}${JSON.stringify({ type: "assistant", sessionId: "one", uuid: "a", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Second record" }] } })}\n`,
	);
	const scan = await service.scan({ kinds: ["sessions"] });
	const counts = new Map(scan.candidates.map((c) => [c.name, c.messageCount]));
	expect(counts.get("Readable historical content")).toBe(1);
	expect(scan.candidates.every((c) => c.messageCountCapped !== true)).toBe(true);
	const [withTwo] = scan.candidates.filter((c) => c.messageCount === 2);
	expect(withTwo, "the longer source must report two records").toBeDefined();
	const preview = await service.preview({ candidateId: withTwo!.id });
	expect(preview.sourceText).toContain("Readable historical content");
	expect(typeof preview.candidate.messageCount).toBe("number");
	expect(preview.candidate.messageCount).toBeGreaterThan(0);
	expect(scan.truncated).toBe(false);
});

it("never offers an already imported session again", async () => {
	const cwd = join(home, "original");
	mkdirSync(cwd);
	history("one", cwd);
	const first = await service.scan({ kinds: ["sessions"] });
	const preview = await service.preview({ candidateId: first.candidates[0]!.id });
	const plan = await service.plan([{ previewId: preview.id, acknowledged: [] }]);
	const started = await service.start({ planId: plan.id, digest: plan.digest, idempotencyKey: "dedupe-1" });
	await expect.poll(() => service.getJob(started.id).status).toMatch(/^(completed|cancelled|interrupted)$/u);
	const firstJob = service.getJob(started.id);
	expect(firstJob.items[0]?.status).toBe("imported");
	const second = await service.scan({ kinds: ["sessions"] });
	const again = second.candidates.find((c) => c.sourceSessionId === "one");
	expect(again, "the imported source must still be listed").toBeDefined();
	expect(again!.needsMigration).toBe(false);
	expect(again!.holding).toBe("stepcode");
	expect(again!.diagnostics).toContainEqual({ code: "session-already-imported" });
	// The UI only offers actionable candidates, so an imported source is never re-selected there.
	// An explicit API re-import still reports the existing target instead of writing a duplicate.
	const existing = await service.scan({ kinds: ["sessions"] });
	const existingCandidate = existing.candidates.find((c) => c.sourceSessionId === "one")!;
	expect(existingCandidate.needsMigration).toBe(false);
	const reimport = await service.preview({
		candidateId: existingCandidate.id,
		target: { kind: "project", cwd },
	});
	const rejob = await complete(reimport);
	expect(rejob.items[0]?.status).not.toBe("imported");
	expect(rejob.items[0]?.actualTarget?.path ?? rejob.items[0]?.requestedTarget.path).toBe(
		firstJob.items[0]?.actualTarget?.path,
	);
});

it("distinguishes a partially readable source from an unreadable one", async () => {
	const cwd = join(home, "original");
	mkdirSync(cwd);
	history("one", cwd);
	// A second, unreadable record in the same source must not make the whole source "unreadable".
	writeFileSync(join(home, ".claude", "projects", "history", "broken.jsonl"), "{ not json");
	const scan = await service.scan({ kinds: ["sessions"] });
	const claude = scan.sources.find((s) => s.source === "claude-code");
	expect(claude?.status).toBe("partial");
	expect(claude?.diagnostics).toContainEqual({ code: "session-source-read-error", count: 1 });
	expect(scan.candidates.some((c) => c.sourceSessionId === "one")).toBe(true);
	const onlyBroken = await service.scan({ kinds: ["sessions"] });
	expect(onlyBroken.sources.find((s) => s.source === "claude-code")?.status).toBe("partial");
});

it("dedupes a session written through the legacy import path", async () => {
	const cwd = join(home, "legacy");
	mkdirSync(cwd);
	history("legacy-one", cwd);
	const scanned = await sessions.scan({ claudeRoot: join(home, ".claude", "projects") });
	const target = scanned.candidates.find((c) => c.sessionId === "legacy-one");
	expect(target).toBeDefined();
	const reviewed = await sessions.preview(target!.id);
	const legacy = await sessions.start([{ candidateId: target!.id, fingerprint: reviewed.fingerprint, cwd }]);
	await expect
		.poll(async () => (await sessions.getJob(legacy.id)).status)
		.toMatch(/^(completed|cancelled|interrupted)$/u);
	expect((await sessions.getJob(legacy.id)).results[0]?.status).not.toBe("failed");
	const migrated = await service.scan({ kinds: ["sessions"] });
	const again = migrated.candidates.find((c) => c.sourceSessionId === "legacy-one");
	expect(again).toBeDefined();
	expect(again!.needsMigration).toBe(false);
	expect(again!.diagnostics).toContainEqual({ code: "session-already-imported" });
});

it("applies all-source time range before global result limits without hiding incomplete scans", async () => {
	for (let i = 0; i < 36; i++) history(`one-${i}`, join(home, "original"), i);
	const seven = await service.scan({ kinds: ["sessions"], sessionOptions: { range: "7", limit: 100 } });
	expect(seven.candidates.length).toBe(7);
	const capped = await service.scan({ kinds: ["sessions"], sessionOptions: { range: "all", limit: 30 } });
	expect(capped.candidates.length).toBe(30);
	expect(capped.truncated).toBe(false);
});

it("creates an explicitly requested missing workspace folder as the session destination", async () => {
	history("one", join(home, "removed"));
	const scan = await service.scan({ kinds: ["sessions"] });
	const blocked = await service.preview({ candidateId: scan.candidates[0]!.id });
	expect(blocked.blockers).toContainEqual({ code: "session-original-directory-missing" });
	mkdirSync(join(home, "Documents"));
	const created = join(home, "Documents", "NewFolder");
	expect(existsSync(created)).toBe(false);
	const preview = await service.preview({
		candidateId: scan.candidates[0]!.id,
		target: { kind: "project", cwd: created, create: true },
	});
	expect(existsSync(created)).toBe(true);
	expect(preview.target.scope).toEqual({ kind: "project", cwd: created });
	expect(preview.blockers).toEqual([]);
	const job = await complete(preview);
	expect(job.items[0]?.status).toBe("imported");
	// Creation is bounded to one level under an existing directory: a missing parent
	// never creates anything and surfaces as a target blocker instead.
	const refused = await service.preview({
		candidateId: scan.candidates[0]!.id,
		target: { kind: "project", cwd: join(home, "no-such-parent", "child"), create: true },
	});
	expect(existsSync(join(home, "no-such-parent"))).toBe(false);
	expect(refused.blockers).toContainEqual({ code: "session-target-unavailable" });
});
