# Step-harness 长时程能力：Cron、Loop 与 Workflow

> 状态：实现中（2026-09-03）
>
> 本文定义三个彼此独立的产品方向及其交付边界：Cron、Loop、Workflow。
> Workflow 内建 HoH（Harness-of-Harness）式 `iterate()` 原语；HoH 是
> Workflow 的方法能力，不是另一个产品层或另一个交付物。

## 目标与范围

Step 目前擅长在一个 turn 内完成工作，也已经有 session、subagent、plan mode
和 compaction 能力。长时程工作还缺少三个互补但不相互从属的入口：

| 方向 | 解决的问题 | 状态范围 | 持久化 |
|---|---|---|---|
| Loop | 当前 session 稍后再继续 | session-scoped | 不落盘；session 结束即取消 |
| Cron | 在指定时间执行提醒或任务 | project/session 可见 | `durable=true` 时跨 session |
| Workflow | 一次调用编排多个 agent 和阶段 | 单次 run，可 resume | run journal 与产物落盘 |

三者都可以把通知送入 Pi 已有的 custom-message/steer 通道，但共享通道不等于
共享生命周期或共享实现。任一方向都必须能够在没有另外两个方向时编译、加载、测试
和关闭。

## 设计不变量

1. **边界独立**：Loop 不把 delay 翻译成 Cron；Cron 不依赖 Loop；Workflow 不
   依赖任一调度器。
2. **安全优先**：调度内容只作为数据注入；Workflow 的脚本执行采用受限运行时，
   不以 `node:vm` 作为安全隔离替代品。
3. **idle-only**：自动触发不得打断正在运行的 agent turn。忙碌时保留消息，
   在 `turn_end` 后投递。
4. **可审计**：创建、触发、延迟、取消、失败和停止原因都使用稳定的结构化事件。
5. **可恢复**：只有明确标记 durable 的 Cron 和 Workflow run journal 跨进程；
   Loop 的内存状态不恢复。
6. **无 UI 依赖**：RPC、JSON、print/headless 模式下行为与 TUI 一致，UI 只做
   可选展示。

## 运行时消息通道

扩展通过 `ExtensionAPI.sendMessage` 发送 custom message：

```ts
pi.sendMessage(
  {
    customType: "step-wakeup" | "step-cron" | "step-workflow",
    content: [{ type: "text", text: "[wakeup] ..." }],
    display: true,
    details: { id, source, ...safeMetadata },
  },
  { deliverAs: "steer", triggerTurn: true },
);
```

`sendMessage` 在 agent 忙碌时会进入 steering queue，在 idle 时才开始新的 turn。
扩展仍需自行实现 idle 检查和 deferred 队列，以保证 timer 到期时不丢失原因、时间和
遥测信息。

---

## 方向 A：Loop / `schedule_wakeup`

### 心智模型

Loop 是 session 内的短期 continuation：agent 发现 CI、构建或外部进程尚未完成，
安排稍后的一次检查；到点后 harness 注入 `[wakeup] <prompt>`，agent 再决定行动或
安排下一次检查。它不写磁盘，也不尝试表示日历规则。

### 工具契约

```text
schedule_wakeup({ delaySeconds, prompt, reason })
list_wakeups({})
cancel_wakeup({ id })
```

- `delaySeconds` 是整数，输入被限制在 60 到 3600 秒（含边界）；返回值说明是否
  发生 clamp。
- `prompt` 是下一 turn 的工作上下文；`reason` 是一行可展示、不可包含秘密的说明。
- 每个 wakeup 有短随机 id、创建时间、计划时间和状态；同一 session 可以有多个。
- timer 到期时若 `ctx.isIdle()` 为假，进入 deferred 集合；下一次 `turn_end` 再尝试，
  不会中断当前 turn。
- `cancel_wakeup` 和 timer fire 都是幂等的；session shutdown/reload/new/fork
  清理全部 timer 与 deferred 项。
- Loop 不读取或写入 `.stepcode/cron`，也不调用 Cron runtime。

### 实现边界

主要文件：`packages/coding-agent/src/extensions/step-schedule.ts`。
扩展工厂允许注入 clock/timer 以便 fake-timer 测试；生产实现只使用标准
`setTimeout`。注册点是 Step composition root，禁用开关为
`STEP_DISABLE_SCHEDULE=1`。

事件名及最小字段：

| 事件 | 字段 |
|---|---|
| `wakeup_created` | `delay_seconds`, `clamped`, `reason_length` |
| `wakeup_fired` | `scheduled_at`, `fired_at`, `latency_ms` |
| `wakeup_deferred` | `id`, `defer_count` |
| `wakeup_cancelled` | `found`, `source` |

prompt 内容最多记录长度，不记录原文；事件写入现有 Step telemetry reporter。

### 验收

- clamp 的下限、上限和正常值均有测试；列表按计划时间稳定排序。
- fire、cancel、shutdown 三条路径都没有遗留 timer 或重复消息。
- busy turn 的 fire 在 `turn_end` 后只投递一次。
- RPC/JSON 模式收到同一个 custom event，测试不需要真实等待一分钟。

---

## 方向 B：Cron

### 心智模型

Cron 是表达式驱动的日历调度器。它支持 session-only job，也支持项目目录内的
durable job；session 重启时只恢复 durable job。Cron 的时间语义独立于 Loop 的
相对 delay 语义。

### 工具契约

```text
cron_create({ cron, prompt, recurring?, durable? })
cron_list({})
cron_delete({ id })
```

- `cron` 为五字段表达式（分钟、小时、月日、月份、周日），按本地时区解释；拒绝
  秒字段和无法解析的表达式。
- `recurring` 默认 `true`；false 的 job 触发一次后删除。
- `durable` 默认 `false`；true 的 job 存储在项目 `.stepcode/cron/tasks.json`。
- recurring job 最长存活七天，最后一次触发后发出 expiry 事件并删除。
- 每 30 秒扫描一次；允许小幅随机抖动以避免多个进程同时撞在整点，但 replay 模式
  关闭抖动。
- 运行中的 turn 不会被打断。错过的 durable one-shot 在下次 `session_start` 产生
  一条 catch-up steer 提示；错过的 recurring job 只更新 `lastFiredAt`，不补发全部
  历史触发。

### 数据格式与并发

`tasks.json` 使用版本化 JSON 行，每行包含：

```ts
interface CronJob {
  schemaVersion: 1;
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  nextFireAt: number;
  lastFiredAt?: number;
  autoExpireAt?: number;
}
```

写入采用临时文件加原子 rename，并以独占 lock 防止两个 session 互相覆盖。读取时
先备份再迁移；未知版本跳过并告警，绝不静默删除。durable 文件只在 trusted project
上下文中访问，prompt 不进入日志之外的遥测字段。

主要文件：`packages/coding-agent/src/extensions/step-cron.ts`。可将 parser
封装成窄接口；parser 依赖必须在 MR 中记录许可证、大小和 Node 支持范围。没有
parser 时扩展应报告不可用并保持其他能力正常，而不是实现一个不完整的表达式解析器。

### 事件与命令

| 事件 | 关键字段 |
|---|---|
| `cron_created` | `recurring`, `durable` |
| `cron_deleted` | `found`, `source` |
| `cron_fired` | `recurring`, `durable`, `late_ms` |
| `cron_deferred` | `id`, `defer_count` |
| `cron_missed` | `trigger_count`, `recurring` |
| `cron_expired` | `id`, `recurring` |

可选 `/cron` 命令只负责列出和删除状态，不改变工具契约；headless 环境返回文本或
结构化 command response，不弹 UI。

### 验收

- 典型表达式的 next-fire 与 parser 结果一致，包含 DST/本地时区测试。
- one-shot 自删、recurring 更新 next-fire、七日 expiry 和 idle defer 都有 fake-clock
  测试。
- durable job 在关闭再启动后恢复；miss 策略和未知 schema 行测试覆盖。
- 原子写和 lock 在并发 fixture 中不会丢 job；RPC fixture 收到 `[cron]` 消息。

---

## 方向 C：Workflow（含 HoH `iterate()`）

### 心智模型

Workflow 是一次性的编排 run，不是定时器。脚本描述阶段和 agent 关系，运行时负责
隔离、并发、预算、结构化结果、journal 和 resume。它可以立即执行，也可以由用户
另行安排 Cron/Loop；这种组合是调用方的选择，不是 Workflow 的隐式依赖。

### 顶层调用

```text
workflow({ script?, scriptPath?, name?, args?, resumeFromRunId? })
```

优先使用 inline `script` 做小实验；保存脚本按项目再用户目录查找，项目优先。脚本
大小限制 128 KiB。`STEP_ENABLE_WORKFLOW` 未设为显式 true 时不注册工具、不注入
prompt appendix；出现运行时依赖问题应安全禁用，不回退到不受限的运行时。

### JavaScript DSL

运行时向受限脚本环境提供以下能力：

```ts
const meta = {
  name: string,
  description: string,
  phases?: Array<{ title: string; detail?: string }>,
  roleSchemas?: Record<string, JsonSchema>,
};

phase(title: string): void;
log(message: string): void;
agent(prompt: string, options?: AgentOptions): Promise<unknown>;
parallel(tasks: Array<() => Promise<unknown>>): Promise<unknown[]>;
pipeline<T>(items: T[], ...stages: Array<(item: T) => Promise<T>>): Promise<T[]>;
workflow(name: string, args?: unknown): Promise<unknown>; // 仅允许一层嵌套
iterate(options: IterateOptions): Promise<IterateResult>;
const args: unknown;
const budget: { total: number | null; spent(): number; remaining(): number };
```

`agent` 选项包括 label、schema、tool profile、readOnly/writable mounts、
agentType、model、effort 和有限重试次数。所有跨边界值都经过 JSON 拷贝；宿主不把
可调用对象、文件句柄或 secret 放入脚本全局。

### HoH `iterate()` 原语

`iterate()` 将 HoH 方法论做成 Workflow 的一等 primitive，而不是要求用户维护一份
额外的特殊脚本。每一轮固定经过三个角色：

1. **Planner**：只读 artifact 和上轮 evidence，产出有界 `PLAN`。
2. **Developer**：唯一可写 artifact 的角色，执行 `PLAN` 并产出 `DEV_REPORT`。
3. **QA**：独立只读角色，运行测试/运行时检查，产出结构化 `EVIDENCE`。

核心 schema（JSON Schema/TypeBox）包含 objective、taskSpecification、
preservationConstraints、validationRequirements、filesChanged、selfTestsPassed、
dimensions、verifiedBehaviors、unresolvedGaps、specCoverage、coverageDelta 和
nextAction。未知字段被丢弃；
free-form 字段在回流 prompt 前截断并用 `JSON.stringify` 放入明确的数据分隔区。

每轮的输入因果链是 `spec + artifact snapshot + evidence[1..n-1]`。每轮完成后写入
`runs/<runId>/evidence.jsonl` 和 journal；代码变更仍由调用方按项目的 Git 流程提交。
Planner/QA 使用 read-only profile 与 mount，Developer 拥有唯一 writable mount；tool-call
ACL 和路径 canonicalization 是第二道防线。

停止条件在写入最后一轮 evidence 后判断：

- coverage 达到目标；
- 达到 `maxIterations`；
- token budget 用尽（抛出可 resume 的 `WorkflowBudgetExceeded`）；
- Planner 返回空 objective；
- 连续三轮没有正向 coverage delta（标记 stagnation 并停止或交还调用方）。

`iterate()` 不创建 Cron/Loop job；若 planner 需要等待外部事件，由调用方显式调用
相应方向的工具。

### Workflow runtime 与安全

主要目录：

```text
packages/coding-agent/src/extensions/workflow/
  step-workflow.ts   # 工具、saved lookup、feature flag
  vm.ts              # 受限运行时与 deterministic guards
  runtime.ts         # DSL bridge
  agent-runner.ts    # subagent 执行、schema retry、ACL
  journal.ts         # 原子 journal、resume 前缀缓存
  budget.ts          # token budget 与并发 semaphore
  progress.ts        # progress.json 与 headless 投影
```

运行时必须提供真正的隔离实现（优先 `isolated-vm` 或等效独立进程），并拒绝
`require`、网络、任意环境变量、动态 import、process、文件系统宿主引用和可变的
宿主对象或句柄。`Date.now`、`new Date`、`Math.random` 等非确定源在所有模式中都被禁用；
脚本 CPU/wall 超时、内存上限、单 run agent 数、单次 agent wall timeout 和并发数都有硬上限。
等待宿主 agent 时由 agent timeout 负责，脚本自身的 `Date`、`Intl.DateTimeFormat` 和
`Math.random` 等非确定源均被禁用。`isolated-vm@6.0.1`
以精确版本 optional dependency 引入；隔离依赖构建失败时 Workflow 工具不注册，
不回退到 `node:vm`。

Agent runner 复用现有 `runStepSubagentProcess`，但每个 call 都记录 `{seq, hash,
prompt, options, result}`。resume 只重放 hash 完全匹配的连续前缀，首个失配点之后
全部重新执行；显式指定不存在的 run 会直接失败，不会静默重新计费。缓存命中也会
写入新 run 的 journal，因此连续 resume 仍保留完整前缀。schema 失败最多尝试三次，
重试消耗同一个 budget；semaphore 在成功、失败、取消和 timeout 路径均释放。

### Workflow 事件与产物

事件统一使用 `workflow_` 前缀：`workflow_started`、`workflow_phase`、
`workflow_agent_started`、`workflow_agent_finished`、`workflow_schema_failed`、
`workflow_acl_blocked`、`workflow_budget_exceeded`、`workflow_resumed`、
`workflow_finished` 以及 `workflow_hoh_*`。字段只包含 run id、phase、label、status、
计数、耗时和 token 等安全维度。

项目产物布局：

```text
.stepcode/workflows/
  saved/                 # 用户维护的脚本
  runs/<runId>/
    script.js
    journal.jsonl
    progress.json
    telemetry.jsonl
    evidence.jsonl        # iterate() 使用
```

`runs/` 默认加入 gitignore；saved 脚本不自动删除。每个 run 使用唯一目录，journal、
telemetry 和 evidence 在进程内串行 append；读取时容忍被杀进程留下的半行。

### 验收

- hello-world、parallel barrier、pipeline 和一层 nested workflow 均通过；二层嵌套、
  超大脚本、超时和 OOM 明确失败且宿主继续运行。
- schema 违约得到最多三次有界尝试并在 journal 留痕；ACL 会阻止 readOnly 路径的
  write/edit/redirect 及 symlink/`..` 逃逸。
- resume 命中未变化前缀、在首个 hash 失配后重跑；预算和并发上限在失败路径仍正确。
- `iterate()` fixture 能携带最近 evidence、执行 single-writer、覆盖四类停止条件，
  headless 模式产出同样的 journal/progress/evidence。

---

## 三个 MR 的交付路线

### MR 1：Loop / ScheduleWakeup

包含 `step-schedule.ts`、注册点、prompt appendix、遥测事件和 fake-clock/RPC 测试。
不引入 Cron 文件格式或第三方 parser。回滚只需移除扩展注册；没有持久化数据迁移。

### MR 2：Cron

包含 parser 窄封装、Cron 存储/lock/migration、tick/fire/miss/expiry、三个工具、
`/cron` 状态命令、prompt appendix、遥测和测试。Loop 保持独立实现和原有行为；本 MR
不把 Loop 改写成 Cron 特化。

### MR 3：Workflow（含 HoH `iterate()`）

包含受限运行时、DSL bridge、agent runner、ACL、journal、budget、progress、顶层
工具、prompt appendix、`iterate()` schemas/runtime/tests 和文档。HoH 的角色、证据
回流、single-writer 与停止条件都在同一 MR 中，不另开 saved-template MR。

每个 MR 都从最新 `origin/main` 建分支，显式 stage 自己修改的文件，运行针对性测试和
`npm run check`，再 push 并创建 GitLab MR。MR 描述必须给出行为、风险、测试命令和
回滚方式；三个方向没有强制合并顺序，且每个方向在代码边界上可单独禁用。

## 决策矩阵

| 决策 | 选择 | 原因 |
|---|---|---|
| Loop 工具名 | `schedule_wakeup` / `list_wakeups` / `cancel_wakeup` | 与 Claude Code 语料一致，表达 session continuation |
| Loop 时钟 | 标准 timer + 注入 clock | 零运行时依赖，测试可控 |
| Cron 表达式 | 五字段、项目本地时区 | 足够覆盖 agent 场景，避免秒级复杂度 |
| Cron durable 位置 | `.stepcode/cron/tasks.json` | 项目边界清晰、可备份、可迁移 |
| Workflow DSL | JavaScript | 能表达控制流且接近 Claude Code Workflow 心智 |
| Workflow 隔离 | `isolated-vm` 或等效强隔离 | 禁止把 `node:vm` 当安全边界 |
| schema 校验 | TypeBox JSON Schema engine | VM 只传 JSON，错误可解释且不重复实现 validator |
| schema retry | 默认最多三次，可下调 | 防止无界 token 消耗 |
| resume | seq + prompt/options hash 的连续前缀 | 防止相同 prompt 的错误复用 |
| budget | input+output token | 与 provider usage 直接对应 |
| concurrency | 默认 `min(16, cpu-2)`，硬上限 32 | 防止脚本耗尽宿主与 provider |
| HoH evidence | 最近五轮窗口 + 完整 JSONL | prompt 有界且审计可追溯 |
| single writer | Developer writable，Planner/QA read-only | 保持独立 QA 与可归因变更 |
| feature flag | Workflow 默认关闭 | 隔离依赖和生产风险 |
| telemetry | 复用 Step reporter + run JSONL | 不引入新的观测基础设施 |

## 风险、遥测与 RL

### 风险控制

- **timer 泄漏**：所有 fire/cancel/shutdown 出口统一清理，测试检查 active handle。
- **调度竞态**：Cron 原子 rename + lock；Loop 只存在内存，不伪装成 durable。
- **提示注入**：prompt、文件、evidence 都当不可信数据；结构化 JSON 后再注入，字段
  长度有限制。
- **写权限绕过**：realpath canonicalization、工具 hook 和 `run_command` 的常见 redirect/
  copy 目标检查同时执行；只读 mount 下的未知工具默认拒绝。shell 解析是保守 guard，
  不是 OS 级沙箱；需要处理恶意命令时必须在进程外隔离执行。
- **资源耗尽**：脚本大小、VM memory、脚本 CPU timeout、agent timeout、agent lifetime
  和 budget 全部有硬上限。
- **数据损坏**：版本化记录、备份迁移、半行容忍；未知版本 skip+warn，不删除原文件。

### 可观测性

事件 payload 不包含 prompt 原文、路径内容、token 或凭证。离线聚合关注：

- Loop 的 fire latency、defer/cancel 比；
- Cron 的 fire/miss/expiry 比与 durable 恢复成功率；
- Workflow 的状态、schema/ACL 失败率、tokens/run、并发水位；
- HoH 的 coverage 曲线、iterations-to-target、stagnation 和每轮成本。

### RL / replay

- Loop 使用 fake clock 与显式 fire 事件，训练不等待真实 wall clock。
- Cron replay 允许固定 epoch、关闭 jitter、手动推进 tick；普通模式明确标记非确定。
- Workflow journal 是 call 序与结果的 replay 权威；固定 run id 可在不调用 provider 的
  情况下重建前缀。
- `iterate()` 的每轮输入只来自 spec、artifact snapshot 和先前 evidence，因此可从任一
  轮分叉采样；reward 可使用 coverage delta、停止原因、token 成本和回归证据。

## 代码位置速查

| 用途 | 位置 |
|---|---|
| Extension API | `packages/coding-agent/src/core/extensions/types.ts` |
| Step composition root | `apps/cli/src/main.ts` |
| Custom message/steer | `packages/coding-agent/src/core/agent-session.ts` |
| Subagent runner | `packages/coding-agent/src/extensions/step-subagent.ts`、`extensions/subagent/` |
| Prompt appendix | `packages/coding-agent/src/step/system-prompt.ts` |
| Telemetry registry | `packages/coding-agent/src/step/telemetry-events.ts` |
| Loop extension | `packages/coding-agent/src/extensions/step-schedule.ts` |
| Cron extension | `packages/coding-agent/src/extensions/step-cron.ts` |
| Workflow extension | `packages/coding-agent/src/extensions/workflow/` |

## 参考

- Claude Code：`ScheduleWakeup`、`CronCreate`/`CronDelete`/`CronList`、Workflow DSL。
- Yan et al., *Harness-of-Harness: Multi-Day Autonomous Software Development with
  Continual Improvement*, arXiv:2609.01481 (2026-09-01)。本文借鉴其 planner →
  developer → independent QA、evidence carry-over、single-writer、版本化 artifact
  和可验证停止条件。
