import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImportService } from "../src/core/session-import/service.ts";

const ioHooks = vi.hoisted(() => {
	const hooks: { beforeStat?: () => void; beforeLink?: () => void } = {};
	return hooks;
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: (...args: Parameters<typeof actual.lstat>) => {
			ioHooks.beforeStat?.();
			return actual.lstat(...args);
		},
		link: (...args: Parameters<typeof actual.link>) => {
			ioHooks.beforeLink?.();
			return actual.link(...args);
		},
	};
});

const fixtures: { root: string; service: SessionImportService }[] = [];
afterEach(async () => {
	delete ioHooks.beforeStat;
	delete ioHooks.beforeLink;
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "step-import-reserve-")));
	const cwd = join(root, "project");
	const sourceRoot = join(root, "source");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(sourceRoot);
	const source = join(sourceRoot, "rollout-fixture.jsonl");
	await writeFile(
		source,
		[
			{ type: "session_meta", payload: { id: "reserve-source", cwd } },
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Reviewed work" }] },
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	const persisted: string[] = [];
	const service = new SessionImportService({ agentDir, onPersisted: (event) => persisted.push(event.path) });
	fixtures.push({ root, service });
	const scan = await service.scan({ customRoot: sourceRoot });
	const candidate = scan.candidates.find((item) => item.source === "codex");
	if (!candidate) throw new Error("Fixture session not found");
	const preview = await service.preview(candidate.id);
	return {
		root,
		cwd,
		source,
		agentDir,
		service,
		persisted,
		selection: {
			candidateId: preview.id,
			fingerprint: preview.fingerprint,
			cwd,
		},
	};
}

function only<T>(items: T[]): T {
	if (items.length !== 1) throw new Error("Expected exactly one prepared session");
	return items[0]!;
}

describe("reserved offline session publication", () => {
	it("prepares immutable bytes without creating files or nested jobs", async () => {
		const f = await setup();
		const before = await readdir(f.root);
		const reservation = await f.service.reserve([f.selection]);
		try {
			const item = only(reservation.items);
			expect(await readdir(f.root)).toEqual(before);
			expect(await f.service.listJobs()).toEqual([]);
			await writeFile(f.source, "source changed after review");
			const [one, two] = await Promise.all([item.publish(), item.publish()]);
			expect(one).toEqual(two);
			expect(one.status).toBe("imported");
			const bytes = await readFile(item.path);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.fingerprint);
			expect(bytes.toString()).toContain("Reviewed work");
			expect(f.persisted).toEqual([item.path]);
		} finally {
			reservation.release();
		}
	});

	it("pins a reviewed snapshot until the owner releases it", async () => {
		const f = await setup();
		const reservation = await f.service.reserve([f.selection]);
		try {
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * 60 * 1000);
			await f.service.scan({ customRoot: join(f.root, "absent") });
			expect((await only(reservation.items).publish()).status).toBe("imported");
		} finally {
			reservation.release();
		}
	});

	it("reports the existing target cwd without changing the legacy requested-cwd result", async () => {
		const f = await setup();
		const first = await f.service.reserve([f.selection]);
		const item = only(first.items);
		await item.publish();
		first.release();
		const continued = `${await readFile(item.path, "utf8")}${JSON.stringify({ type: "custom", customType: "native-note", data: "continued" })}\n`;
		await writeFile(item.path, continued);
		const other = join(f.root, "other");
		await mkdir(other);
		const second = await f.service.reserve([{ ...f.selection, cwd: other }]);
		try {
			const existing = only(second.items);
			expect(existing.existing?.cwd).toBe(f.cwd);
			expect(existing.fingerprint).toBe(createHash("sha256").update(continued).digest("hex"));
			expect(await existing.publish()).toMatchObject({ status: "skipped", cwd: other });
			expect(await readFile(item.path, "utf8")).toBe(continued);
		} finally {
			second.release();
		}
	});

	it("identifies the winning target after concurrent reservations of the same snapshot", async () => {
		const f = await setup();
		const other = join(f.root, "other");
		await mkdir(other);
		const first = await f.service.reserve([f.selection]);
		const second = await f.service.reserve([{ ...f.selection, cwd: other }]);
		try {
			expect(only(second.items).existing).toBeUndefined();
			await only(first.items).publish();
			expect((await only(second.items).publish()).status).toBe("skipped");
			expect(only(second.items).existing?.cwd).toBe(f.cwd);
		} finally {
			first.release();
			second.release();
		}
	});

	it("does not accept a pre-existing unrelated file as a successful import", async () => {
		const f = await setup();
		const reservation = await f.service.reserve([f.selection]);
		try {
			const item = only(reservation.items);
			await mkdir(dirname(item.path), { recursive: true });
			await writeFile(item.path, "not a native session");
			await expect(item.publish()).rejects.toThrow(/valid session/i);
			expect(await readFile(item.path, "utf8")).toBe("not a native session");
			expect(f.persisted).toEqual([]);
		} finally {
			reservation.release();
		}
	});

	it("refuses target-file and imported-directory links", async () => {
		const f = await setup();
		const reservation = await f.service.reserve([f.selection]);
		const item = only(reservation.items);
		await mkdir(dirname(item.path), { recursive: true });
		const external = join(f.root, "external-file");
		await writeFile(external, "must not change");
		await symlink(external, item.path);
		try {
			await expect(item.publish()).rejects.toThrow(/cannot be verified/i);
			expect(await readFile(external, "utf8")).toBe("must not change");
		} finally {
			reservation.release();
		}
		await rm(dirname(item.path), { recursive: true });
		const outside = join(f.root, "outside");
		await mkdir(outside);
		await symlink(outside, dirname(item.path), "dir");
		await expect(f.service.reserve([f.selection])).rejects.toThrow(/Invalid import directory/);
		expect(await readdir(outside)).toEqual([]);
	});

	it("settles an in-flight release without starting a later filesystem mutation", async () => {
		const f = await setup();
		const reservation = await f.service.reserve([f.selection]);
		let release: Promise<void> | undefined;
		ioHooks.beforeStat = () => {
			delete ioHooks.beforeStat;
			release = Promise.resolve(reservation.release());
		};
		const publishing = only(reservation.items).publish();
		await expect(publishing).rejects.toThrow(/released|no longer active/i);
		await release;
		expect(await readdir(f.root)).not.toContain("agent");
		expect(f.persisted).toEqual([]);
	});

	it("awaits a publication that already crossed its atomic commit point", async () => {
		const f = await setup();
		const reservation = await f.service.reserve([f.selection]);
		let release: Promise<void> | undefined;
		let released = false;
		ioHooks.beforeLink = () => {
			delete ioHooks.beforeLink;
			release = Promise.resolve(reservation.release()).then(() => {
				released = true;
				expect(f.persisted).toHaveLength(1);
			});
			expect(released).toBe(false);
		};
		const result = await only(reservation.items).publish();
		await release;
		expect(released).toBe(true);
		expect(result.status).toBe("imported");
		expect(f.persisted).toEqual([only(reservation.items).path]);
	});

	it("rejects publication after release or shutdown without writing a target", async () => {
		const f = await setup();
		const released = await f.service.reserve([f.selection]);
		released.release();
		released.release();
		await expect(only(released.items).publish()).rejects.toThrow(/released/i);
		const reserved = await f.service.reserve([f.selection]);
		await f.service.close();
		await expect(only(reserved.items).publish()).rejects.toThrow(/closed/i);
		reserved.release();
		expect(await readdir(f.root)).not.toContain("agent");
	});
});
