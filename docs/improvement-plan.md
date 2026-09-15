# Step-harness 收敛计划 — Subagent / Plan Mode / Compaction

> 对比对象：
> - **新**：`gitlab.basemind.com/aiagent/step-harness` — Step CLI on Pi Runtime，主线 @ `20b5724`（本文件位于 `docs/diff-from-old-stepcli.md`）。Product 层 `packages/coding-agent/`；Runtime 层 `packages/agent/`（`@earendil-works/pi-*`）。
> - **旧**：`/data/ai_code_base/for_multi_frame/framework/step-cli` — agent loop / 结构化 memory / in-process teammate 在 `packages/core/src/agent/`。
> - **参考**：Claude Code — tool 面 `Agent` / `SendMessage` / `TaskStop` + `<task-notification>` 事件回流。
>
> 本文档只包含**要做什么**（核心设计）和**怎么做**（分阶段计划）。历史 diff 分析、Structured Checkpoint v2 暂缓方案、`向旧行为迁移的最小方案` 备选表等在本文件的 git history 里可查（refine 前版本 ~1700 行，历史文件名 `diff-from-old-stepcli.md`）。

**修订**：
- 2026-09-02 首次编写（含 diff 背景，文件名 `diff-from-old-stepcli.md`）
- 2026-09-02 升格为 Plan，加入 3 条 P0 收敛方案
- 2026-09-02 refine：去 background diff / 备选方案 / 冗余论证，只保留核心设计和计划
- 2026-09-02 rename → `improvement-plan.md`；Plan 1 补齐"持续对话"（B+C：`--mode rpc` + `--session-id`）
- 2026-09-02 workflow #2+#3 landed: full Plan 1/2/3 implementation across 4 branches（见下方"落地状态"）
- 2026-09-03 refactor pass landed on B/C/δ 三轨（B +4 / C +3 / δ +4 commits，全绿提交）；A 轨模块拆分（rpc-adapter / lane-events / lane-lifecycle）仍 pending
- 2026-09-03 workflow #4-#7 landed: refactor pass, 4 branches at target quality（A 轨补齐：6 模块拆分 +1558/−1353，`step-subagent.ts` 1844 → 555 行；四轨 tsgo / vitest 复验全绿）

---

## 决策矩阵

| 维度 | 现状问题 | 采取的动作 | 优先级 |
|---|---|---|---|
| **Subagent** | 5 个 tool 占 system prompt；`agent_wait` 同步阻塞浪费 cache；模型主动 poll 才知后台完成；子进程 `--no-session -p`，每次 `agent_reply` 都是 abort + 新 subprocess，**上下文完全不继承** | 两块能力一起补：(1) 收敛成 **2 tool（`subagent` + `agent_send`）+ 事件流**，走 Pi `agent.steer(msg)` 自动注入 `<agent-notification>`；(2) 子进程改 **`--mode rpc` + `--session-id`**（B+C 组合），`agent_send` 走 stdin JSON 命令，保 provider cache + transcript 延续 + crash 兜底 recover | 🔴 **P0** |
| **Plan Mode** | `EnterPlanMode` / `update_plan` 退化成 slash-only；plan 数据靠 `[DONE:n]` / `1./2.` 正则从文本抠 | **加 2 + 4 = 6 tool**：`enter_plan_mode`（无入口 gate 自动进）+ `exit_plan_mode`（出口 UI 弹 3 选）+ `task_create/update/get/list`（对齐 Claude Code `TaskCreate` 家族，跟 plan mode 解耦）。plan 存 `.step-cli/plans/session-<id>.md` markdown 文件 | 🔴 **P0** |
| **Compaction** | 6 章 Markdown summary 被 "concise" 指令抹平；大 tool output / 重复结果挤占 window | **两层增量**：summary 内容契约扩到 8 章节 + 高保真裁剪；请求前加不落盘的轻量 context projection（大输出裁剪 / 重复折叠 / 旧进度去重）。完整 JSON checkpoint 暂缓 | 🔴 **P0** |
| **Toolset**（8 核心 + `find_tools` + `clarify_user`） | 无本质问题；Pi runtime 已经解掉 Terminal-Bench 分数对不上的历史痛点 | **不动** | 🟢 P3 |
| **System Prompt** | 缺 `# Delegation` / `# Planning` / `# Task tracking`；`<env>` 缺 5 项 | **小改**：随三条 P0 计划各自的 patch 补齐；`<env>` 补 git branch / uncommitted / operating mode 三项 | 🟢 P2 |

**执行顺序**：三条 P0 物理文件几乎不重叠，可**独立 PR 独立 rollback**；`system-prompt.ts` 是共用点（各加一段），可合到一个前置小 PR 打底。推荐 `subagent + plan mode` 挂在同一批 extension 改动，`compaction` 独立分 P0-P4 灰度上线。

---

## 落地状态（2026-09-02 workflow #2+#3；2026-09-03 refactor pass）

4 条分支全部实现完成并通过独立复核（α/β/γ/δ 四轨）+ 2026-09-03 refactor pass，待合并。推荐合并顺序：`feat/compaction-summary-quality` → `feat/compaction-lightweight-projection` → `feat/subagent-event-flow-rpc` → `feat/plan2-plan-mode-task-tracking`。冲突面（merge-tree 实测）：A×B 仅 `step-system-prompt.test.ts` 一处冲突（keep-both 即解；`system-prompt.ts` 本体两段自动合并）；C×δ 在 `packages/agent/src/index.ts` export 块相邻 hunk（C 移 `serializeConversation` 到 utils re-export，δ 追加 projection exports，keep-both）；δ 基线比 A/B/C 新一个 merge（`77b2489` vs `f748d96`），本地 shallow clone 算不出跨基线 merge-base，服务端合并不受影响。

| Plan | 分支 | 基线 | commits | diff vs 基线 | 状态 |
|---|---|---|---|---|---|
| Plan 1 | `feat/subagent-event-flow-rpc` | `f748d96` | 17 | 10 files, +2016/−1002 | S0/S1/S2a/S2b/S3 全部完成；alias-escape blocker 已由 α 修复（`0b8c59b` content 位转义）；parallel-lane stopLane 已由 α 修复（`bf01f25`）；refactor pass 完成（6 模块，见下） |
| Plan 2 | `feat/plan2-plan-mode-task-tracking` | `f748d96` | 25 | 13 files, +2271/−215 | P0/P1/P2/P3 全部完成；β 修复 medium defect：`task_update` 原子性（`e0e3367`）+ task id 单调不复用（`c1a5581`）；γ 落 P2 legacy 清理 + P3 planSource 迁移 / `/todos` / UI chip / telemetry + rpc-mode exit_plan_mode 自动 approve |
| Plan 3 层1 | `feat/compaction-summary-quality` | `f748d96` | 7 | 10 files, +446/−210 | P1 完成：8 章节 summary prompt 重写 + `serializeConversation` head+tail+salient 裁剪 + golden fixture |
| Plan 3 层2 | `feat/compaction-lightweight-projection` | `77b2489` | 8 | 15 files, +2221/−2 | P2 完成：`projectContextForRequest` 5 规则 + 3 invariant + AgentSession 接入，默认 off（flag `step.compaction.contextProjection`） |

**Refactor pass（2026-09-03，每 commit 独立验证绿）**：
- Plan 1（+6 commits，refactor 段 +1558/−1353）：`step-subagent.ts` 1844 → 555 行；拆出 `extensions/subagent/` 6 模块——`rpc-adapter.ts`（397 行，`createSubagentRpcSession` stdio JSON + acks + ui-cancel）、`execute.ts`（397 行，`executeSubagent` orchestrator + 单消费者 helper 转 private）、`lane-lifecycle.ts`（309 行，`createLaneLifecycle` startLane 状态机 + stopLane）、`rendering.ts`（157 行，TUI render helpers）、`helpers.ts`（125 行，纯工具）、`lane-events.ts`（109 行，5 事件类型 + escape + throttle）；全部 verbatim move（逐块 diff 对 HEAD 验证）；6 新模块 0 `any` / 0 silent catch
- Plan 2（+4 commits，refactor 段 +421/−326）：`step-plan.ts` 407 → 280 行；抽出 `plan-mode-tools.ts`（142 行，tool 注册 + `StepPlanModeController` 接口）、`plan-mode-migration.ts`（56 行，legacy PlanState todo 迁移）、`step-tasks-import.ts`（47 行，import 协议）；`exit_plan_mode` execute ~57 → ~38 行，`task_update` 46 → 23 行；重复 persisted-state 字面量 → `persistPlanState()`，write-tool 重加 → `allowPlanFileWrites()`
- Plan 3 层1（+3 commits，refactor 段 +184/−95）：`safeJsonStringify` 双 copy 各收敛为 utils.ts 单一 export（顺带修掉 coding-agent 侧裸 `JSON.stringify` 漂移）；`SALIENT_LINE_PATTERN` 扩 stack-frame 模式（`traceback|File "|-->|\S+\.\w+[:(]\d+`）+ python-traceback fixture 测试；两份 compaction utils byte-for-byte 对齐
- Plan 3 层2（+4 commits，refactor 段 +1066/−1598）：coding-agent 侧 838 行 mirror copy → 27 行 named re-export（byte-identity 测试改 function-identity delegation 测试）；canonical `projection.ts` 838 → 243 行 + 5 个子模块（rules 293 / content 182 / options 141 / salient 131 / invariants 127），新模块最大函数 36 行；`finalizeProjectionResult` 从入口函数抽出

**遗留 follow-up**（本轮未修）：
- Plan 1：stale `agent_settled` race；`isolateWorkspace` worktree cleanup；session 文件 gc（24h TTL / `/subagent gc`）；provider cache 命中率与 kill -9 crash-recovery fixture 未实测；fg/chain 专项 fixture 未落；`createSubagentRpcSession`（276 行）/ `createStepSubagentExtension`（137 行）仍超 50 行——verbatim-move 原则下未拆函数体，后续可再收敛
- Plan 2：`examples/extensions/plan-mode/` 中 Pi upstream 样例仍含 legacy 模式（仅示例，`src/` 零残留）；tool-section token 变化未实测
- Plan 3：~~层1 `SALIENT_LINE_PATTERN` 未含 stack-frame~~ / ~~`safeJsonStringify` 双份待去重~~ 已在 refactor pass 解决；**跨轨残留（cross-track audit）**：δ 的 `projection-content.ts:36` 有一份新的 private `safeJsonStringify`（与 C 的 canonical export 同目录同 body，分支内无法互引，合并后 1 行 import 即解）；`SALIENT_LINE_PATTERN`（C，module-private ×2）与 `SALIENT_LINE_REGEX`（δ，exported ×1）regex source 已 byte-identical，合并后可统一到单一 export；`packages/providers` 内 3 份 pre-existing `safeJsonStringify` 为存量问题非本轮引入；P3 paired replay / canary 与 P4 默认切换未启动

---

## Plan 1 — Subagent 事件流重构 + 持续对话

### 验证阶段发现（workflow #1）

对本计划的关键假设做过一轮代码级验证，5 条结论直接约束下文设计：

1. **事件回流的正确通道是 `pi.sendMessage(...)`，不是 `ctx.agent.steer`**——`ctx.agent` 不存在。Extension 侧 API 是 `pi.sendMessage({customType, content, display}, {deliverAs: "steer"})`（`core/extensions/types.ts:1369-1372`），内部经 `AgentSession.sendCustomMessage`（`agent-session.ts:1511`）路由到 `Agent.steer`
2. **`--mode rpc` 的 stdout event shape 跟 `-p --mode json` 完全一致**——`parseJsonEvent` 不需要改（S2a 原"需验证"项已闭环，不需要 adapter）
3. **`--session-id` load 路径确认可用，但有 5 个 caveat**：strict cwd 匹配 / lazy flush（transcript 非实时落盘）/ cwd 不存在时直接 exit / 无文件锁 / compaction 后 view 与全量 transcript 有差异
4. **`requireApproval` 不存在**——佐证 Plan 2 "入口无 gate" 的决策成立
5. **Hook 顺序**：`emitToolCall` 没有 try/catch，多个 hook 同时注册时 first block wins——write 例外 hook 的注册顺序有语义

### 目标 + 心智

**目标**：两块能力一起补齐，全面对齐 Claude Code：

1. **事件流**：5 个 lane 管理 tool（`subagent` + `agent_reply` / `wait` / `interrupt` / `list`）收敛成 **1 spawn + 1 send**；消灭 `agent_wait` 同步阻塞 anti-pattern。事件（完成/进度/失败/中断/主动请示）走 Pi 已有的 `agent.steer(msg)` 通道自动作为 `<agent-notification>` 回流到父 assistant turn
2. **持续对话（B+C 组合，新增）**：subagent 子进程从"一 turn 一 spawn（`--no-session -p`）"改成"一 lane 一 long-running 子进程（`--mode rpc --session-id`）"，`agent_send{action:"reply"}` 走 stdin JSON 命令直接 inject 到 running child——**保 provider cache，transcript 自然延续**；子进程 crash 或 parent restart 时用同 `--session-id` respawn 从 disk 恢复

**改动只动 `step-subagent.ts` + `system-prompt.ts`；Pi runtime 零改动**——`agent.steer(msg)` 异步通道和 `--mode rpc` 完整 stdin JSON 命令协议都已经现成（`modes/rpc/rpc-types.ts`）。

**心智**：跟 Claude Code 一致——
- 事件流 = "发邮件 → 后台跑 → 完成/进展/主动请示自动作为 `<agent-notification>` 回流"（对应 `Agent` + `<task-notification>`）
- 持续对话 = "发消息给已有 agent，从它的 transcript 继续"（对应 `SendMessage`，CC 原文 `"a send resumes it from its transcript"`）

**非目标**：不搬 in-process teammate / 7 种 IPC 消息 / plan approval / delegated model 解析器。

### 关键机制：Pi 已有的两条现成通道

**通道 1 — 事件回流（child → parent）**：

- `packages/agent/src/agent.ts:282-290` — `agent.steer(msg)` 把消息入队 `steeringQueue`
- `packages/agent/src/agent-loop.ts:167,194-208,257` — 每 turn 边界 poll `getSteeringMessages()`，取出消息插入到下 turn 开头
- `packages/agent/src/harness/messages.ts:31-38,137-144` — `CustomMessage{role:"custom",customType,content}` 通过 `convertToLlm` 渲染成 `role:"user"` text message

Subagent extension 只要在 lane 生命周期事件处调 `pi.sendMessage({customType, content, display}, {deliverAs: "steer"})`（extension API 签名见 `core/extensions/types.ts:1369-1372`；注意 **`ctx.agent` 不存在**，不能写 `ctx.agent.steer(customMessage)`），父 agent 下一 turn 就能读到——`sendMessage` 内部经 `AgentSession.sendCustomMessage`（`agent-session.ts:1511`）路由到 `Agent.steer`。这是 Claude Code `<task-notification>` 的本地等价物。

**通道 2 — RPC stdin 命令（parent → child）**：

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — step CLI 的 RPC 模式，long-running 不退、stdin 读 JSON 命令、stdout 输出 event stream
- `packages/coding-agent/src/modes/rpc/rpc-types.ts:22-24` — 已定义的关键命令：
  ```ts
  { type: "prompt";    message: string; streamingBehavior?: "steer"|"followUp" }
  { type: "steer";     message: string }    // 中间打断插入
  { type: "follow_up"; message: string }    // 队列追加，当前 turn 跑完继续
  { type: "abort" } | { type: "compact" } | { type: "get_messages" } | ...
  ```
- `packages/coding-agent/src/main.ts:585-599` — `--session-id <id>` 存在就 load transcript，不存在就新建

Subagent extension 只要把子进程从 `--mode json -p --no-session` 改成 `--mode rpc --session-id <lane-uuid>`，parent 就能通过 stdin 写 JSON 命令保持长跑对话，且 session 自动落盘可 recover。

### 新 tool 面（2 把）

```
subagent      { agent?, task?, tasks?[], chain?[],
                agentScope?, cwd?,
                run_in_background?, alias?, group?,
                subscribe?: "final"|"progress"|"none" }

agent_send    { to: { agent_id?, alias?, group?, all? },
                action: "reply"|"stop",
                prompt?, interrupt?: boolean }
```

| 旧 tool | 新去向 |
|---|---|
| `subagent`（fg / bg / parallel / chain） | 保留，仅加 `subscribe` 决定通知详略 |
| `agent_reply` | `agent_send{action:"reply"}` |
| `agent_wait` | **删除**——由 `background_done` 事件自动注入代替 |
| `agent_interrupt` | `agent_send{action:"stop", interrupt:true}` |
| `agent_list` | **删除**——模型从自己 transcript 里 spawn 记录 + notification 记录看到；诊断用 `/agents` slash |

`agent_send` 合并 `reply` 和 `interrupt`：`to`（收件人）+ `action`（动词）+ `interrupt` boolean 是三个正交维度，比拆两把工具更贴心智。

### 事件流：`<agent-notification>` 5 类

按 `subscribe` level 分档：

| 事件 | `subscribe:"final"` | `subscribe:"progress"` | 触发点 |
|---|---|---|---|
| `background_done` | ✅ | ✅ | lane 完成（成功） |
| `background_failed` | ✅ | ✅ | lane 失败 |
| `background_interrupted` | ✅ | ✅ | 父调 `agent_send{action:"stop"}` 后 |
| `background_needs_input` | ✅ | ✅ | 子 agent 通过 `agent_send{to:"main"}` 主动汇报 |
| `background_progress` | ❌ | ✅（15s 合并一次） | lane onUpdate 增量 |

默认 `subscribe:"final"`——一 lane 只回一条完成通知，最省 token。多 lane 同 turn 完成时合并成 `<agent-notification-batch>`。

**挂钩点**（`step-subagent.ts` 现有代码）：
- `startLane.onUpdate` (`~1175`) → `background_progress`（限流）
- `startLane.then` (`~1191-1210`) → `background_done` / `background_failed`
- `agent_interrupt` 现路径 (`~1381-1392`) → `background_interrupted`
- `runStepSubagentProcess` JSON 事件循环新增 `{type:"progress-report"}` 识别 → `background_needs_input`

### 持续对话：`--mode rpc` + `--session-id`（B+C 组合）

**当前 stateless 行为的根因**（`step-subagent.ts:576-593,1205-1208,1329-1333`）：

```ts
const args = ["--mode", "json", "-p", "--no-session"];  // ← --no-session + -p print 模式
args.push(`Task: ${input.task}`);                        // ← task 是 CLI arg，一 turn 就退
// agent_reply 路径：
const next = lane.queuedPrompts.shift();
if (next) startLane(lane, { ...lane.params, task: next });  // ← 新 subprocess，只带新 task
```

= 每次 reply 都是新进程 + 忘掉之前所有对话。跟 Claude Code `SendMessage` 的 `"resumes from transcript"` 语义相差最远。

**目标设计（B+C 组合）**：

```
Parent                          Child (--mode rpc --session-id lane-abc12, long-running)
  │                              │
  │  spawn 一次，长跑             │  transcript 落盘同时保留
  │                              │
  │  首次 task                    │
  │  ── {type:"prompt",...}   → │→ 跑一 turn → stdout event stream
  │                              │← ready，等下一条 stdin
  │                              │
  │  agent_send{action:"reply",  │
  │              interrupt:false}│
  │  ── {type:"follow_up",...} → │→ append transcript，继续 turn
  │                              │
  │  agent_send{action:"reply",  │
  │              interrupt:true} │
  │  ── {type:"steer",...}    → │→ 中断当前 turn，立即插入新 prompt
  │                              │
  │  agent_send{action:"stop"}   │
  │  ── {type:"abort"} + close  → │→ 中断+退出
  │  stdin                       │
  │                              │
  │  [C 挂了 / parent restart]    │
  │  respawn 同 --session-id    → │→ SessionManager load prior transcript
  │                              │  从上次断点无缝续跑（B 兜底路径）
```

**`agent_send` 3 种映射**：

| `agent_send` 参数 | 对应 stdin JSON | Pi 侧行为 |
|---|---|---|
| `action:"reply", interrupt:false` | `{type:"follow_up", message}` | 排队追加，当前 turn 跑完自动继续 |
| `action:"reply", interrupt:true` | `{type:"steer", message}` | 中间打断，立即插入到 turn 里（走 Pi 的 steeringQueue） |
| `action:"stop"` | `{type:"abort"}` + close stdin | 中断当前 turn + 子进程退出 |

**改动清单**（`step-subagent.ts`，净 ~20 行）：

| 位置 | 改动 |
|---|---|
| `runStepSubagentProcess:579` | args 改 `["--mode", "rpc", "--session-id", input.sessionId]`，去掉 `--no-session` `-p` 和 `Task:` 拼接 |
| `runStepSubagentProcess:623` | child stdio 打开 stdin write pipe（原来 `"ignore"`）|
| `runStepSubagentProcess` 新增 | `sendRpc(cmd)` helper：`child.stdin?.write(JSON.stringify(cmd) + "\n")`；首次 task 用 `{type:"prompt"}` 发进去 |
| `agent_send` execute（新 tool） | action → rpc command 映射（上表） |
| `startLane` 生命周期（`1191-1220`） | 不再 `.then` 里 respawn；改成监听 child `close` event，非主动 stop 触发 respawn with same `session-id`（B 兜底） |
| `createLane:1221` | 生成稳定 `subagentSessionId = "subagent-" + randomUUID()` 并存到 `BackgroundAgentLane` |
| `agent_reply/interrupt` 老 tool 路径（`1312-1408`） | 保留一版兼容期，内部转发到新 `agent_send`；S3 阶段 hard-delete |

**S2a rpc 迁移 — `runStepSubagentProcess` 10 项具体改动（权威清单）**：

- (a) spawn stdio 改 `["pipe","pipe","pipe"]`（原 `["ignore","pipe","pipe"]`）
- (b) args 改 `["--mode","rpc","--session-id",<laneSessionId>]`；去掉 `-p`、`--no-session` 和 `Task:` argv 拼接
- (c) 首次 task 通过向 child.stdin 写 LF 分帧的 `{"type":"prompt","id":<uuid>,"message":<taskText>}` 发送
- (d) reply：`{"type":"follow_up",...}` 或 `{"type":"steer",...}`
- (e) stop：`{"type":"abort"}` 然后 close stdin
- (f) turn 完成以 stdout `{"type":"agent_end"|"agent_settled"}` 事件为准（不再是 child close——child 长跑不退）
- (g) stdout 先按 JSON type 路由、**再**进 `parseJsonEvent`：`{"type":"response",...}` ack 按 id 关联；阻塞型 `{"type":"extension_ui_request",...}` 自动应答 `{"type":"extension_ui_response","id":<same>,"cancelled":true}`——否则 child 会无限挂起
- (h) per-turn 状态重置（长跑 lane 里 usage / messages 会跨 prompt 累积）
- (i) LF-only 分帧
- (j) MAX_JSON_LINE_BYTES 2MB 守卫：超大 response payload 单独关联处理

**Pro**：
- Provider cache 完整保留（子进程内 KV 不 reset），多轮 reply 快且省钱
- Transcript 自然延续，模型看得到自己上一轮说了啥
- 崩溃兜底完整：child crash / kill -9 / parent restart 都能从 disk recover
- 老 stepcli teammate 的持续对话语义拿到了，但不用 in-process 共享内存
- 复用现成 Pi RPC 协议，**Pi 侧零 API 改动**

**Con / 需验证**（S2a 阶段解决）：
- `--mode rpc` stdout event shape 跟当前 `-p --mode json` 是否**完全一致**——golden fixture 对齐；不一致就在 `parseJsonEvent` 加一层 adapter
- session 文件累积 → 加 `/subagent gc` slash 或 24h TTL cleanup（P3 后补）
- Zombie child：parent 死掉必须带走 child——用 process group 或 SIGHUP forward，扩展现有 `abortTimer` 逻辑

### System prompt `# Delegation`（20 行内）

在 `packages/coding-agent/src/step/system-prompt.ts:buildStepSystemPromptAppendix` 加一段：

- 使用 `subagent` 的时机（隔离/并行/长跑）
- **背景 lane 是事件驱动、不要 poll**，`<agent-notification>` 会自动出现在下一 user turn 开头
- **`agent_send` 是给已有 lane 追加消息**，lane 保留完整 transcript；`interrupt:false`（follow_up）等当前 turn 跑完再继续，`interrupt:true`（steer）立即插入；`action:"stop"` 干掉
- 默认 `subscribe:"final"`，review/audit agent 用 `subscribe:"progress"`
- **明确不提 `agent_wait` / `agent_list`**（避免模型误召）

同一 patch 里把 `<env>` 补 git branch / uncommitted / operating mode 三项（P2 共用项）。

### 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S0（1d）** | `startLane.then` 加 `background_done` steer + `subscribe:"final"` 语义，5 tool 全保留；子进程仍走老 `-p --no-session` | Smoke：bg lane 完成后父 agent 下一 turn 看到 `<agent-notification>` |
| **S1（2d）** | `progress` 限流 + `failed` + `interrupted` + `needs_input` 四事件 | Fixture：5 类事件都能进父 transcript，限流不漏 |
| **S2a（2d，rpc 迁移）** | `runStepSubagentProcess` 切 `--mode rpc --session-id`；实现 `sendRpc()` helper；对齐 rpc event shape 到现有 `parseJsonEvent`；zombie 处理 | Golden fixture：单 lane 长跑 3 轮 reply（1 `follow_up` + 1 `steer` + 1 `abort`）transcript 正确延续，provider cache 命中率 > 80% |
| **S2b（1d，tool 面切换）** | 上线 `agent_send` 新 tool，action → rpc command 映射；`agent_reply/interrupt` 标 deprecated 内部转发；`agent_wait/list` `hidden:true`；`# Delegation` 上线 | 现有 replay 在新 tool 面下能完成；deprecated tool 走 `agent_send` 转发 |
| **S3（2d）** | 硬删 4 个旧 tool；tool count 14 → 11；补 crash recovery fixture（kill -9 child → respawn resume）| RL baseline 稳定，无 tool-not-found，crash recover 通过 |

**总周期 8 day**（原 6 day + rpc 迁移 2 day）。

### DoD

- [x] `subagent` + `agent_send` 上线；`agent_reply/wait/interrupt/list` 从 default profile 删除（S2b + S3 硬删，仅剩 2 个 registerTool）
- [x] 5 类 `<agent-notification>` 在 CLI + `--json` 模式都能进 assistant turn（S0+S1；alias 在 attribute + content 双位置转义）
- [x] 子进程走 `--mode rpc --session-id`；`agent_send` 3 种 action 全部映射到 rpc command（reply→follow_up / interrupt→steer / stop→abort+close stdin）
- [x] 单 lane 多轮 reply（含 follow_up / steer / abort）transcript 正确延续（provider cache 命中率 > 80% 未实测——遗留）
- [ ] Child crash / kill -9 后同 `--session-id` respawn 能从 disk 恢复 transcript（respawn 逻辑已实现；kill -9 fixture 未落）
- [x] `# Delegation` + `<env>` 补齐；不再提 wait / list（`<env>` git/mode 三项落在 Plan 2 分支 `110fce2`）
- [ ] fg / bg / parallel / chain / interrupt 5 case fixture 全 pass（bg/parallel/interrupt/subscribe/needs_input 已覆盖 20/20；fg/chain 专项 fixture 未见）
- [x] tool count 14 → 11（tool-section token 减幅未实测）
- [ ] Terminal Bench 无回退（未跑）

### 立即执行三件事

1. `step-subagent.ts` 最小验证：`startLane.then` 里加一句 `pi.sendMessage({customType: "agent-notification", content: "Completed", display: false}, {deliverAs: "steer"})`，验事件流通道
2. **验 rpc 通道**：手写最小 script `spawn(step, ["--mode","rpc","--session-id","test-lane"])` + stdin write `{"type":"prompt","message":"hi"}` + 再写一条 `{"type":"follow_up","message":"say more"}`，看 stdout event shape 跟现有 `-p` 模式的差异（决定 S2a 里 `parseJsonEvent` 要不要 adapter）
3. `docs/exec-plans/subagent-event-flow-rpc/` 拆 S0-S3 卡片 + fixture 清单 + zombie/crash recovery 用例

---

## Plan 2 — Plan Mode 严格对齐 Claude Code（入口自动、出口 gate）

### 目标 + 心智

**目标**：入口**自动**（agent 觉得任务大直接调 `enter_plan_mode`，无 UI 阻断）、出口 **gate**（`exit_plan_mode` 弹 UI 3 选）、plan **存文件**（`.step-cli/plans/session-<id>.md` markdown，agent 用 `write_file` 写）。task 追踪 4 tool 跟 plan mode **完全解耦**，任何 mode 可用。

**改动面**：改 `step-plan.ts` + 新加 `step-tasks.ts` + `system-prompt.ts` 加 `# Planning` + `# Task tracking`。**Pi runtime 零改动**。

**跟 Claude Code 的 4 处分歧**（其余维度全对齐）：
1. **入口不 gate**——CC `"REQUIRES user approval"` 是 CC CLI permission model；step-harness RL/自动化常态不适合每次弹 UI；出口 gate 已经承担用户 attention
2. **出口 3 选**（Execute/Stay/Refine）——跟现有 `/plan` slash UI 一致
3. **`task_create` snake_case**——跟 step-harness 8 核心 tool 命名规约一致
4. **`/plan` slash + `--plan` flag** 保留——跟 CC 的 Shift+Tab shortcut 各自 TUI 惯例，语义等价

**非目标**：不引入结构化 `update_plan` tool（进度追踪走独立的 `task_*` 4 把工具）；不做 plan file schema 校验。

### 新 tool 面（2 + 4 = 6 把）

**Plan mode 2 把（无参数）**

```
enter_plan_mode {}   // 无入口 gate；agent 调即生效
exit_plan_mode  {}   // plan 已经在文件里，UI 弹 3 选
```

**Task tracking 4 把（跟 plan mode 解耦，参数逐字对齐 Claude Code `TaskCreate` 家族）**

```
task_create   { subject, description, activeForm?, metadata? }
              → returns taskId; 初始 status="pending"
task_update   { taskId, status?, subject?, description?, activeForm?,
                owner?, metadata?, addBlocks?[], addBlockedBy?[] }
task_get      { taskId }  → subject/description/status/blocks/blockedBy
task_list     {}          → [{id, subject, status, owner, blockedBy}]
```

Task 数据存 in-memory `Map<taskId, Task>` + Pi session entry persist（session reload 恢复），~150 行 TS。

### Plan 文件 + write 例外

**约定路径**：`<projectRoot>/.step-cli/plans/session-<sessionId>.md`（项目本地，便于 gitignore/commit）

**write 例外**：`pi.on("tool_call")` hook 里对 `write_file` / `edit_file` 单独放行 plan 文件路径；其他路径拒绝：

```ts
pi.on("tool_call", async (event) => {
  if (!enabled) return;
  if (event.toolName === "write_file" || event.toolName === "edit_file") {
    const planPath = getPlanFilePath();
    if (path.resolve(event.input.path) === path.resolve(planPath)) return;
    return { block: true, reason: `Plan mode blocked mutation. Only ${planPath} may be written.` };
  }
});
```

`enable()` **不**从 active tool set 里删 `write_file`/`edit_file`（保留，模型能看到能调），只在 hook 里对非 plan-file 目标拒绝。**Bash 全开**（删掉旧 `isSafeCommand` 白名单），跟 CC 一致。

> **session_start reload 注意**：session_start 恢复 plan mode 的路径**必须**在调用 `enable()` 之后把 `write_file`/`edit_file` 重新加回 active tool set——现有 `enable()` 实现会把它们从 active set 剥掉，不补回的话 resume 回 plan mode 的 session 会失去 plan 文件的可写性。

### 状态机（2 态）

```
                        enter_plan_mode {}
                        or /plan / --plan
        ┌──────────┐  ────────────────▶  ┌──────────┐
        │  Normal  │                     │ Planning │
        │  (all    │                     │  (write  │
        │  tools)  │  ◀────────────────  │  只对    │
        └──────────┘  exit_plan_mode {}  │  plan    │
                      + user "Execute"   │  文件)   │
                                         └──────────┘
```

`Executing` 不作为独立 mode（CC 也没有）；执行阶段的进度追踪由 agent 自己用 `task_*` 4 tool 完成。

**出口 UI 3 选**（`exit_plan_mode` 内实现）：
- **Execute** — `restore()` mutating tool，plan 文件保留在 disk，agent 后续可 `read_file` 参考
- **Stay in plan mode** — agent 继续 planning
- **Refine** — 用户在 editor 输入 refinement，作为 follow-up user message 送给 agent（复用现有 `sendUserMessage(..., {deliverAs:"followUp"})`），agent 更新 plan 文件后重调 `exit_plan_mode`

### 现有资产处理

| 现有资产 | 处理 |
|---|---|
| `MUTATING_TOOLS` set (`step-plan.ts:15`) | 保留，用来判"是否需要 write 例外 hook" |
| `enable()` / `restore()` / `toggle()` | 保留，被 `enter_plan_mode` / `exit_plan_mode` 内部调 |
| `/plan` slash + `--plan` flag | 保留（用户手动兜底，不需 gate） |
| `isSafeCommand` + `run_command` 白名单 (`58, 195`) | **删除**（Bash 全开对齐 CC） |
| `[STEP PLAN MODE ACTIVE]` hidden meta (`217-223`) | 内容改成"写 plan 到 `<planPath>`；讨论用 clarify_user；ready 调 exit_plan_mode" |
| `[STEP PLAN EXECUTION]` hidden meta (`228-238`) | **删除**（execution 无 special mode） |
| `[DONE:n]` 正则 (`245`) | **删除** |
| `extractPlanItems` (`270`) | **删除**（plan 是文件） |
| `pi.on("agent_end")` UI gate (`255-289`) | **删除**（`exit_plan_mode` tool call 是显式触发点） |
| `todos: PlanItem[]` in-memory 状态 | **删除**（被 `task_*` 取代） |
| `/todos` slash | 重写为读 `task_list()` 结果 |
| `persist({enabled, executing, todos, toolsBeforePlanMode})` | 简化为 `{enabled, toolsBeforePlanMode, planFilePath?, planSource?: "user"\|"agent"}` |

### System prompt 加两段

- **`# Planning`**（≤20 行）：agent 判断"多文件/有决策/需求模糊"时调 `enter_plan_mode`；**明确写"无 UI gate"**；plan mode 内 tool 白/黑名单；写 plan 到 `enter_plan_mode` 返回的路径；`exit_plan_mode` 无参数，UI 3 选（Execute/Stay/Refine）；skip 单步任务和纯 Q&A
- **`# Task tracking`**（≤15 行）：多步任务用 `task_create`；in_progress **前**、completed **完成时立即**（不批量）；遇 blocker 保留 in_progress + 新 task 描述障碍；skip trivial 单步；跟 plan mode 无关任何 mode 可用

### 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0（1d）** | `enter_plan_mode` 上线 + **最小 `exit_plan_mode` stub**（`enter_plan_mode` 的 tool result 会提到 `exit_plan_mode`，所以 stub 必须在 P0 就 ship——否则 agent 会去调一个不存在的 tool；stub 只做 `restore()` + 退出 plan mode，无 3 选 UI）；plan 文件路径生成 + write 例外 hook；`# Planning` | Smoke：agent 自动进 → 写文件 → 调 `exit_plan_mode` stub 退出 → mutating 恢复 |
| **P1（1.5d）** | `exit_plan_mode` stub 升级为完整 3 选 UI select flow（Execute/Stay/Refine）；`task_*` 4 tool + Pi session entry persist；`# Task tracking` | Fixture：task 全生命周期 (create → in_progress → completed)；出口 3 选 UI 三条路径各一 case |
| **P2（0.5d）** | 删 `[STEP PLAN MODE ACTIVE/EXECUTION]` / `[DONE:n]` / `extractPlanItems` / `isSafeCommand` | 老 session 升级恢复；新 session 无 nag/DONE/Bash 限制 |
| **P3（0.5d）** | `/todos` 改读 `task_list`；`persist` shape 迁移；UI 状态栏 chip 显示 mode + `planSource`；telemetry 补齐 | UI 看到 Normal/Planning 二态；`/todos` 显示 task_list |

### DoD

- [x] `enter_plan_mode` + `exit_plan_mode` 上线（无入口 gate，出口 3 选 UI；rpc 模式自动 approve `5c738c7`）
- [x] `task_create/update/get/list` 上线，参数逐字对齐 Claude Code（β 补：`task_update` 全量前置校验原子化 + id 单调计数器持久化）
- [x] plan 文件路径 + write 例外 hook 工作正常；`isSafeCommand` 删除（`9588803`）
- [x] `# Planning` + `# Task tracking` 段落上线（`110fce2`，同 commit 补 `<env>` git/mode 三项）
- [x] 4 条 legacy 路径（`[STEP PLAN MODE ACTIVE]` / `[STEP PLAN EXECUTION]` / `[DONE:n]` / `extractPlanItems`）删除（`src/` 零残留；`examples/` Pi 样例除外）
- [x] `/plan` / `--plan` / `/todos` 全部适配（`/todos` 改读 task_list 快照）
- [x] Session reload 兼容旧 `PlanState`（一次性迁移 + planSource 字段，`273a0f4`）
- [x] tool count 净 +3（subagent -3、plan mode +2、task +4）（tool-section token 变化未实测）
- [ ] Terminal Bench 无回退（未跑）

### 立即执行三件事

1. `step-plan.ts` 加 `enter_plan_mode` 一个 tool（30 行 + `getPlanFilePath()` + write 例外 hook），smoke 验通道
2. `step-tasks.ts` 骨架（4 tool + `Map<taskId, Task>` + session entry persist），跟 CC `TaskCreate` 家族逐字对表
3. `docs/exec-plans/plan-mode-strict-alignment/` 拆 P0-P3 卡片 + 端到端 fixture（enter → write plan → exit → Execute → task_create ×3 → task_update ×3 → task_list → 结束）

---

## Plan 3 — Compaction Summary 质量 + 轻量 Context Projection

### 目标 + 两层结构

**目标**：解决两个具体问题——(1) summary 太薄（当前 6 章节 + "Keep each section concise" 把文件/测试/失败原因抹平）；(2) 有效上下文被噪声挤掉（长 tool output / 重复搜索 / 重复进度 / 历史 thinking）。

**两层增量方案**（不动 Pi agent loop / compaction trigger / cut point / retained tail / session entry lifecycle）：

```
现有 entries / compaction 生命周期（保持不变）
        │
        ├── full compaction：仍由当前 summary 机制触发
        │       └── 层 1：提高 summary prompt 质量、证据保真度、更新规则
        │
        └── request-time lightweight projection（新增，可关闭）
                └── 层 2：只压缩送给模型的冗余消息，不改 session transcript
```

**默认策略**：改造完成 + replay/canary 验证后，默认启用 `detailed-v1 + lightweight-v1`。开发期用 `current + off` 作 control，紧急回滚也走 `current`。

**明确暂缓**：完整 JSON `StepCompactionCheckpointV2` schema、stable ID、字段级 merge、`automatic + agent` 双触发、跨 session migration、把 subagent event stream 跟 compaction 绑成统一协议——都不在本轮 TODO；本轮方案跑通如果仍无法满足语义连续性，再另开 ADR 评估。

### 层 1：Summary 内容契约（Markdown，8 章节）

保留 Markdown 作为兼容格式，从"简短摘要"提升为"下一位 agent 可直接接手的工程交接记录"：

| 章节 | 必须保留 | 细节要求 |
|---|---|---|
| `## User Goal` | 当前用户目标、验收条件、追加目标 | 保留用户原意；多目标分条，不把历史目标误写为 active |
| `## Current State` | `Done / In Progress / Blocked` | 每项写结果或卡点，避免只写"处理了/继续中" |
| `## Files & Artifacts` | 创建/修改/回滚/删除路径；关键函数/类 | 路径和 symbol 原样保留；说明变更目的或 disposition |
| `## Verification` | 最近命令、测试、退出码、关键输出 | `PASS/FAIL/BLOCKED` 明确；保留最能定位问题的 error 行 |
| `## Decisions & Constraints` | 用户偏好、技术取舍、环境限制 | 区分明确约束 vs 模型推断；不能把猜测写成事实 |
| `## Failed Approaches` | 已试失败/不适用的方案 | 写失败原因和避免重复的条件 |
| `## Next Actions` | 下一步 1-5 个可执行动作 | 每项含动作、目标文件/命令、完成判据 |
| `## References` | issue / 日志 / 产物 / 关键 transcript 范围 | 只放能帮恢复的引用；无则 `(none)` |

**详细程度规则**（≤ 6 条，写进 prompt）：精确保留高价值字符串（路径/函数/命令/退出码/错误行）；结果优先于过程；保留负面信息；事实与推断分开；禁止"修复了 bug"这种无 actionable 的句子；先删重复修辞和已关闭背景，最后才裁 active goal / verification / next action。

**输出预算**：初始 1.5-3k tokens；预算优先级 `User Goal / Current State / Verification / Next Actions` > `Files / Constraints` > 历史背景。

### 层 2：Lightweight Context Projection（不落盘）

**性质**：确定性、可关闭、纯函数投影；不调模型、不生成新 compaction entry、不改 `summarizedUntil`；session entry 和 transcript 文件完全不动。只在估算 token 接近 soft threshold 时才运行。

**投影规则（无损优先）**：

| 输入 | 轻量处理 | 必须保留 |
|---|---|---|
| 超大 `toolResult` / `bashExecution` | 按行截 head + tail；额外保留匹配 `error/fail/test/exit/path/diff/warning` 的关键行 | tool 名、命令、退出码、错误行、涉及路径、截断标记、原始字符数 |
| 重复搜索/测试输出 | 规范化文本短 hash；旧结果折叠成一行 | 最近一次结果、变化点；不合并不同退出码 |
| 历史 thinking / 重复进度 | 只保留最近段或已转为结论的 | 已做的决定、未解决问题、tool call 参数、最终结论 |
| 重复的 branch / compaction summary | 只留最新一份 | 最新 summary 全文和边界信息 |
| 大片代码 / patch / JSON | 行边界截断，保留头尾和结构错误附近 | 文件路径、symbol、diff header、编译错误；明标省略范围 |
| **当前 user turn / 活动 tool-call group / 最近 retained tail** | **不压缩** | user 指令 + tool call/result 配对完整 |

被压缩消息带机器可识别标记：`[context-compacted: original_chars=48210 retained_chars=6200 omitted_chars=42010; salient_lines=18]`。任何 tool call 必须和对应 result 一起保留（result 可截断）。

**触发**：soft threshold 建议 context window 60-75%（实测后固定），基于**未投影原始 context** 判定（不能把压力藏起来）。投影失败或消息序列非法则直接 fallback 原始 messages。

### 代码落点

| 组件 | 首版改动 | 明确不做 |
|---|---|---|
| `packages/agent/src/harness/compaction/compaction.ts` | 更新 4 段 summary prompt（`SUMMARIZATION_SYSTEM_PROMPT` / `SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT` / `TURN_PREFIX_SUMMARIZATION_PROMPT`）；把 `formatFileOperations()` 输出并入 `## Files & Artifacts`；可选加 heading coverage 诊断；保留现有 `CompactionDetails` | 不新增 checkpoint schema、ID merge、compaction state machine |
| `packages/agent/src/harness/compaction/utils.ts` + `packages/coding-agent/src/core/compaction/utils.ts` | `TOOL_RESULT_MAX_CHARS=2000` head-only 截断改为可配置 head/tail/salient-lines；加重复块识别纯函数；两份实现同一策略 | 不改 session entry 原始内容 |
| `packages/agent/src/harness/session/context.ts` | 利用现有 context build seam 接入可选 message projection，或上层包一层 | 不改默认 active path / cut point 语义 |
| `packages/coding-agent/src/core/session-manager.ts` | 暴露 request-time projection 的可选参数入口 | 不改 `CompactionEntry` 序列化和旧 session 读取 |
| `packages/coding-agent/src/core/agent-session.ts` | 送入下一次 model request 前应用 projection；沿用现有 compaction hooks | 不重写 manual/threshold/overflow compaction 生命周期 |
| `test/harness/compaction.test.ts` + `test/*compaction*.test.ts` | 加 prompt fixture、summary coverage、截断/去重、pairing 测试 | 不把 subagent 事件流测试混入 |

### 分阶段

**P0 — Baseline**：固定当前 prompt/toolset/model/compaction settings 作 control；准备 4 类可重放 transcript（多文件重构 / 多轮调试失败 / 大 tool output / 含 plan+subagent result 的 long-horizon）；每份标注 reference answer。出口：能单独统计 summary 信息损失和 context 冗余。

**P1 — Summary quality**：落地 8 章节 prompt + update 规则；删 "concise" 指令；预算 1.5-3k；`serializeConversation` head+tail+salient-lines 裁剪；加 coverage 诊断和 fallback；普通/增量/split-turn prefix 各写 golden fixture。出口：summary 覆盖 reference answer 的路径/测试/失败原因/next actions。

**P2 — Lightweight projection**：实现纯函数 `projectContextForRequest`（大输出截断 + 显著行保留 + 重复折叠 + 旧进度裁剪）；保护 3 个 invariant（当前 user turn / 活动 tool-call group / retained tail）；soft threshold 触发；失败自动回退；记 `before/after tokens` + 裁剪类型。出口：context token 明显下降，无 pairing 失败，关闭时轨迹一致。

**P3 — Paired replay + canary**：三组对比（`current + off` vs `detailed + off` vs `detailed + lightweight`）；离线 replay 后 feature flag 小流量；summary 改动和 projection 改动分开归因。出口：recovery turns / 重复 read/search/test / 总运行时间不恶化。

**P4 — 默认切换**：满足 guardrail 后默认 `detailed-v1 + lightweight-v1`；保留一键回滚开关。

### 配置

两个独立 feature flag：

```
step.compaction.summary            = current | detailed-v1
step.compaction.contextProjection  = off     | lightweight-v1
```

`current + off` = 开发期 control 和紧急回滚，不是目标默认。任何 summary 生成失败/取消/coverage 失败 → 走现有 fallback；projection 出错 → 直接发原始 messages。不删除已有 summary / entries / transcript。

### DoD

- [x] 4 段 summary prompt 上线，覆盖 8 章节 + 详细度规则 + update 规则（`56cfd46`，`feat/compaction-summary-quality`）
- [x] `serializeConversation` head+tail+salient-lines 裁剪上线（`797f7a2`；salient regex 的 stack-frame 模式已在 refactor pass 补齐 `5d050cc`）
- [x] `projectContextForRequest` 纯函数上线，覆盖 5 类投影规则 + 3 invariant（`feat/compaction-lightweight-projection`，双重校验 + 失败回退原始 messages）
- [ ] P0-P4 fixture / paired replay / canary 全部通过（P1/P2 golden/unit fixture 已过；P3 paired replay / canary 未启动）
- [ ] `detailed-v1 + lightweight-v1` 默认启用；关闭开关工作（flag `step.compaction.contextProjection` 已上线、默认 off；P4 默认切换未做）
- [ ] Terminal Bench 无回退；tool-call/result pairing 失败数 = 0（pairing invariant 单测通过；TB 未跑）
- [ ] long-horizon recovery turns / 重复 read/search/test / 总运行时间不恶化（未实测）

### 立即执行三件事

1. P0 baseline：4 类 transcript 上建立 summary reference answer 和当前版本 baseline
2. 只改 4 段 summary prompt，先跑 golden fixture，确认"更详细"没变成无边界膨胀
3. 不落盘实现最小 `projectContextForRequest`，先覆盖大 tool output + 重复结果两条

---

## 关键代码位置速查

**Subagent 改动主文件**：
- `packages/coding-agent/src/extensions/step-subagent.ts`（1416 行，主改）
- `packages/coding-agent/src/extensions/step-subagent-agents.ts`（196 行，agent 发现）
- `packages/agent/src/agent.ts:282` — `steer(msg)` 通道
- `packages/agent/src/agent-loop.ts:167,194-208,257` — `getSteeringMessages` poll 点
- `packages/agent/src/harness/messages.ts:31-38,137-144` — `CustomMessage` 定义
- `packages/coding-agent/src/step/system-prompt.ts:buildStepSystemPromptAppendix` — `# Delegation`

**Plan Mode 改动主文件**：
- `packages/coding-agent/src/extensions/step-plan.ts`（318 行，改）
- `packages/coding-agent/src/extensions/step-tasks.ts`（新增，~150 行）
- `packages/coding-agent/src/step/system-prompt.ts:buildStepSystemPromptAppendix` — `# Planning` + `# Task tracking`

**Compaction 改动主文件**：
- `packages/agent/src/harness/compaction/compaction.ts`（848 行，4 段 prompt）
- `packages/agent/src/harness/compaction/utils.ts` + `packages/coding-agent/src/core/compaction/utils.ts`（`TOOL_RESULT_MAX_CHARS` 裁剪）
- `packages/coding-agent/src/core/session-manager.ts` + `packages/coding-agent/src/core/agent-session.ts` — projection 接入点

**参考（不改）**：
- `apps/cli/src/main.ts` — composition root
- `packages/coding-agent/src/step/tool-profile.ts:1135` — 8 核心 tool 定义
- `packages/agent/docs/harness.md`（2942 行）— Pi harness spec
- 旧 stepcli 参考：`/data/ai_code_base/for_multi_frame/framework/step-cli/packages/core/src/agent/`（`agent-loop.ts` / `agent-team.ts` / `conversation-memory.ts` / `conversation-memory-checkpoint.ts`）

---

## 附：数据来源

- Git commits：新 `20b5724`（step-harness main），旧 `d0bd833`（stepcli main 时点）
- 实测读过的关键文件：`step-cli.ts` / `step-cli-runtime.ts` / `step/system-prompt.ts` / `step/tool-profile.ts` / `extensions/step-subagent.ts` / `extensions/step-plan.ts` / `extensions/step-questionnaire.ts` / `extensions/step-capabilities.ts` / `main.ts` / `core/system-prompt.ts`（新）；`agent-loop.ts` / `agent.ts` / `harness/messages.ts` / `harness/compaction/compaction.ts` / `harness/compaction/branch-summarization.ts` / `agent/docs/harness.md`（Pi runtime）；`prompt/system-prompt-template.ts` / `agent/conversation-memory.ts` / `agent/conversation-memory-checkpoint.ts` / `agent/agent-team.ts` / `plugins/types.ts` / `protocol/src/index.ts` / `skills/builtin/*`（旧 stepcli）
- Claude Code 自省：`Agent` / `SendMessage` / `TaskStop` / `EnterPlanMode` / `ExitPlanMode` / `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` 的 tool 定义
