import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	completeWorkspaceFiles,
	containedWorkspacePath,
	listDirectory,
	MAX_FILE_COMPLETIONS,
	MAX_IMAGE_BYTES,
	MAX_PREVIEW_BYTES,
	readLocalFile,
	readWorkspaceFile,
	searchWorkspaceFiles,
} from "../src/files.ts";

test("@ completion lists root/child directories and searches scoped names with fuzzy matching", async () => {
	const { root, cleanup } = await workspace();
	try {
		const top = await completeWorkspaceFiles(root, "");
		assert.ok(top.entries.some((entry) => entry.path === "src" && entry.kind === "directory"));
		assert.ok(top.entries.some((entry) => entry.path === "README.md"));
		assert.ok(!top.entries.some((entry) => entry.path === "src/app.ts"));
		assert.equal(top.truncated, false);
		assert.deepEqual((await completeWorkspaceFiles(root, "./src/")).entries.map((entry) => entry.path),
			["src/nested", "src/app.ts"]);
		assert.deepEqual((await completeWorkspaceFiles(root, "src\\APP")).entries.map((entry) => entry.path),
			["src/app.ts", "src/nested/deep-app.ts"]);
		assert.deepEqual((await completeWorkspaceFiles(root, "dap")).entries.map((entry) => entry.path),
			["src/nested/deep-app.ts"]);
		assert.deepEqual((await completeWorkspaceFiles(root, "not-a-file")).entries, []);
		await mkdir(join(root, "notes space"));
		await writeFile(join(root, "notes space", "中文 note.md"), "notes");
		assert.equal((await completeWorkspaceFiles(root, "notes space/中文")).entries[0].path, "notes space/中文 note.md");
	} finally {
		await cleanup();
	}
});

test("@ completion ranks before cutting results and skips recursive dependency/build folders", async () => {
	const { root, cleanup } = await workspace();
	try {
		await Promise.all(Array.from({ length: MAX_FILE_COMPLETIONS + 5 }, (_, index) =>
			writeFile(join(root, `target-${index}.txt`), "candidate")));
		await writeFile(join(root, "src", "nested", "target"), "exact match");
		const limited = await completeWorkspaceFiles(root, "target");
		assert.equal(limited.entries[0].path, "src/nested/target");
		assert.equal(limited.entries.length, MAX_FILE_COMPLETIONS);
		assert.equal(limited.truncated, true);
		await mkdir(join(root, "dist"));
		await writeFile(join(root, "dist", "app.js"), "compiled");
		const matches = await completeWorkspaceFiles(root, "app");
		assert.ok(matches.entries.every((entry) => !entry.path.startsWith("node_modules/") && !entry.path.startsWith("dist/")));
		assert.deepEqual((await completeWorkspaceFiles(root, "dist/")).entries.map((entry) => entry.path), ["dist/app.js"]);
		// Directory listings are live, not cached from the first request.
		await writeFile(join(root, "src", "new.ts"), "new");
		assert.ok((await completeWorkspaceFiles(root, "src/")).entries.some((entry) => entry.path === "src/new.ts"));
	} finally {
		await cleanup();
	}
});

test("@ completion rejects escapes and unrepresentable paths and omits outside/dangling symlinks", async () => {
	const { root, outside, cleanup } = await workspace();
	try {
		for (const query of ["../outside/", "/etc/", "~/", "C:\\Users\\", "src/../", 'a"b', "a\nb", "x".repeat(1025)]) {
			await assert.rejects(completeWorkspaceFiles(root, query), /outside|Invalid/);
		}
		await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		await symlink(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		await symlink(join(root, "missing"), join(root, "dangling"), process.platform === "win32" ? "junction" : "dir");
		assert.ok((await completeWorkspaceFiles(root, "")).entries.every((entry) => !["escape", "dangling"].includes(entry.path)));
		await assert.rejects(completeWorkspaceFiles(root, "escape/"), /outside/);
		assert.ok((await completeWorkspaceFiles(root, "alias/")).entries.some((entry) => entry.path === "alias/app.ts"));
		assert.deepEqual((await completeWorkspaceFiles(root, "secret")).entries, []);
		if (process.platform !== "win32") {
			await writeFile(join(root, 'bad"name.txt'), "bad quote");
			await writeFile(join(root, "bad\nname.txt"), "bad line break");
			assert.ok((await completeWorkspaceFiles(root, "bad")).entries.every((entry) => !entry.path.includes('"') && !entry.path.includes("\n")));
		}
	} finally {
		await cleanup();
	}
});

test("@ completion cancellation stops a request before it can return candidates", async () => {
	const { root, cleanup } = await workspace();
	try {
		const before = new AbortController();
		before.abort();
		await assert.rejects(completeWorkspaceFiles(root, "app", before.signal), { name: "AbortError" });
		const during = new AbortController();
		const pending = completeWorkspaceFiles(root, "app", during.signal);
		during.abort();
		await assert.rejects(pending, { name: "AbortError" });
	} finally {
		await cleanup();
	}
});

test("@ completion streams a huge directory within its budget and closes handles on cancellation", () => {
	// An isolated process replaces only filesystem discovery; the actual completion
	// code must not call readdir or materialize/sort all 60 000 entries first.
	const source = new URL("../src/files.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import fs from "node:fs/promises";
		import { syncBuiltinESMExports } from "node:module";
		let read = 0, closed = 0, cancel = null;
		fs.realpath = async path => path;
		fs.readdir = async () => { throw new Error("Unbounded directory read"); };
		fs.opendir = async () => ({ async *[Symbol.asyncIterator]() {
			try {
				for (let index = 0; index < 60000; index++) {
					read++;
					if (cancel && index === 5) cancel.abort();
					yield { name: "entry-" + index + ".txt", isDirectory: () => false,
						isSymbolicLink: () => false, isFile: () => true };
				}
			} finally { closed++; }
		} });
		syncBuiltinESMExports();
		const { completeWorkspaceFiles } = await import(${JSON.stringify(source)});
		const limited = await completeWorkspaceFiles("/fixture", "entry");
		const count = read;
		read = 0;
		cancel = new AbortController();
		let aborted = "";
		try { await completeWorkspaceFiles("/fixture", "entry", cancel.signal); }
		catch (error) { aborted = error.name; }
		console.log(JSON.stringify({ count, candidates: limited.entries.length,
			truncated: limited.truncated, aborted, readAfterCancel: read, closed }));
	`], { encoding: "utf8", timeout: 10_000, cwd: fileURLToPath(new URL("..", import.meta.url)) });
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
	const report = JSON.parse(child.stdout);
	assert.ok(report.count <= 20_001, JSON.stringify(report));
	assert.equal(report.candidates, MAX_FILE_COMPLETIONS);
	assert.equal(report.truncated, true);
	assert.equal(report.aborted, "AbortError");
	assert.equal(report.readAfterCancel, 6);
	assert.equal(report.closed, 2, "both budget exhaustion and cancellation close the directory iterator");
});

async function workspace(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-files-"));
	const root = join(base, "workspace");
	const outside = join(base, "outside");
	await mkdir(join(root, "src", "nested"), { recursive: true });
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(root, "README.md"), "# hello\n");
	await writeFile(join(root, ".gitignore"), "dist\n");
	await writeFile(join(root, "src", "app.ts"), "export const answer = 42;\n");
	await writeFile(join(root, "src", "nested", "deep-app.ts"), "export {};\n");
	await writeFile(join(root, "node_modules", "pkg", "app.js"), "module.exports = {};\n");
	await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFile(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	await writeFile(join(outside, "secret.txt"), "secret\n");
	return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("a directory lists one level, directories first, dotfiles included", async () => {
	const { root, cleanup } = await workspace();
	try {
		const top = await listDirectory(root, "");
		assert.deepEqual(
			top.entries.map((entry) => `${entry.kind}:${entry.path}`),
			[
				"directory:node_modules",
				"directory:src",
				"file:.gitignore",
				"file:blob.bin",
				"file:logo.png",
				"file:README.md",
			],
		);
		assert.equal(top.truncated, false);
		const nested = await listDirectory(root, "src");
		assert.deepEqual(
			nested.entries.map((entry) => entry.path),
			["src/nested", "src/app.ts"],
		);
	} finally {
		await cleanup();
	}
});

test("paths that leave the workspace are refused, including through a symlink", async () => {
	const { root, outside, cleanup } = await workspace();
	try {
		await assert.rejects(containedWorkspacePath(root, "../outside/secret.txt"), /outside the workspace/);
		await assert.rejects(readWorkspaceFile(root, join(outside, "secret.txt")), /outside the workspace/);
		await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(listDirectory(root, "escape"), /outside the workspace/);
		await assert.rejects(readWorkspaceFile(root, "escape/secret.txt"), /outside the workspace/);
		// A sibling whose name merely starts with the workspace name is still outside.
		await assert.rejects(containedWorkspacePath(root, "../workspace-other"), /./);
	} finally {
		await cleanup();
	}
});

test("a file is classified as text, image, binary or too large", async () => {
	const { root, cleanup } = await workspace();
	try {
		assert.deepEqual(await readWorkspaceFile(root, "src/app.ts"), {
			kind: "text",
			path: "src/app.ts",
			size: 26,
			content: "export const answer = 42;\n",
		});
		assert.deepEqual(await readWorkspaceFile(root, "logo.png"), {
			kind: "image",
			path: "logo.png",
			size: 4,
			mimeType: "image/png",
		});
		assert.equal((await readWorkspaceFile(root, "blob.bin")).kind, "binary");
		await writeFile(join(root, "big.log"), "x".repeat(MAX_PREVIEW_BYTES + 1));
		const big = await readWorkspaceFile(root, "big.log");
		assert.equal(big.kind, "too-large");
		assert.equal("content" in big, false);
		// An image over the raw limit is "too large", not a preview that would
		// render as a broken image: the client shows the reason instead.
		await writeFile(join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x50));
		const huge = await readWorkspaceFile(root, "huge.png");
		assert.equal(huge.kind, "too-large");
		assert.equal("mimeType" in huge, false);
		await assert.rejects(readWorkspaceFile(root, "src"), /not a file/);
	} finally {
		await cleanup();
	}
});

test("local reads name any absolute file while workspace containment stays intact", async () => {
	const { root, outside, cleanup } = await workspace();
	try {
		await writeFile(join(outside, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const realOutside = (await realpath(outside)).split(sep).join("/");
		assert.deepEqual(await readLocalFile(join(outside, "secret.txt")), {
			kind: "text",
			path: `${realOutside}/secret.txt`,
			size: 7,
			content: "secret\n",
		});
		const chart = await readLocalFile(join(outside, "chart.png"));
		assert.equal(chart.kind, "image");
		assert.equal(chart.mimeType, "image/png");
		// Only absolute references are accepted; anything else is a client mistake.
		for (const input of ["secret.txt", "relative/secret.txt", "", "../outside/secret.txt"])
			await assert.rejects(readLocalFile(input), /absolute/);
		await assert.rejects(readLocalFile(join(outside, "missing.md")), /ENOENT/);
		await assert.rejects(readLocalFile(outside), /not a file/);
		// The workspace routes keep their own boundary; local reads do not widen it.
		await assert.rejects(readWorkspaceFile(root, join(outside, "secret.txt")), /outside the workspace/);
		await assert.rejects(containedWorkspacePath(root, join(outside, "secret.txt")), /outside the workspace/);
	} finally {
		await cleanup();
	}
});

test("search matches names at any depth but does not descend into node_modules", async () => {
	const { root, cleanup } = await workspace();
	try {
		const found = await searchWorkspaceFiles(root, "APP");
		assert.deepEqual(
			found.entries.map((entry) => entry.path),
			["src/app.ts", "src/nested/deep-app.ts"],
		);
		assert.equal(found.truncated, false);
		assert.deepEqual((await searchWorkspaceFiles(root, "  ")).entries, []);
		const limited = await searchWorkspaceFiles(root, "app", 1);
		assert.equal(limited.entries.length, 1);
		assert.equal(limited.truncated, true);
		// The directory itself is still a match; only its contents are skipped.
		assert.deepEqual(
			(await searchWorkspaceFiles(root, "node_mod")).entries.map((entry) => entry.kind),
			["directory"],
		);
	} finally {
		await cleanup();
	}
});
