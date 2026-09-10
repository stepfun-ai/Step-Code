/**
 * TUI 验收交互套件（第 2 层）—— 对应《tui-acceptance-manual.md》F2/F6/F7/K6 项。
 *
 * 验证三件交互级行为（不经真实终端）：
 * - F2 斜杠命令优先级：model/permissions/effort/thinking/plan 置顶，其余稳定排序；
 * - F7/K6 Ctrl+L 重映射：step 模式 ctrl+l → app.redraw，model.select 让位；
 *   native 模式不受影响；用户显式绑定永远优先。
 */

import { describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { applyStepKeybindingRemap, orderStepSlashCommands } from "../src/ui/interactive-mode.ts";

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
