import { join, resolve } from "node:path";
import { Text, type TUI, visibleWidth } from "@step-harness/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../../../packages/coding-agent/src/config.ts";
import type { ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../../../packages/coding-agent/src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../../../packages/coding-agent/src/core/tools/read.ts";
import { createWriteToolDefinition } from "../../../packages/coding-agent/src/core/tools/write.ts";
import { StepToolSpinnerClock } from "../src/ui/view/transcript/step-spinner.ts";
import { ToolExecutionComponent } from "../src/ui/view/transcript/tool-execution.ts";
import { createStepToolProfile } from "../../../packages/coding-agent/src/step/tool-profile.ts";
import { initTheme, theme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../../packages/coding-agent/src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [],
			details: { diff: "+1 after", firstChangedLine: 1 },
			isError: false,
		});
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{
			content: Array<{ type: string; text?: string }>;
			details?: unknown;
		}> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), {
			operations,
		});
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) =>
				updates.push(
					update as {
						content: Array<{ type: string; text?: string }>;
						details?: unknown;
					},
				),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), {
			operations,
		});
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hello" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult(
			{
				content: [{ type: "text", text: output }],
				details: {},
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "one\ntwo\n" }],
				details: undefined,
				isError: false,
			},
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult(
			{
				content: [{ type: "text", text: error }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "hidden content" }],
				details: undefined,
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{
					content: [{ type: "text", text: scenario.content }],
					details: undefined,
					isError: false,
				},
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			compact: "[skill] attio:120-329",
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			compact: "read docs README.md:120-329",
		},
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});

describe("ToolExecutionComponent Step presentation", () => {
	beforeAll(() => {
		initTheme("step-blue");
	});

	test("uses the shared Step spinner frame and elapsed suffix while running", () => {
		vi.useFakeTimers();
		try {
			const spinner = new StepToolSpinnerClock(() => {});
			const toolDefinition: ToolDefinition = {
				...createBaseToolDefinition(),
				renderCall: () => new Text("run_command(pnpm test)", 0, 0),
			};
			const component = new ToolExecutionComponent(
				"run_command",
				"step-tool-spinner",
				{ command: "pnpm test" },
				{ presentation: "step", spinner },
				toolDefinition,
				createFakeTui(),
				process.cwd(),
			);
			spinner.start("step-tool-spinner");
			const first = stripAnsi(component.render(80).join("\n"));
			expect(first).toContain("⠋ run_command(pnpm test)");
			vi.advanceTimersByTime(1_000);
			const elapsed = stripAnsi(component.render(80).join("\n"));
			expect(elapsed).toContain(" · 1s");
			spinner.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("adds a status header and connector while retaining native result content", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("run_command(ls -la)", 0, 0),
			renderResult: () => new Text("first\nsecond\nthird", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"run_command",
			"step-tool-1",
			{ command: "ls -la" },
			{ presentation: "step" },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "ignored by renderer" }],
				details: {},
				isError: false,
			},
			false,
		);
		const lines = component
			.render(80)
			.map(stripAnsi)
			.filter((line) => line.length > 0);
		expect(lines[0]).toBe("● run_command(ls -la)");
		expect(lines[1]).toBe("  └ first");
		expect(lines[2]).toBe("    second");
		expect(lines[3]).toBe("    third");
	});

	test("uses the legacy Step tool names in native-backed call headers", () => {
		const profile = Object.fromEntries(
			createStepToolProfile(process.cwd()).map((definition) => [definition.name, definition]),
		);
		const cases = [
			["read_file", { path: "src/index.ts", start_line: 3, end_line: 5 }, "read_file(src/index.ts:3-5)"],
			["write_file", { path: "src/index.ts", content: "next" }, "write_file(src/index.ts)"],
			["edit_file", { path: "src/index.ts", search: "old", replace: "new" }, "edit_file(src/index.ts)"],
			["run_command", { command: "pnpm test" }, "run_command(pnpm test)"],
		] as const;

		for (const [name, args, expected] of cases) {
			const component = new ToolExecutionComponent(
				name,
				`step-header-${name}`,
				args,
				{ presentation: "step" },
				profile[name],
				createFakeTui(),
				process.cwd(),
			);
			const first = stripAnsi(component.render(120).find((line) => line.length > 0) ?? "");
			expect(first).toContain(expected);
		}
	});

	test("collapses native-backed discovery results to the Step summary row", () => {
		const profile = Object.fromEntries(
			createStepToolProfile(process.cwd()).map((definition) => [definition.name, definition]),
		);
		const component = new ToolExecutionComponent(
			"read_file",
			"step-summary-read",
			{ path: "README.md", start_line: 2, end_line: 4 },
			{ presentation: "step" },
			profile.read_file,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "2: one\n3: two\n4: three" }],
				details: { startLine: 2, endLine: 4, selectedLines: 3, totalLines: 10 },
				isError: false,
			},
			false,
		);

		const lines = component
			.render(120)
			.map(stripAnsi)
			.filter((line) => line.length > 0);
		expect(lines).toEqual(["● read_file · Read README.md lines 2-4 (3 lines)"]);

		component.setExpanded(true);
		expect(component.render(120).map(stripAnsi).join("\n")).toContain("one");
	});

	test("collapses generic fallback output with a head/tail hint", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"step-tool-2",
			{},
			{ presentation: "step" },
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
					},
				],
				details: {},
				isError: false,
			},
			false,
		);
		const collapsed = component.render(80).map(stripAnsi).join("\n");
		expect(collapsed).toContain("  └ line-1");
		expect(collapsed).toContain("line-2");
		expect(collapsed).toContain("+8 lines");
		expect(collapsed).toContain("line-11");
		expect(collapsed).toContain("line-12");
		expect(collapsed).not.toContain("line-6");
	});

	test("renders update_plan as a checklist shell", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("update_plan"),
		};
		const component = new ToolExecutionComponent(
			"update_plan",
			"step-tool-3",
			{
				plan: [
					{ step: "Read the code", status: "completed" },
					{ step: "Apply the fix", status: "in_progress" },
					{ step: "Run tests", status: "pending" },
				],
			},
			{ presentation: "step" },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = component.render(100).map(stripAnsi).join("\n");
		expect(rendered).toContain("• Updated Plan");
		expect(rendered).toContain("  └ ✔ Read the code");
		expect(rendered).toContain("□ Apply the fix");
		expect(rendered).toContain("□ Run tests");
		expect(rendered).not.toContain('"plan"');
	});

	test("wraps long plan text without dropping characters", () => {
		const explanation = "先梳理一遍登录流程，把校验之前那次多余的 token 刷新调用去掉，再补上对应的回归测试。";
		const step = "重构鉴权中间件，让已经过期的会话在查数据库之前就被直接拒绝掉，避免无谓的往返开销。";
		const component = new ToolExecutionComponent(
			"update_plan",
			"step-tool-wrap",
			{ explanation, plan: [{ step, status: "pending" }] },
			{ presentation: "step" },
			createBaseToolDefinition("update_plan"),
			createFakeTui(),
			process.cwd(),
		);

		const lines = component.render(60).map(stripAnsi);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		// Both strings wrap at this width; the old hand-rolled wrap dropped four
		// characters at each wrap point and could blank the trailing row outright.
		const squash = (value: string) => value.replace(/\s+/gu, "");
		const rendered = squash(lines.join(""));
		expect(rendered).toContain(squash(explanation));
		expect(rendered).toContain(squash(step));
	});

	test("adds the Step gutter to a self-rendered tool without replacing its body", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("custom header\ncustom body", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"step-tool-4",
			{},
			{ presentation: "step" },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const lines = component
			.render(80)
			.map(stripAnsi)
			.filter((line) => line.length > 0);
		expect(lines[0]).toBe("⠋ custom header");
		expect(lines[1]).toBe("custom body");
	});

	test("keeps edit diff rows connected and within narrow widths", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"step-tool-5",
			{ path: "src/example.ts", oldText: "before", newText: "after" },
			{ presentation: "step" },
			{
				...createBaseToolDefinition("edit"),
				renderShell: "self",
				renderCall: () => new Text("edit src/example.ts\nsrc/example.ts\n- before\n+ after", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.setArgsComplete();
		component.updateResult(
			{
				content: [],
				details: { diff: "src/example.ts\n- before\n+ after" },
				isError: false,
			},
			false,
		);
		for (const line of component.render(24)) expect(stripAnsi(line).length).toBeLessThanOrEqual(24);
		const text = component.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("● edit src/example.ts");
		expect(text).toContain("  └ src/example.ts");
		expect(text).toContain("- before");
		expect(text).toContain("+ after");
		expect(text).not.toMatch(/edit_file\(src\/example\.ts\)\n\n/);
	});
});
