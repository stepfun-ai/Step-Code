---
title: Step TUI 可用性与运行反馈改进
status: ready-for-review
---

# Step TUI 可用性与运行反馈改进

## Merge Request

- 源分支：`fix/bugs`
- 目标分支：`main`
- 标题：`feat(coding-agent): 改进 Step TUI 可用性与运行反馈`

## 背景

本分支将旧版 `step-cli` MR !204 的主题对比度改造移植到新版
`step-harness`，并处理 Step CLI 使用中发现的输入、主题和运行状态反馈问题。
这些变化只影响 Step 产品展示；原生 Pi TUI 的 Working 展示和统计路径保持不变。

## 改动摘要

1. 修复 Step 用户消息在部分终端浅色输入栏中文字对比度不足的问题。
2. 将 `Alt+Enter` 设为默认换行键，并取消 follow-up 的默认快捷键绑定。
3. 新增 `step-light` 浅色主题，与深色 `step` 主题按终端背景自动配对。
4. 在 Step `Working...` 状态行显示耗时、估算输出 token 数和 `thinking` 状态。
5. 修复非交互 HTML 导出的 Step 主题选择，并清理 `/hotkeys` 中未绑定 follow-up 的空行。
6. 补齐缺少产品 options 时的认证 selector 防护，并稳定 Step 相关 headless 测试。

分支中曾加入源码优先启动器，随后已由独立回滚提交完整撤销，最终没有净改动。

## 提交说明

| 提交 | 改动 | 最终效果 |
| --- | --- | --- |
| `87c14e1` | 修复 Step 用户消息前景色继承 | 避免 gutter 样式重置正文颜色，改善部分终端下的可读性。 |
| `a06bd4c` | 增加源码优先 Step 启动器 | 后续已回滚，最终不保留。 |
| `c7bac98` | 支持 `Alt+Enter` 换行 | 将 `Alt+Enter` 加入编辑器换行默认键，并取消 follow-up 默认绑定。 |
| `252e6aa` | 移植 Step 主题对比度改造 | 新增 `step-light`，更新深色主题和语法配色，支持自动深浅配对及 HTML 导出。 |
| `97585a1` | 回滚源码优先启动器 | 恢复原有打包启动逻辑，撤销对应文件和依赖变更。 |
| `c9f4084` | 增加实时 Working 输出指标 | 显示任务耗时、本地估算输出 token 数和标准化 thinking 阶段。 |
| 本次补强 | 修复审查和验证发现的问题 | 改为 delta 增量统计、限制 tracker 仅在 Step 运行、修复 CLI 导出主题、`/hotkeys` 空行及三个基线测试。 |

## 实现细节

### 输入与消息可读性

- Step 输入栏 gutter 继承当前 `userMessageText` 前景色，不再插入额外颜色重置。
- `Alt+Enter`、`Shift+Enter` 和 `Ctrl+J` 均可触发编辑器换行。
- `app.message.followUp` 仍可通过自定义键位、扩展或 RPC 使用，但默认不再占用
  `Alt+Enter`。
- 对无法直接传递 Alt 修饰键的终端，文档补充了对应 CSI-u 配置。
- `/hotkeys` 仅在 follow-up 有实际绑定时显示该行。
- 认证 selector 在嵌入宿主没有传入产品 options 时仍可列出 provider 和已存凭证。

### Step 深浅主题配对

- `step-light` 是浅色背景主题，`step` 保留为深色背景主题。
- Step 默认值为 `step-light/step`，根据终端背景选择对应主题。
- 显式主题优先级为：`--use-theme`、已保存设置、产品默认主题。
- 非交互 `step --export` 使用同一优先级，不再回退到普通 Pi 主题。
- 深色主题提高品牌色亮度，并按色相区分 Markdown 和代码语法类别。
- 实时 TUI 与 HTML 导出的浅色用户消息栏均复用 `step-light` Markdown 配色。

### Working 状态指标

- 计时从 `agent_start` 开始，覆盖模型响应、工具调用及后续模型轮次。
- 流式阶段直接累计标准化 `thinking_delta`、`text_delta` 和
  `toolcall_delta`，工具调用开始时另计工具名，避免反复扫描累计全文。
- 本地估算采用 `round(chars / 4)`；单次响应结束后，如接口返回正数
  `usage.output`，则使用正式值替换该次估算，否则保留估算值。
- Anthropic Messages 与 OpenAI 兼容适配器最终都产生统一的
  `AssistantMessageEvent`，因此 UI 不需要协议分支。
- `thinking` 标记由标准化 thinking 事件触发，开始输出正文或工具调用时清除。
- 正文组件仍逐个消费流式事件，没有增加缓冲或伪打字机队列。
- tracker 仅在 `presentation === "step"` 时运行，原生 Pi 展示不受影响。

## 验证

- `npm run check`：通过。
- 聚焦测试：11 个测试文件、63 个测试全部通过。
- 原有三个基线失败的定向验证：3 个测试文件、30 个测试全部通过。
- 覆盖 Working 增量统计、原生 Pi 隔离、流式正文即时更新、Step 主题、HTML
  导出、用户消息样式、`Alt+Enter`、快捷键、环境变量、认证 selector、trace
  header 和 `/hotkeys`。
- `./test.sh`：通过。
- `git diff --check`：通过。

## 风险与回滚

- 流式阶段的 token 数是本地估算，接口返回最终 usage 后才是正式值。
- 如果上游模型或网关缓冲流式数据，正文仍可能一次出现多行；本分支不会人为拆分输出。
- 取消 follow-up 默认快捷键属于明确行为变化，需要该能力的用户可重新配置
  `app.message.followUp`。
- 自动主题配对只在没有更高优先级显式设置时生效。
- 启动器实验已经完整回滚，无需额外回滚操作。
