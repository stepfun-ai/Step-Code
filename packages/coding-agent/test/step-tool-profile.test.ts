import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createStepToolProfile, stepToolNames } from "../src/step/tool-profile.ts";
import { stepModel } from "./utilities.ts";

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
			search_web: {
				description:
					"Search the web when the answer depends on current or external information: recent news, fresh documentation, live data, or anything outside built-in knowledge.\n\nThe tool returns compact structured results with markdown links.\n\nIf this tool informs the answer, end the response with a Sources: section containing the relevant result URLs as markdown links.",
				promptSnippet: "Search the web for current or external information",
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

	it("run_command run_in_background returns immediately with a pid and a streaming log", async () => {
		const tools = createStepToolProfile(process.cwd());
		const run = tools.find((tool) => tool.name === "run_command")!;
		const startedAt = Date.now();
		const result = await run.execute(
			"bg-1",
			{ command: "echo started; sleep 0.4; echo finished", run_in_background: true },
			undefined,
			undefined,
			undefined as never,
		);
		const details = result.details as { background: boolean; pid: number | null; logPath: string };
		try {
			// The tool call returns long before the command does.
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			expect(details.background).toBe(true);
			expect(details.pid).toBeGreaterThan(0);
			expect(text(result)).toContain(`pid ${details.pid}`);
			expect(text(result)).toContain(details.logPath);
			// Stop advice must target the whole process group, not just the wrapper (a bare
			// `kill <pid>` would orphan the real process). Unix uses `kill -TERM -<pid>`.
			const expectedStop =
				process.platform === "win32" ? `taskkill /F /T /PID ${details.pid}` : `kill -TERM -${details.pid}`;
			expect(text(result)).toContain(expectedStop);
			await expect
				.poll(async () => readFile(details.logPath, "utf8").catch(() => ""), { timeout: 5_000 })
				.toContain("finished");
		} finally {
			await rm(details.logPath, { force: true });
		}
	});

	it("can replace Pi's default active tools without changing the agent loop", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			const session = (
				await createAgentSession({
					cwd: root,
					model: stepModel(),
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

	it.each(
		["[slug]", "[...slug]", "[[...slug]]"].flatMap((route) =>
			[undefined, "routes"].flatMap((searchPath) =>
				[0, 1].map((contextLines) => ({ route, searchPath, contextLines })),
			),
		),
	)(
		"preserves $route matches from $searchPath with context $contextLines",
		async ({ route, searchPath, contextLines }) => {
			const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
			try {
				const searchRoot = searchPath ? join(root, searchPath) : root;
				await mkdir(join(searchRoot, route), { recursive: true });
				await mkdir(join(searchRoot, "static"), { recursive: true });
				await writeFile(join(searchRoot, route, "page.tsx"), "before\n// TODO dynamic route\nafter\n");
				await writeFile(join(searchRoot, "static", "page.tsx"), "// TODO static route\n");
				const search = createStepToolProfile(root).find((tool) => tool.name === "search_files")!;

				const result = await search.execute(
					"search-routes",
					{
						pattern: "TODO",
						...(searchPath ? { path: searchPath } : {}),
						...(contextLines ? { context_lines: contextLines } : {}),
					},
					undefined,
					undefined,
					undefined as never,
				);
				expect(text(result)).toContain(`${route}/page.tsx:2: // TODO dynamic route`);
				expect(text(result)).toContain("static/page.tsx:1: // TODO static route");
				if (contextLines > 0) {
					expect(text(result)).toContain(`${route}/page.tsx:1- before`);
					expect(text(result)).toContain(`${route}/page.tsx:3- after`);
				}
				expect(result.details).toMatchObject({
					matches: 2,
					filesMatched: 2,
					truncated: false,
					timedOut: false,
					stepTruncated: false,
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("keeps bracket-prefixed matches without counting native limit notices", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			await mkdir(join(root, "[slug]"));
			await writeFile(join(root, "[slug]", "page.tsx"), "TODO first\nTODO second\n");
			const search = createStepToolProfile(root).find((tool) => tool.name === "search_files")!;
			const result = await search.execute(
				"search-limited-route",
				{ pattern: "TODO", max_results: 1 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toBe("[slug]/page.tsx:1: TODO first");
			expect(result.details).toMatchObject({
				matchLimitReached: 1,
				matches: 1,
				filesMatched: 1,
				truncated: true,
				timedOut: false,
				stepTruncated: false,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps remote match paths that start with warning text", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			// A remote backend can return names that the local filesystem does not support.
			const content = "// TODO warning-prefixed file\n";
			const search = createStepToolProfile(root, {
				grep: {
					operations: {
						isDirectory: () => true,
						readFile: () => content,
						search: ({ searchPath }) => ({
							matches: [{ filePath: join(searchPath, "WARNING:notes.ts"), lineNumber: 1, lineText: content }],
							matchLimitReached: false,
						}),
					},
				},
			}).find((tool) => tool.name === "search_files")!;
			const result = await search.execute(
				"search-warning-path",
				{ pattern: "TODO" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(result)).toBe("WARNING:notes.ts:1: // TODO warning-prefixed file");
			expect(result.details).toMatchObject({ backend: "custom", matches: 1, filesMatched: 1, truncated: false });
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

	it("treats $-patterns in the replacement as literal text for a single edit", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-tool-profile-"));
		try {
			const path = join(root, "sample.ts");
			const edit = createStepToolProfile(root).find((tool) => tool.name === "edit_file")!;

			// `$&` would expand to the whole match under String.prototype.replace,
			// rewriting the file to identical bytes (a silent no-op).
			await writeFile(path, 'const example = "TARGET";\n');
			const ampersand = await edit.execute(
				"edit",
				{ path: "sample.ts", search: "TARGET", replace: "$&" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(ampersand)).toContain("1 occurrence(s)");
			expect(ampersand.details as { changed?: boolean; replacedCount?: number }).toMatchObject({
				changed: true,
				replacedCount: 1,
			});
			expect(await readFile(path, "utf8")).toBe('const example = "$&";\n');

			// `$\`` would expand to everything before the match, injecting stray code.
			await writeFile(path, 'const example = "TARGET";\n');
			const backtick = await edit.execute(
				"edit",
				{ path: "sample.ts", search: "TARGET", replace: "$`" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(text(backtick)).toContain("1 occurrence(s)");
			expect(await readFile(path, "utf8")).toBe('const example = "$`";\n');
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

		const webResult = await findTools.execute(
			"find-web",
			{ query: "current external web information", limit: 5 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(webResult)).toContain("search_web");
	});
});
