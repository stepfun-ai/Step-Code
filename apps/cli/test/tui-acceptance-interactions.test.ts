/**
 * TUI 验收交互套件（第 2 层）—— 对应《tui-acceptance-manual.md》F2/F6/F7/K6 项。
 *
 * 验证三件交互级行为（不经真实终端）：
 * - F2 斜杠命令优先级：model/permissions/ultracode/effort/thinking/plan 置顶，其余稳定排序；
 * - F7/K6 Ctrl+L 重映射：step 模式 ctrl+l → app.redraw，model.select 让位；
 *   native 模式不受影响；用户显式绑定永远优先。
 */

import {
	type AgentSession,
	type AgentSessionRuntimeHost,
	createSyntheticSourceInfo,
	type ResolvedCommand,
	SessionManager,
	SettingsManager,
	stopThemeWatcher,
	type ToolInfo,
} from "@step-harness/coding-agent";
import { type AutocompleteProvider, stripTerminalSequences, TuiMainScreen } from "@step-harness/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { applyStepKeybindingRemap, InteractiveMode, orderStepSlashCommands } from "../src/ui/interactive-mode.ts";

describe("F2. 斜杠命令优先级", () => {
	test("高频命令置顶，其余保持原有相对顺序", () => {
		const builtins = ["settings", "model", "tree", "thinking", "effort", "export", "quit"].map((name) => ({
			name,
		}));
		const extensions = ["init", "permissions", "plugin", "plan", "status", "feedback"].map((name) => ({
			name,
		}));

		const ordered = orderStepSlashCommands([...builtins, ...extensions]).map((command) => command.name);

		expect(ordered.slice(0, 5)).toEqual(["model", "permissions", "effort", "thinking", "plan"]);
		// 未入优先级的命令保持传入顺序（稳定排序）
		expect(ordered.slice(5)).toEqual(["settings", "tree", "export", "quit", "init", "plugin", "status", "feedback"]);
	});

	test("无优先级命中时原样返回", () => {
		const commands = [{ name: "b" }, { name: "a" }];
		expect(orderStepSlashCommands(commands).map((command) => command.name)).toEqual(["b", "a"]);
	});

	test("pins registered Ultracode near the top while keeping Ultraloop in the remaining commands", () => {
		const names = ["settings", "ultraloop", "model", "permissions", "effort", "thinking", "plan", "ultracode", "quit"];
		const commands = names.map((name) => ({ name }));
		const ordered = orderStepSlashCommands(commands).map((command) => command.name);

		expect(ordered.slice(0, 6)).toEqual(["model", "permissions", "ultracode", "effort", "thinking", "plan"]);
		expect(ordered.slice(6)).toEqual(["settings", "ultraloop", "quit"]);
		expect(commands.map((command) => command.name)).toEqual(names);
	});

	test("does not invent an Ultracode command when only the alias is registered", () => {
		const commands = ["settings", "ultraloop", "model"].map((name) => ({ name }));
		expect(orderStepSlashCommands(commands).map((command) => command.name)).toEqual([
			"model",
			"settings",
			"ultraloop",
		]);
	});
});

describe("Ultracode discovery from session registration", () => {
	const modes: InteractiveMode[] = [];
	const sourceInfo = createSyntheticSourceInfo("test:ultracode", { source: "test" });
	const workflow: ToolInfo = {
		name: "workflow",
		description: "Workflow orchestration",
		parameters: Type.Object({}),
		sourceInfo,
	};

	function createMode(getAllTools: AgentSession["getAllTools"], commandNames: string[]): InteractiveMode {
		vi.spyOn(TuiMainScreen.prototype, "requestRender").mockImplementation(() => {});
		const commands = commandNames.map<ResolvedCommand>((name) => ({
			name,
			invocationName: name,
			sourceInfo,
			handler: async () => {},
		}));
		// Exercise the real UI constructor without starting a terminal, model, or workflow.
		const runtimeHost = {
			services: { agentDir: "/tmp/welcome-registration-test/.step" },
			setBeforeSessionInvalidate: () => {},
			setRebindSession: () => {},
			session: {
				sessionManager: SessionManager.inMemory("/tmp/welcome-registration-test"),
				settingsManager: SettingsManager.inMemory({ theme: "step-blue", enableSkillCommands: false }),
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				promptTemplates: [],
				getAllTools,
				getActiveToolNames: () => [],
				extensionRunner: {
					getRegisteredCommands: () => commands,
					getCommand: (name: string) => commands.find((command) => command.invocationName === name),
				},
			},
		};
		const mode = new InteractiveMode(runtimeHost as unknown as AgentSessionRuntimeHost, {
			tuiStyle: "step",
			tuiMode: "regular",
		});
		modes.push(mode);
		return mode;
	}

	afterEach(() => {
		for (const mode of modes) mode.stop();
		modes.length = 0;
		stopThemeWatcher();
		initTheme("dark");
		vi.restoreAllMocks();
	});

	test("shows the welcome command for deferred workflow tools and refreshes availability", () => {
		const getAllTools = vi.fn((): ToolInfo[] => [workflow]);
		const mode = createMode(getAllTools, ["ultracode", "ultraloop"]);

		expect(mode.stepWelcome?.render(120).join("\n")).toContain("/ultracode on");
		getAllTools.mockReturnValue([]);
		expect(mode.stepWelcome?.render(120).join("\n")).not.toContain("ultracode");
		getAllTools.mockReturnValue([workflow]);
		expect(mode.stepWelcome?.render(120).join("\n")).toContain("/ultracode on");
	});

	test.each([
		{ label: "workflow disabled", tools: [], commands: [] },
		{ label: "workflow excluded", tools: [], commands: ["ultracode", "ultraloop"] },
		{ label: "canonical command missing", tools: [workflow], commands: ["ultraloop"] },
	])("omits the welcome tip with $label", ({ tools, commands }) => {
		const mode = createMode(() => tools, commands);

		for (const width of [30, 120]) {
			const output = mode.stepWelcome!.render(width).map(stripTerminalSequences).join("\n");
			expect(output).not.toMatch(/ultracode|ultraloop|parallel subagents/u);
			expect(output).toContain("/goal");
		}
	});

	test("offers registered Ultracode near the top of bare slash completion and retains its alias", async () => {
		const mode = createMode(() => [workflow], ["permissions", "plan", "ultraloop", "ultracode"]);
		const provider = (
			mode as unknown as { createBaseAutocompleteProvider(): AutocompleteProvider }
		).createBaseAutocompleteProvider();
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		const names = suggestions!.items.map((item) => item.value);

		expect(names.slice(0, 6)).toEqual(["model", "permissions", "ultracode", "effort", "thinking", "plan"]);
		expect(names.filter((name) => name === "ultracode")).toHaveLength(1);
		expect(names.filter((name) => name === "ultraloop")).toHaveLength(1);
		expect(names.indexOf("ultraloop")).toBeGreaterThan(5);
	});

	test("does not add unavailable workflow commands to bare slash completion", async () => {
		const mode = createMode(() => [], ["permissions", "plan"]);
		const provider = (
			mode as unknown as { createBaseAutocompleteProvider(): AutocompleteProvider }
		).createBaseAutocompleteProvider();
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		const names = suggestions!.items.map((item) => item.value);

		expect(names).not.toContain("ultracode");
		expect(names).not.toContain("ultraloop");
	});
});

describe("F7/K6. Ctrl+L 重映射", () => {
	test("step 重映射后 ctrl+l 归 app.redraw，model.select 无默认键", () => {
		const keybindings = new KeybindingsManager();
		applyStepKeybindingRemap(keybindings);

		expect(keybindings.getKeys("app.redraw")).toContain("ctrl+l");
		expect(keybindings.getKeys("app.model.select")).toEqual([]);
	});

	test("native 默认不受影响：ctrl+l 仍是 model.select", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.model.select")).toContain("ctrl+l");
		expect(keybindings.getKeys("app.redraw")).toEqual([]);
	});

	test("用户显式绑定优先于重映射（K6）", () => {
		const explicit = new KeybindingsManager({
			"app.model.select": "ctrl+alt+m",
		});
		applyStepKeybindingRemap(explicit);
		// 用户已绑定 model.select → 重映射让位，redraw 不抢 ctrl+l
		expect(explicit.getKeys("app.model.select")).toEqual(["ctrl+alt+m"]);
		expect(explicit.getKeys("app.redraw")).toEqual([]);

		const explicitRedraw = new KeybindingsManager({ "app.redraw": "ctrl+r" });
		applyStepKeybindingRemap(explicitRedraw);
		expect(explicitRedraw.getKeys("app.redraw")).toEqual(["ctrl+r"]);
		expect(explicitRedraw.getKeys("app.model.select")).toContain("ctrl+l");
	});

	test("ctrl+l 按键序列命中 app.redraw（经全局 keybindings 派发路径）", () => {
		// \x0c 是 Ctrl+L 的原始字节；编辑器 handleInput 用同一 matches() 判定
		const keybindings = new KeybindingsManager();
		applyStepKeybindingRemap(keybindings);
		expect(keybindings.matches("\x0c", "app.redraw")).toBe(true);
		expect(keybindings.matches("\x0c", "app.model.select")).toBe(false);

		const native = new KeybindingsManager();
		expect(native.matches("\x0c", "app.model.select")).toBe(true);
	});
});

describe("F6. 权限循环键位存在性（冒烟）", () => {
	test("app.thinking.cycle 默认绑 shift+tab（step 分支改道 /permissions --cycle）", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.thinking.cycle")).toContain("shift+tab");
	});
});

describe("E. 工作行动词跟随真实工具", () => {
	test("动词映射：已知工具给对应动词、未知工具回退轮换", async () => {
		const { workingVerbForTool } = await import("../src/ui/view/chrome/status-indicator.ts");
		expect(workingVerbForTool("bash")).toBe("Running...");
		expect(workingVerbForTool("read")).toBe("Reading...");
		// step 皮肤对外的工具名（tool-profile.ts 重命名）必须全部有映射——
		// 曾因映射键用内置名 read 而真机工具名是 read_file，动词永远回退 Working
		expect(workingVerbForTool("read_file")).toBe("Reading...");
		expect(workingVerbForTool("write_file")).toBe("Writing...");
		expect(workingVerbForTool("edit_file")).toBe("Editing...");
		expect(workingVerbForTool("run_command")).toBe("Running...");
		expect(workingVerbForTool("search_files")).toBe("Searching...");
		expect(workingVerbForTool("find_files")).toBe("Finding...");
		expect(workingVerbForTool("list_directory")).toBe("Listing...");
		expect(workingVerbForTool("grep")).toBe("Searching...");
		expect(workingVerbForTool("edit")).toBe("Editing...");
		// 未映射/未提供不瞎编，交给轮换
		expect(workingVerbForTool("totally_unknown_tool")).toBeUndefined();
		expect(workingVerbForTool(undefined)).toBeUndefined();
	});

	test("spinner 时钟跟踪最近启动且仍在跑的工具", async () => {
		vi.useFakeTimers();
		const { StepToolSpinnerClock } = await import("../src/ui/view/transcript/step-spinner.ts");
		const clock = new StepToolSpinnerClock(() => {});
		expect(clock.currentToolName()).toBeUndefined();

		clock.start("call-1", "read");
		expect(clock.currentToolName()).toBe("read");

		// 并行：后启动的优先展示；先结束的回退到剩下的
		clock.start("call-2", "bash");
		expect(clock.currentToolName()).toBe("bash");
		clock.stop("call-2");
		expect(clock.currentToolName()).toBe("read");

		clock.stop("call-1");
		expect(clock.currentToolName()).toBeUndefined();
		clock.dispose();
		vi.useRealTimers();
	});
});
