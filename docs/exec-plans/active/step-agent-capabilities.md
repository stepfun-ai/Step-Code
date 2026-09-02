---
title: Step CLI agent capabilities
status: active
---

# Step CLI agent capabilities

## Scope

保留 Pi 的 AgentSession、Agent Loop、ExtensionAPI、原生 TUI 组件和输入/队列
语义；Step 只提供产品入口、配置命名空间、样式和必要的兼容适配。旧 Step CLI
的 plugin、subagent、plan、clarify_user 能力按 Pi 的扩展契约重新接入，不在 UI 层复制
运行时状态机。

## Implementation order

1. **Plan and clarify_user**
   - 以 Pi 的 `plan-mode`、`question`/`questionnaire` 示例为行为基线，统一对外暴露 Step 的 `clarify_user`。
   - 为 Step 工具名 (`read_file`、`run_command` 等) 提供动态工具映射。
   - 普通选择、确认、文本输入全部交给 Pi TUI 的 `SelectList`、`Editor` 和
     `ExtensionUIContext`；Step 只改文案和主题。

2. **Subagent**
   - 将 Pi 的 subagent 扩展作为 Step 的内置 inline extension，默认使用与主会话
     相同的已解析模型；支持显式模型、agent 定义、串行/并行任务。
   - 设计 `subagent` 工具的 `agent`/`task` 参数、生命周期状态、后台任务控制和系统提示时，同时参考
     Codex 的公开 schema、提示词约束与实现；只吸收可验证的行为，不复制其
     独立 runtime 或绕过 Pi session authority。
   - 子 agent 可选择独立 git worktree；worktree 生命周期、清理和失败回收必须
     有界且可观测。
   - 使用 Pi 原生 `Container`、`Markdown`、`Text` 和工具结果渲染展示实时进度、
     折叠详情和结果；不把子 agent 输出直接混入主输入流。
   - 第一阶段提供 lane 列表、取消和详情查看；切换到独立 session 画面必须复用
     `AgentSessionRuntime` 的 `switchSession`，不得在扩展内私建第二套 session
     authority。

3. **Plugin marketplace**
   - 增加 Step 内置声明式 plugin manifest/marketplace 适配层，宿主路径统一为
     `.step-cli`，同时保留旧 `.step-harness` 仅用于迁移。
   - 迁移内置 `playwright` 与 `steppage`（用户口中的 stoppage）manifest；插件
     发现、安装、启停和配置沿用 Pi 的 package/resource precedence。
   - MCP server 若当前 Pi runtime 没有等价执行器，先保留声明、发现和诊断能力，
     再接入统一 MCP bridge；不得在 TUI 中伪造已启动的 server。

4. **Parallel development workflow**
   - 子 agent 的实现任务使用独立 git worktree 和明确文件边界并行开发。
   - 主 agent 只合并经过定向测试的改动；共享工作树中的既有用户修改不得回退。
   - 模型选择沿用当前 harness 的 resolved model；未显式指定时不另造 provider
     或认证路径。

## Acceptance criteria

- `/plan`、`clarify_user`、`subagent`、`/plugin` 在 Step 入口可发现，
  且 `--no-extensions` 不会绕过 Step 的核心安全策略。
- 子 agent 并行执行时主 TUI 保持可输入，进度和最终结果可展开查看；取消不会泄漏
  子进程、临时 prompt 或 worktree。
- 插件 manifest 可在开发运行和打包运行中被发现；`playwright`、`steppage` 的
  缺少外部命令时给出明确诊断而不是启动失败。
- 相关测试、`git diff --check`、类型检查和 `npm run check` 通过。

## Rollback

每个阶段保持独立 commit 级边界（但本工作阶段不自动提交或推送）。若某项 Pi
原生能力无法安全复用，撤回对应 inline extension/manifest 接线，保留当前 Step
入口、provider、session wrapper 和样式改动。

## TODO / 最近收口

- [x] 读取 `lark-drive` skill（仅读取规范，未调用飞书接口）。
- [x] 移除重复的 `/effort`，统一使用 Pi 原生 `/thinking`。
- [x] 移除单数 `/permission`，保留 `/permissions` 作为唯一 Step 权限命令。
- [x] 简化队列展示：保留 Pi 的队列语义、分隔线和 `alt+↑ edit last queued message`，去掉可见的 `queue` 标题。
- [x] 队列编辑快捷键按当前主题高亮，说明文字保持次级颜色。
- [x] `/init`、旧 `/changelog` 移除和只读模式 footer 显示已接入并有定向测试覆盖。
- [x] `clarify_user` 已统一承载单题与多题问询；原 `askuser`/`questionnaire` 不再注册为独立工具，原生对话支持题号、总题数和左右/Tab 导航。
- [x] `subagent` 已按 Pi 示例恢复 `agent`/`task`、`tasks`、`chain`、`agentScope` 和 `confirmProjectAgents` schema；模式判定按非空数组长度执行。
- [x] Step 适配保留阻塞、并行、串行、模型继承、主题结果渲染和可选 Git worktree；后台 lane 控制仅作为宿主侧扩展能力，不进入 Pi 的模型可见 schema。
- [x] `/plugin` marketplace facade 与内置 `playwright`、`steppage` manifest 已落地，统一使用 `.step-cli` 存储并保留 `.step-harness` 迁移兼容。
- [x] Step 版本、发布 tag 分流和 telemetry runtime 的基础接线已完成（Step `vX.Y.Z`，Pi `pi-vX.Y.Z`）。
- [~] 子 agent 详情切换到独立 session 画面尚未完成；当前提供实时 widget、展开结果和控制工具。
- [~] Plugin 的 MCP 声明可发现、安装和诊断，但统一 MCP 进程 bridge 尚未接入。
- [~] telemetry 仍需完成旧 Step 业务事件 producer 的逐项 gap audit；缺失事件不伪造上报。
