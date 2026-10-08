# 内部 CLI 遥测生产与会话归属

## 分支边界

内部 `main` 在 `apps/cli/src/observability.ts` 注入真实 reporter；公开分支使用 NOOP。
生命周期适配器、权限投影、投递实现和采集端配置保留在内部，不能随修复反向同步到公开分支。

## 实际生产路径

`apps/cli/src/bootstrap/extensions.ts` 注册 Step 扩展并传入共享 reporter。
`packages/coding-agent/src/features/step.ts` 创建并注册生命周期适配器，订阅原有 Pi 事件，不另建 agent loop。

- `session_start` 产生 `session_started`；`agent_start` 到 `agent_end` 聚合一个产品轮次，产生 `turn_completed` 及 token 用量。Pi 内部多次模型/工具迭代计入 `step_count`。
- 工具开始和结束按调用 ID 配对；`tool_result` 与 `tool_execution_end` 不重复计数。生命周期的 `tool_call` 处理器必须先于权限处理器注册，后者拒绝时会短路后续处理器。
- `StepPermissionController.handleToolCall` 的可选观察回调接收本次实际策略决策，避免为埋点重复分析命令、重复读取可变设置。观察失败不影响权限行为。
- 实际决策产生 `permission_decision`；确实进入交互确认的调用才产生 `permission_approval_result`（`allow-once` / `deny` / `error`）。无 UI 的自动允许或拒绝不伪造用户确认。
- 权限拒绝标记对应工具为 `denied`；`then_run` 缺少 `run_command` 等前置可用性检查保持原行为，不伪造权限决策。

## 会话归属

问题示例：打开 A 后、第一次模型请求完成前执行 `/permissions`，应立即归属 A；切换 B 后执行同一命令，应立即归属 B。

规则：

1. `session_start`（启动、新建、恢复、分叉、重载）从会话管理器读取 ID，并同步 reporter 的前台 session。
2. `session_shutdown` 清除适配器聚合状态及 reporter 的前台 session。读取不到新 ID 时同样清除旧值；现有 runtime 用 `{ sessionId: "" }` 明确清理，省略字段不会清理。
3. `model_request_completed` 只显式携带该请求自己的 session，不更新 reporter 的前台 session。A 的迟到请求可以记到 A，但不能把 B 随后的命令归属改回 A。
4. runtime 在 `track()` 时快照 session；切换或退出后的 flush 不改变已排队事件的归属。

## 回归门禁

`apps/cli/test/step-lifecycle-telemetry.test.ts` 通过实际 CLI 扩展工厂、真实 agent loop、权限控制器和遥测 runtime 验证；模型使用 faux provider，HTTP 使用内存接收器，外部 MCP discovery/provisioning 隔离。

覆盖正常轮次及 token、工具完成去重、允许/确认/拒绝/确认异常、无 UI 路径、`then_run` 前置检查、首次请求前的命令、跨会话迟到请求、退出清理和 reporter 异常。

opensource → main 同步和内部发版前应运行此测试及适配器定向测试。仅检查实现文件仍存在或适配器单测通过，不能保证 CLI 注册路径仍生产事件。
