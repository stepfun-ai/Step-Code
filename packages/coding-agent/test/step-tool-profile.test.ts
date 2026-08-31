import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepToolProfile, stepToolNames } from "../src/step/tool-profile.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("Step tool profile", () => {
	it("publishes the legacy Step tool names and schemas", () => {
		const tools = createStepToolProfile(process.cwd());
		expect(tools.map((tool) => tool.name)).toEqual([...stepToolNames]);
		expect(tools.map((tool) => tool.name)).not.toContain("read");
		expect(tools.map((tool) => tool.name)).not.toContain("bash");

		const read = tools.find((tool) => tool.name === "read_file")!;
		const readSchema = read.parameters as { required?: string[]; properties: Record<string, unknown> };
		expect(readSchema.required).toEqual(["path"]);
		expect(Object.keys(readSchema.properties)).toEqual(["path", "start_line", "end_line", "max_chars"]);

		const edit = tools.find((tool) => tool.name === "edit_file")!;
		const editSchema = edit.parameters as { required?: string[]; properties: Record<string, unknown> };
		expect(editSchema.required).toEqual(["path", "search", "replace"]);
		expect(Object.keys(editSchema.properties)).toEqual(["path", "search", "replace", "replace_all"]);
	});

	it("keeps the legacy model-facing descriptions byte-for-byte compatible", () => {
		const tools = createStepToolProfile(process.cwd());
		const expected: Record<string, { description: string; promptSnippet: string }> = {
			list_directory: {
				description: "List one directory with directories first. Prefer this before recursive shell listing.",
				promptSnippet: "List one directory with directories first",
			},
			find_files: {
				description:
					"Find files by glob pattern, sorted by modification time (newest first). Prefer this over shell find or recursive ls.",
				promptSnippet: "Find files by glob pattern",
			},
			search_files: {
				description:
					"Search file contents with a regular expression. Returns matching file paths, line numbers, and matched lines. Prefer this over shell grep.",
				promptSnippet: "Search file contents with a regular expression",
			},
			read_file: {
				description:
					"Read a text file with optional line range; image files (PNG/JPEG/GIF/WebP) are returned as attached images. Prefer this over shell cat for token efficiency.",
				promptSnippet: "Read a file with an optional line range",
			},
			write_file: {
				description:
					"Write full content to a file, creating parent directories if missing. Overwrites existing content — for existing files prefer edit_file.",
				promptSnippet: "Write full content to a file",
			},
			edit_file: {
				description:
					"Edit one file by literal search/replace. 'search' must match the current file content exactly and appear exactly once unless replace_all is true.",
				promptSnippet: "Make a precise literal search/replace edit",
			},
			run_command: {
				description:
					"Run a non-interactive shell command from the initial working directory by default. Use for tests, builds, formatters, git, and project scripts; prefer dedicated file/search tools for reading and searching.",
				promptSnippet: "Run a non-interactive shell command",
			},
			find_tools: {
				description:
					"Search registered tools by natural-language intent, tool name, description, and parameter names.",
				promptSnippet: "Find a tool by describing the operation you need",
			},
		};

		for (const toolName of stepToolNames) {
			const tool = tools.find((candidate) => candidate.name === toolName);
			expect(tool, toolName).toBeDefined();
			expect(tool).toMatchObject(expected[toolName]);
		}

		const properties = (toolName: string): Record<string, { description?: string }> => {
			const tool = tools.find((candidate) => candidate.name === toolName)!;
			return (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		};
		expect(properties("run_command").cwd?.description).toBe(
			"Working directory. Relative paths resolve from the initial working directory; absolute paths and ~/ home paths are accepted.",
		);
		expect(properties("read_file").path?.description).toBe(
			"File path. Relative paths resolve from the initial working directory; absolute paths and ~/ home paths are accepted.",
		);
	});

	it("can replace Pi's default active tools without changing the agent loop", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			const session = (
				await createAgentSession({
					cwd: root,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager: SettingsManager.inMemory(),
					sessionManager: SessionManager.inMemory(root),
					customTools: createStepToolProfile(root),
					noTools: "builtin",
				})
			).session;
			expect(session.getActiveToolNames()).toEqual([...stepToolNames]);
			expect(session.systemPrompt).toContain("- read_file:");
			expect(session.systemPrompt).toContain("- run_command:");
			expect(session.systemPrompt).not.toContain("- read:");
			session.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists directories using Step hidden filtering and directory-first ordering", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await mkdir(join(root, "z-dir"));
			await mkdir(join(root, "a-dir"));
			await writeFile(join(root, ".hidden"), "hidden");
			await writeFile(join(root, "b-file"), "file");
			const list = createStepToolProfile(root).find((tool) => tool.name === "list_directory")!;

			const hidden = await list.execute(
				"list",
				{ path: ".", max_entries: 20, include_hidden: false },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(hidden)).toContain("dir a-dir/");
			expect(text(hidden)).toContain("dir z-dir/");
			expect(text(hidden)).toContain("file b-file");
			expect(text(hidden)).not.toContain(".hidden");
			expect(text(hidden).indexOf("dir a-dir/")).toBeLessThan(text(hidden).indexOf("file b-file"));

			const all = await list.execute(
				"list",
				{ path: ".", include_hidden: true },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(all)).toContain("file .hidden");
			expect(all.details).toMatchObject({
				path: ".",
				returnedEntries: 4,
				totalEntries: 4,
				directories: 2,
				files: 2,
				truncated: false,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves CRLF and reports no-op writes", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			const filePath = join(root, "nested", "sample.txt");
			await mkdir(join(root, "nested"));
			await writeFile(filePath, "one\r\ntwo\r\n", "utf8");
			const write = createStepToolProfile(root).find((tool) => tool.name === "write_file")!;

			const noOp = await write.execute(
				"write-noop",
				{ path: "nested/sample.txt", content: "one\ntwo\n" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(noOp.details).toMatchObject({ changed: false, bytesWritten: 0 });
			expect(await readFile(filePath, "utf8")).toBe("one\r\ntwo\r\n");

			const changed = await write.execute(
				"write-change",
				{ path: "nested/sample.txt", content: "one\ntwo\nthree\n" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(changed.details).toMatchObject({ changed: true, charsWritten: 17 });
			expect(await readFile(filePath, "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("honors read_file line ranges and max_chars", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await writeFile(join(root, "sample.txt"), `${"x".repeat(250)}\nline two\nline three\n`);
			const read = createStepToolProfile(root).find((tool) => tool.name === "read_file")!;
			const result = await read.execute(
				"read",
				{ path: "sample.txt", start_line: 1, end_line: 3, max_chars: 200 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toContain("[Output truncated to 200 characters.]");
			expect(text(result).length).toBeGreaterThan(200);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps Step line numbers and explicit EOF warnings", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await writeFile(join(root, "sample.txt"), "one\ntwo\nthree\n");
			const read = createStepToolProfile(root).find((tool) => tool.name === "read_file")!;
			const result = await read.execute(
				"read",
				{ path: "sample.txt", start_line: 2, end_line: 99 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toContain("2: two");
			expect(text(result)).toContain("3: three");
			expect(text(result)).toContain("WARNING: requested end_line 99");
			expect((result.details as { rangeAdjusted?: boolean; warning?: string }).rangeAdjusted).toBe(true);
			expect((result.details as { warning?: string }).warning).toContain("clamped");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("sorts find_files by modification time after native discovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await writeFile(join(root, "old.ts"), "old");
			await writeFile(join(root, "new.ts"), "new");
			await utimes(join(root, "old.ts"), 1_000, 1_000);
			await utimes(join(root, "new.ts"), 2_000, 2_000);
			const find = createStepToolProfile(root).find((tool) => tool.name === "find_files")!;
			const result = await find.execute(
				"find",
				{ pattern: "*.ts", max_results: 10 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result).split("\n").slice(0, 2)).toEqual(["new.ts", "old.ts"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("maps search_files context into native grep output", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await writeFile(join(root, "sample.txt"), "before\ntarget\nafter\n");
			const search = createStepToolProfile(root).find((tool) => tool.name === "search_files")!;
			const result = await search.execute(
				"search",
				{ pattern: "target", path: ".", context_lines: 1 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toContain("sample.txt:2: target");
			expect(text(result)).toContain("sample.txt:1-");
			expect(text(result)).toContain("sample.txt:3-");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("implements edit_file replace_all while preserving the native edit path", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			const path = join(root, "sample.txt");
			await writeFile(path, "old\nold\nkeep\n");
			const edit = createStepToolProfile(root).find((tool) => tool.name === "edit_file")!;
			const result = await edit.execute(
				"edit",
				{ path: "sample.txt", search: "old", replace: "new", replace_all: true },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toContain("2 occurrence(s)");
			expect(await readFile(path, "utf8")).toBe("new\nnew\nkeep\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("maps find_tools queries onto the Step profile without exposing Pi names", async () => {
		const findTools = createStepToolProfile(process.cwd()).find((tool) => tool.name === "find_tools")!;
		const result = await findTools.execute(
			"find",
			{ query: "read file", limit: 5 },
			undefined,
			undefined,
			undefined as never,
		);
		const output = text(result);
		expect(output).toContain("read_file");
		expect(output).not.toContain("\nread\n");
	});
});
