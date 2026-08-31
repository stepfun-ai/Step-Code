---
title: Step pi UI 与 harness 对齐
status: completed
---

## 范围

以 pi `origin/main` 为实现基线，保留 Step 的产品入口、主题、provider 和
SDK/harness 兼容边界。TUI 的输入、组件交互、审批选择、渲染调度和 agent loop
由 pi 原生实现负责；Step 层只做适配。

## 步骤

1. 核对 pi 原生 InteractiveMode、AgentSessionRuntime 与旧 Step stdio/harness 契约。
2. 将旧 Step stdio dispatcher 的协议行为映射到 pi runtime facade，不复制 agent loop。
3. 收敛 Step 入口和主题样式，移除会改变原生交互链的附加层。
   当前 Step 入口通过 `tuiStyle: "step"` 选择原生 Pi 组件的视觉变体：
   圆角 composer、Step welcome block 和单行 footer；输入仍由 Pi
   `CustomEditor`/`Editor` 处理。
4. 运行定向测试、构建和仓库检查，记录剩余环境依赖。

## 完成记录

- Step 入口使用 Pi 原生 editor、selector、overlay、agent session 和事件循环；Step 组件只重排已渲染行并提供产品样式。
- Step 启动界面隐藏 Pi 的普通 Context/Skills/Prompts/Extensions/Themes 清单，但保留资源冲突、扩展错误和主题诊断。
- 欢迎区依据 Pi 的上下文消息投影判断是否已经开始会话；model/thinking/label 等 metadata entry 不会隐藏首次消息提示。
- 验证：`npm test --workspace=@earendil-works/pi-coding-agent`（264 个测试文件通过，2167 个测试通过，6 个跳过），根目录 `npm test`、`npm run check`、coding-agent bundle 构建、`npx tsgo --noEmit -p tsconfig.json`、`git diff --check` 均通过。
- 入口验收：隔离临时 HOME 下的 `step auth` / `step auth --help` 正确进入 auth 帮助，Step PTY 启动显示欢迎区、圆角输入框，中文连续输入保持完整。

## 回退

所有修改保持在该独立 pi 基线分支；若某个协议迁移无法兼容，保留现有 codec/bridge，
只撤销对应 dispatcher 增量，不回退 pi 上游代码。
