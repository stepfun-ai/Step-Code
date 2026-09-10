import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepToolDefinition, type GrepSearchResult } from "../src/core/tools/grep.ts";

// Force selectSearchBackend to fall through past ripgrep. `commandExists` stays
// live so the ladder can still find `git` / `grep` on the developer machine.
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
	// -c switches keep the repo self-contained: no signing prompts, no reliance
	// on the developer's global user.name/user.email.
	const result = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir, stdio: "pipe" });
	if (result.status !== 0) throw new Error(`git init failed: ${result.stderr?.toString() ?? "unknown"}`);
	spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "root"], {
		cwd: dir,
		stdio: "pipe",
	});
}

async function runGrep(
	dir: string,
	args: Record<string, unknown>,
	options?: Parameters<typeof createGrepToolDefinition>[1],
) {
	const def = createGrepToolDefinition(dir, options);
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

describe("grep fallback", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	describe("git grep backend (git worktree)", () => {
		beforeEach(() => {
			dir = makeTmpDir("grep-fb-git-");
			initGitRepo(dir);
			mkdirSync(path.join(dir, "src"), { recursive: true });
			writeFileSync(path.join(dir, "src", "a.ts"), "export const marker = 42;\n");
			writeFileSync(path.join(dir, "src", "b.ts"), "// nothing to see here\n");
			writeFileSync(path.join(dir, "README.md"), "MARKER on line one\n");
		});

		it("returns matches via git grep and reports the backend name", async () => {
			const result = await runGrep(dir, { pattern: "marker" });
			expect(result.details?.backend).toBe("git-grep");
			const text = firstText(result);
			expect(text).toContain("src/a.ts");
			expect(text).toContain("marker");
			expect(text).not.toContain("README.md"); // case-sensitive by default
		});

		it("honors ignoreCase", async () => {
			const result = await runGrep(dir, { pattern: "marker", ignoreCase: true });
			const text = firstText(result);
			expect(text).toContain("src/a.ts");
			expect(text).toContain("README.md");
		});

		it("honors literal (fixed-strings) so regex metacharacters are ignored", async () => {
			writeFileSync(path.join(dir, "raw.txt"), "a[b\n");
			const result = await runGrep(dir, { pattern: "a[b", literal: true });
			// Without --fixed-strings, `a[b` is an invalid regex; treating as literal must return the match.
			expect(firstText(result)).toContain("raw.txt");
		});

		it("scopes results by glob pathspec", async () => {
			const result = await runGrep(dir, { pattern: "marker", glob: "**/*.md", ignoreCase: true });
			const text = firstText(result);
			expect(text).toContain("README.md");
			expect(text).not.toContain("src/a.ts");
		});
	});

	describe("POSIX grep backend (non-git directory)", () => {
		beforeEach(() => {
			dir = makeTmpDir("grep-fb-posix-");
			mkdirSync(path.join(dir, "pkg"), { recursive: true });
			writeFileSync(path.join(dir, "pkg", "one.py"), "needle = 1\n");
			writeFileSync(path.join(dir, "pkg", "two.py"), "haystack = 0\n");
		});

		it("returns matches via POSIX grep and labels the backend", async () => {
			const result = await runGrep(dir, { pattern: "needle" });
			expect(result.details?.backend).toBe("grep");
			expect(firstText(result)).toContain("pkg/one.py");
		});

		it("post-filters by glob using minimatch even though grep --include is not passed", async () => {
			writeFileSync(path.join(dir, "notes.txt"), "needle in a haystack\n");
			const result = await runGrep(dir, { pattern: "needle", glob: "**/*.py" });
			const text = firstText(result);
			expect(text).toContain("pkg/one.py");
			expect(text).not.toContain("notes.txt");
		});
	});

	describe("custom search operation", () => {
		beforeEach(() => {
			dir = makeTmpDir("grep-fb-custom-");
			writeFileSync(path.join(dir, "seed.txt"), "this file exists but the custom op will not read it\n");
		});

		it("wins over every built-in backend and its result flows through unchanged", async () => {
			const search = vi.fn(
				async (): Promise<GrepSearchResult> => ({
					matches: [{ filePath: path.join(dir, "virtual.txt"), lineNumber: 7, lineText: "synthetic\n" }],
					matchLimitReached: false,
				}),
			);
			const result = await runGrep(
				dir,
				{ pattern: "anything" },
				{
					operations: {
						isDirectory: () => true,
						readFile: () => "",
						search,
					},
				},
			);
			expect(result.details?.backend).toBe("custom");
			expect(search).toHaveBeenCalledOnce();
			expect(firstText(result)).toContain("virtual.txt");
			expect(firstText(result)).toContain("synthetic");
		});
	});
});
