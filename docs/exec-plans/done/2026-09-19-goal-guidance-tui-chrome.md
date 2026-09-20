# Goal 使用引导与 TUI 信息精简

## 范围

在蓝色主题改动之上，补齐用户追加的 T1–T6 与 TUI 展示要求。已有 pause/resume 指引不重复实现；不改 goal 执行循环、预算、持久化和暂停语义。

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 时间与 goal 状态提示 | apply_patch | 时间显示 45s / 58m 25s / 1h 02m；只有 paused 发布 footer 状态；普通消息 warning 与未完成目标错误包含可执行命令 | 仅撤销本轮格式与文案增量 |
| 状态感知 tip | apply_patch | 通过能力层复用快照校验，读取当前 session 分支投影；active 以 status/pause/edit/clear 为主，paused 优先 resume，无目标提示长程任务入口；每轮一条，不新增计时器 | 撤销只读查询与 tip 轮换增量 |
| 输入命令与 thinking 着色 | apply_patch | 仅首个 /command token 着 accent；光标覆盖 token 跳过，保留宽度、光标、补全；thinking 行内代码用 muted | 撤销组件着色增量 |
| footer 右侧精简 | apply_patch | 只显示完整 xx% context left，不扫描历史计算 token 花费；原生 footer 保留现状 | 撤销 Step footer 分支增量 |
| 定向回归与说明 | 定向 vitest、npm run check、文档 | 覆盖状态切换/清空/分支、光标与窄屏、主题与正文隔离；记录既有检查问题 | 仅修正本轮文件，不覆盖其他工作 |

无外部副作用、不修改个人配置、不提交、不构建、不运行完整测试套件。

追加：输入完整 `ultracode` 关键词时使用 accent，并执行一次约 600ms 的高光扫过；光标覆盖该词时跳过。动画有界、失焦/清空/退出停止，不改变输入内容、补全或光标语义。通过定向 fake-timer 测试验证无常驻刷新；回滚只撤销 StepEditor 展示增量。

实现选择：基础 Editor 增加中性的 `styleText(text, line, startIndex)` 钩子，在原生换行/滚动后提供源位置并跳过光标字符；避免在产品层复制布局或解析 ANSI 猜测位置。关键词、主题、计时器全部留在 StepEditor。回滚包含钩子、布局源位置和对应测试。

## 完成与验证

- Goal 时间、仅 paused footer、恢复 warning、未完成目标指引、分支快照投影与状态感知 tips 已实现；没有修改执行循环或持久化语义。
- `/command` accent、`ultracode` 一次性扫光、thinking muted 行内代码、footer 完整 context 文案已实现。退出、暂停终端和打开外部编辑器时清理扫光定时器。
- coding-agent：`step-schedule`、`utils-time` 和四个主题测试文件，65 测试通过。
- CLI：`step-editor`、`status-tips`、`footer-width`、`step-user-message-style`、`thinking-inline-style`、`session-events-working-tracker`，50 测试通过。
- CLI 验收快照 B/C/C2/D/E/F/G/I：22 测试通过；3 个既有欢迎页快照不在本轮验证范围，未修改。
- pi-tui：`node --test test/editor-style.test.ts test/editor.test.ts`，186 测试通过；覆盖原生输入、补全、滚动、粘贴、光标与源位置样式钩子。
- 合计 323 项定向测试通过；`npm run check` 最终通过、无格式修正，`git diff --check` 通过。npm 的两条已有配置识别警告不属于本轮代码问题。
- 文档：`docs/step-goal-ui.md`、`packages/tui/docs/editor-styling.md`；未启动 TUI、未构建、未提交。

## 结构审核

| 规则 | 判定 | 说明 |
| --- | --- | --- |
| R1 入口方向 | PASS | CLI UI 引用能力层已有公开入口；能力层没有反向依赖 |
| R2 非界面到界面 | PASS | Goal 投影复用本文件快照校验，无新增界面引用 |
| R3 TUI 纯绘制 | PASS | 只增加中性源位置样式钩子，无主题、关键词、计时器或 AI 依赖 |
| R4 契约纯度 | PASS | 未修改跨进程契约 |
| R5 能力层命令入口 | PASS | 无新增 bin |
| R6 扩展归属 | PASS | Goal 仍在产品 features，未新增顶层扩展 |
| R7 模型接入 | PASS | 未修改 provider 分流 |
| R8 标准输出启动序 | PASS | 未改启动顺序 |
| R9 workspace | PASS | 无新包；17 成员检查通过 |
| R10 helper 归属 | PASS | 展示状态留在 UI，快照校验留在能力层 |
| R11 对外导出 | PASS | 新增具名导出与保护钩子，未删除旧导出；主题更名按用户要求 |
| R12 能力与显示 | PASS | UI 只读目标投影，领域状态不在编辑器持有 |

O1：本轮 interactive-mode 只增加三处编辑器动画清理接线，没有加入新的展示实现。结论：本轮无结构违规。
