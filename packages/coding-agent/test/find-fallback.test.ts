import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

// Force fd resolution to fail so selectFileListBackend walks the fallback ladder.
vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.ts")>();
	return {
		...actual,
		ensureTool: vi.fn().mockResolvedValue(undefined),
	};
});

function makeTmpDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
	const init = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir, stdio: "pipe" });
	if (init.status !== 0) throw new Error(`git init failed: ${init.stderr?.toString() ?? "unknown"}`);
	spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "root"], {
		cwd: dir,
		stdio: "pipe",
	});
}

async function runFind(
	dir: string,
	args: Record<string, unknown>,
	options?: Parameters<typeof createFindToolDefinition>[1],
) {
	const def = createFindToolDefinition(dir, options);
	// execute() requires 5 args (toolCallId, params, signal, onUpdate, ctx) even
	// though this tool ignores the last two.
	return def.execute("call-1", args as any, undefined, undefined, {} as any) as Promise<{
		content: Array<{ type: string; text?: string }>;
		details?: { backend?: string };
	}>;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.text ?? "";
}

describe("find fallback", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	describe("git ls-files backend (git worktree)", () => {
		beforeEach(() => {
			dir = makeTmpDir("find-fb-git-");
			initGitRepo(dir);
			mkdirSync(path.join(dir, "src"), { recursive: true });
			writeFileSync(path.join(dir, "src", "a.ts"), "");
			writeFileSync(path.join(dir, "src", "b.spec.ts"), "");
			writeFileSync(path.join(dir, "README.md"), "");
			// Untracked but not ignored: git ls-files -o --exclude-standard picks it up.
			writeFileSync(path.join(dir, "src", "c.ts"), "");
		});

		it("returns matches via git ls-files including untracked", async () => {
			const result = await runFind(dir, { pattern: "*.ts" });
			expect(result.details?.backend).toBe("git-ls");
			const text = firstText(result);
			expect(text).toContain("src/a.ts");
			expect(text).toContain("src/b.spec.ts");
			expect(text).toContain("src/c.ts");
			expect(text).not.toContain("README.md");
		});

		it("honors a path-containing glob (**/*.spec.ts)", async () => {
			const result = await runFind(dir, { pattern: "**/*.spec.ts" });
			const text = firstText(result);
			expect(text).toContain("src/b.spec.ts");
			expect(text).not.toContain("src/a.ts");
		});

		it("skips gitignored files", async () => {
			writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
			mkdirSync(path.join(dir, "dist"));
			writeFileSync(path.join(dir, "dist", "hidden.ts"), "");
			const result = await runFind(dir, { pattern: "*.ts" });
			expect(firstText(result)).not.toContain("dist/hidden.ts");
		});
	});

	describe("POSIX find backend (non-git directory)", () => {
		beforeEach(() => {
			dir = makeTmpDir("find-fb-posix-");
			mkdirSync(path.join(dir, "pkg"), { recursive: true });
			writeFileSync(path.join(dir, "pkg", "one.py"), "");
			writeFileSync(path.join(dir, "pkg", "two.py"), "");
			writeFileSync(path.join(dir, "README.txt"), "");
		});

		it("returns matches via POSIX find and post-filters via minimatch", async () => {
			const result = await runFind(dir, { pattern: "*.py" });
			expect(result.details?.backend).toBe("find");
			const text = firstText(result);
			expect(text).toContain("pkg/one.py");
			expect(text).toContain("pkg/two.py");
			expect(text).not.toContain("README.txt");
		});

		it("honors path-containing globs across directory boundaries", async () => {
			mkdirSync(path.join(dir, "a", "b"), { recursive: true });
			writeFileSync(path.join(dir, "a", "b", "deep.md"), "");
			const result = await runFind(dir, { pattern: "**/*.md" });
			expect(firstText(result)).toContain("a/b/deep.md");
		});
	});

	describe("custom glob operation", () => {
		beforeEach(() => {
			dir = makeTmpDir("find-fb-custom-");
			writeFileSync(path.join(dir, "seed.txt"), "");
		});

		it("wins over every built-in backend and its result flows through unchanged", async () => {
			const glob = vi.fn(async () => [path.join(dir, "virtual.md"), path.join(dir, "phantom.md")]);
			const result = await runFind(
				dir,
				{ pattern: "*.md" },
				{
					operations: {
						exists: () => true,
						glob,
					},
				},
			);
			expect(result.details?.backend).toBe("custom");
			expect(glob).toHaveBeenCalledOnce();
			const text = firstText(result);
			expect(text).toContain("virtual.md");
			expect(text).toContain("phantom.md");
			expect(text).not.toContain("seed.txt");
		});
	});
});
