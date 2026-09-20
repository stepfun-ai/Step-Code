# /goal clear 中止当前执行

**Goal:** 成功清除目标后停止当前 agent run，包括模型流、重试等待和自动压缩；不得重新续跑。

**Architecture:** 先持久化 clear，再调用 ExtensionContext.abort。AgentSession 统一同步取消 run、retry、compaction 和 agent，随后调用可选的 TUI 队列恢复钩子。每个 run 的取消标记跨越 attempt 间隙，阻止 post-run recovery 再次 continue。

**Scope:** 基于 main 7b85cb5。初始用户 turn 和 goal continuation 均覆盖；无 goal 或 idle clear 不中断其他工作；持久化失败保留 goal 并提示。独立手动压缩/树摘要不属于 busy agent run，未修改 isIdle 定义。

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 复现与命令回归 | step-schedule.test.ts、真实 RPC | clear 后仍 streaming 的旧行为可复现，新增测试先失败 | 撤销本任务命令和测试修改 |
| 修复 clear | step-schedule.ts | 先成功清除，再取消当前忙碌 run | 撤销 clear 分支修改 |
| 补宿主边界 | AgentSession、suite/regressions/goal-clear-abort.test.ts | TUI/RPC 的退避、压缩、结束事件期间 clear 均不会发起新请求 | 撤销本任务宿主和集成测试修改 |
| 验证 | Node 22.19.0、build:offline、test.sh、npm run check、真实 RPC/TUI | 检查通过，客户端停止、goal 已清除、无自动重启 | 结束本任务测试进程 |
| 提交 MR | git commit/push、GitLab MR | 描述记录最终改动和验证证据 | 保留独立分支，不合并或发布 |

## 根因与审查

- 原 clear 仅删除目标状态并撤销未来续跑，没有 abort 当前请求。
- 原 TUI abortHandler 只取消低层 agent，遗漏 session retry；原 session.abort 未取消 auto-compaction。
- 只取消已有 controller 仍不足以覆盖 agent_end/compaction_end 间隙，因此新增每 run 取消标记和恢复前后检查。
- 取消后的压缩扩展如果抛异常，不能再 fallback 调用默认摘要模型；此路径也有回归。
- 独立代码复审：两个 P2 已关闭，最终范围内无新增阻塞项。

## 验证结果（2026-09-19）

- 命令测试：48 passed，新增 8 项，包括初始 turn、续跑、idle、无目标、accounting/tombstone 持久化失败、abort 异常及排队竞态。最初 RED 为 4 failed / 43 passed。
- 宿主集成：10 passed，使用真实 AgentSession 与 faux provider；TUI/RPC 均覆盖 retry backoff、agent_end、auto-compaction、compaction_end，以及取消扩展抛异常。初始宿主 RED 为 7 failed / 1 passed；另补的压缩异常用例 RED 为 2 failed / 8 passed。
- 定向回归：5 文件、97 passed。
- 独立安装依赖，hydrate:model-data + build:offline 通过；生成的 manifest 仅时间变化已撤回。
- 隔离全量 ./test.sh 退出码 0：coding-agent 2835 passed / 66 skipped，CLI 563 passed；其余工作区与 scripts 也通过。需要凭据或平台条件的测试保持仓库默认跳过。
- npm run check 退出码 0，Node 22.19.0，无 engine warning；git diff --check 通过。
- 初次全量测试因借用依赖缺少 workspace dist 失败；改为独立安装并构建后，全量复验通过。

### 真实模型

使用已授权 key，经独立 CLI 调用 step-3.7-flash（thinking high）。

| 路径 | clear 前 | clear 后 |
| --- | --- | --- |
| 修复前 RPC | 实际 thinking_delta、streaming=true | goal 已清除，4 秒后仍 streaming，无 agent_end |
| 最终 RPC | 实际 thinking_delta、streaming=true | 约 29ms 收到 aborted；streaming=false；固定观察 5 秒，0 次 agent_start、0 个后续 delta |
| 最终 TUI（PTY） | 显示 Thinking | 显示 Goal cleared；持久化 assistant.stopReason=aborted 和 goal tombstone；观察至少 5 秒后仅 1 条 assistant；/goal status 为空，CLI 仍可用 |

验证证明客户端停止执行，不代表已测量服务端 GPU 取消或计费终止时刻。所有测试进程均已结束，未替换用户当前运行的 CLI。

原始记录：`/data/tmp/goal-clear-20260919/` 下的 `mr-submit/`、`tui-verify-submit/`、`host-green-final.log`、`test-all-final.log`、`check-submit.log` 及对应 exit 文件。RPC 观察使用 monotonic deadline，避免条件变量提前唤醒缩短观察期。
