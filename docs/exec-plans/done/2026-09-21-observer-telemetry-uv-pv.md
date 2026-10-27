# observer 埋点接线与 UV/PV/下载量口径

分支：`feat/observer-telemetry-uv-pv`（worktree `/Users/jyxc-dz-0100626/step-harness-observer-telemetry`，从 `origin/main` 开）
目标：让 CLI 的每日 UV / PV / 下载量真正落到 stepcliobserserver。
参考：`/Users/jyxc-dz-0100626/Downloads/harness-observer-integration.md`（下称"设计文档"）、`/Users/jyxc-dz-0100626/step-cli`（参考实现）。

## 背景：当前 main 上埋点是死的

事件注册表（50 个）、生产者（`cli_started` / `cli_exited` / `session_started` / `first_launch` / `crash`）、
HTTP 上报运行时（`telemetry-runtime.ts`，批量/退避/spool/脱敏俱全）都在。但有两处独立的断点，
任意一处都足以让上报为零：

1. **seam 没接线。** `apps/cli/src/observability.ts` 仍是 opensource overlay 带过来的三行
   `NOOP_OBSERVABILITY_PROVIDER`。`main.ts:115` 由它构造 reporter，于是进程里根本没有 runtime，
   `enabled === false`。连 `first_launch`（`main.ts:661` 用 `enabled` 做门）都不会发。

2. **channel 环境变量名漂移。** `telemetry-runtime.ts:146,666` 读 `STEP_CLI_BUILD_CHANNEL`，
   而构建链路（`scripts/build-binaries.sh:120` 的 `export STEPCODE_BUILD_CHANNEL`、
   Bun `--env=STEPCODE_BUILD_*`、`build-coding-agent-bundle.mjs:124` 的 esbuild allowlist）
   只设 `STEPCODE_BUILD_CHANNEL`。这个名字**没有任何构建会设置**，于是 release 二进制里
   `readBuildChannel()` 恒为 `"dev"` → `readTelemetryEndpoint()` 返回 `undefined` → 只落本地 spool；
   同时信封 `context.channel` 被盖成 `"dev"`，看板按 channel 预筛会是空的。

   `telemetry-runtime.ts` 是整个 `packages/*/src` 里**唯一**还在用 `STEP_CLI_*` 名字的文件，
   其余已全部迁到 `STEPCODE_*`。这是品牌改名时漏掉的一处，即设计文档 G4 在本仓的真实形态
   （比文档描述的"别名不认"更严重：是两套完全不同的名字）。

3. **CI 变量名与构建脚本不同步。**（实施中发现的第三处断点）
   `.github/workflows/build-step-binaries.yml:85-87` 与 `.gitlab-ci.yml:16` 仍传
   `STEP_CLI_BUILD_VERSION/CHANNEL/COMMIT`，而 `scripts/build-binaries.sh:45-47` 只读
   `STEPCODE_BUILD_*`。即使修好断点 2，CI 出的发布产物仍是 `channel=dev`、version 落
   `0.3.1` fallback。三处必须同时修，否则线上依旧零上报。

## UV / PV / 下载量口径

| 指标 | 数据来源 | 现状 |
|---|---|---|
| PV（每日调用次数） | `cli_started` 事件，每次进程启动发一条 | 生产者已存在（`main.ts:146`），缺上报 |
| UV（每日去重用户） | 信封 `context.deviceId`，`<storage-root>/device-id` 里的持久 UUID | 生产者已存在（`main.ts:664` setContext），缺上报 |
| 下载量 | `first_launch` 事件，仅在 device-id 文件**首次创建**时发一条 | 生产者已存在（`main.ts:666`），缺上报 |

下载量用 `first_launch` 近似，口径是"新安装首次运行"，覆盖不到"下载了没跑起来"的那部分——
客户端事件天然看不见那一段。本次按此口径落地，不新增升级事件。

## 步骤

### 1. 新增 `packages/coding-agent/src/step/observer-endpoints.ts`

- **Step**：建 observer URL 的单一事实源（设计文档 §3.3 P0 / D8）。
  两个源常量 `OBSERVER_ORIGIN_DEV` / `OBSERVER_ORIGIN_RELEASE`（release 带 `/stepcliobserserver` 路径段，
  **严禁 `URL().origin` 归一化**），登记 `telemetry` / `feedback` / `feedbackBundle` 三条路由，
  导出 `readEndpointEnvOverride` / `readEndpointChannelDefault` / `resolveEndpoint`。
  采用策略留在各自 resolver，不进登记表。
- **Tool**：Write。
- **Expectation**：`npm run check` 通过；新单测断言各 channel default 等于精确 URL 串、env 覆盖优先。
- **Rollback**：删文件。

不纳入 `cloudTraceOrigin`：main 上 `trace-headers.ts` 已无内建 origin（seam 提交移除），只剩 env 前缀。
恢复内建 origin 会让高敏感 header 重新对 `api.stepfun.com` 放开，属于独立的隐私决策，不在本次范围。

### 2. 改 `telemetry-runtime.ts`：channel 统一 + endpoint 查登记表

- **Step**：
  - 删 `RELEASE_TELEMETRY_ENDPOINT`(:142)、`INLINED_BUILD_CHANNEL`(:146)、`INLINED_BUILD_COMMIT`(:147)、
    `DEFAULT_CHANNEL`(:133)、本地 `readBuildChannel`(:665) 与 `readBuildCommit`(:680)。
  - channel/commit 改用 `readStepBuildIdentity(env)`（`build-identity.ts`，已认 `STEPCODE_BUILD_*`
    并保留 `STEP_HARNESS_BUILD_*` 别名）。这一步同时修好断点 2 与设计文档 G4。
  - `readTelemetryEndpoint` 重写为查登记表，**逐字保持既有优先级**：
    env 覆盖 → `channel==="release"` 时 `config.endpoint ?? release default` → 否则 `undefined`。
    dev 仍然只 spool（设计文档 D5：不翻转该安全边界）。
  - 其余 `STEP_CLI_*` / `STEPCLI_*` env 名补 `STEPCODE_*` 别名并前置（endpoint / disable / dir / uid /
    device-id / user），旧名保留为 legacy。偏离设计文档 M2：文档说"不新增别名"，但那是针对
    `STEP_HARNESS_`；本仓实际约定是 `STEPCODE_`，不补则文档化的 dev 逃生口在本仓叫不出来。
- **Tool**：Edit。
- **Expectation**：`step-telemetry-runtime.test.ts` 全绿（需同步更新其中的 `STEP_CLI_BUILD_CHANNEL` 断言）。
- **Rollback**：`git checkout` 该文件。

### 3. 改 `feedback/endpoints.ts` 查登记表

- **Step**：删四条字面量，`resolveFeedbackEndpoint` 改调 `resolveEndpoint`；
  `isBuiltInFeedbackEndpoint` / `equivalentEndpoint` 的等价匹配逻辑保留不动（设计文档 §9：不合并两个匹配器）。
- **Expectation**：feedback 既有测试全绿，两 channel 采用行为不变。
- **Rollback**：`git checkout` 该文件。

### 4. 接线 `apps/cli/src/observability.ts`

- **Step**：用 `createStepTelemetryRuntime` / `createStepSystemMetricsCollector` /
  `installStepTelemetryCrashHandlers` / `createStepModelRequestObserver` / `resolveStepTraceHeaderBaseUrls`
  组装出真实的 `StepObservabilityProvider`。`main.ts` 装配根不动。
  这是 `13bee6e` 提交说明指定的 `[Main-only]` 落点。
- **Expectation**：源码跑 `./step-test.sh`，`<storage-root>/telemetry/events-<date>.jsonl` 里
  出现 `cli_started`；`STEPCODE_TELEMETRY_ENDPOINT=<test observer>` 时走 HTTP。
- **Rollback**：恢复三行 noop。

### 5. 回归测试

- 新 `observer-endpoints.test.ts`：resolve 优先级、各 channel default 精确串、env 别名顺序。
- 扩 `step-telemetry-runtime.test.ts`：
  - G4 双向：`{STEPCODE_BUILD_CHANNEL=release, 无 endpoint env}` → 武装 release 上报且信封 channel 一致；
    `{未设, 无 endpoint env}` → 仍 `undefined`（dev 只 spool，证明不误武装）。
  - release 降级：`{运行时 STEPCODE_BUILD_CHANNEL=dev}` → `undefined`（fail-safe）。
  - test-runtime 门未被击穿：`NODE_ENV=test` / `VITEST` 时先于 endpoint 解析返回 disabled。
  - 信封不变量：`{events:[...]}`、camelCase `eventId`/`deviceId`/`sessionId`、UUID 形状。
- UV/PV/下载量三事件的端到端：经真实 runtime + stub sink 断言 `cli_started` 带 deviceId、
  `first_launch` 仅在 created 时发一次。
- **Tool**：`./test.sh` 或 `pnpm exec vitest --run <file>`（包根）。

### 6. `npm run check`

全量输出，修完所有 error/warning/info。

## 执行结果（2026-09-21）

步骤 1-6 全部完成，另加实施中发现的步骤 7（CI 变量对齐）。

### 7. 对齐 CI 构建变量

`.github/workflows/build-step-binaries.yml:85-87` 与 `.gitlab-ci.yml:16` 的
`STEP_CLI_BUILD_*` 改为 `STEPCODE_BUILD_*`。改后仓库内已无任何 `STEP_CLI_BUILD_*` 残留。

### 验证

- `npm run check`：exit 0，biome 检查 1090 个文件无修正，tsgo 与全部守卫脚本通过。
- `packages/coding-agent` 全量 vitest：3497 passed / 1 failed。该 1 个失败
  （`2791-fswatch-error-crash`）与 `test/server/create-harness.test.ts` 的收集失败，
  已在 `origin/main` 的干净 worktree 上复现为完全相同的失败，属预先存在，与本次无关。
- 新增/改动的测试：`observer-endpoints.test.ts` + `step-telemetry-runtime.test.ts` +
  `feedback.test.ts` + `step-device-id.test.ts` 共 99 passed。
- **源码冒烟（spool 路径）**：隔离 HOME 跑 `./step-test.sh --no-env --version`，
  `<HOME>/.stepcode/telemetry/events-2026-09-21.jsonl` 依次落 `cli_started`、`first_launch`、
  `system_metrics`、`cli_exited`，四条信封均带同一 `deviceId`；`channel=dev` 时不发 HTTP，
  dev 安全边界成立。
- **源码冒烟（HTTP 路径）**：`STEPCODE_TELEMETRY_ENDPOINT` 指向本地 stub collector，
  收到单次 `POST /api/v1/events`，body 为 `{"events":[...]}`，字段为 camelCase
  `eventId`/`deviceId`，`eventId` 为 UUID —— 与 observer 契约逐字段一致。
- **真实 observer URL 探活**：对 registry 里四条 URL 各发一次 `POST {"events":[]}`：

  | URL | 状态码 |
  |---|---|
  | `https://api.stepfun.com/stepcliobserserver/api/v1/events` | 400 |
  | `https://api.stepfun.com/stepcliobserserver/api/v1/feedback` | 400 |
  | `https://test-openapi-stepcliobserserver.c.stepfun-inc.net/api/v1/events` | 400 |
  | `https://test-openapi-stepcliobserserver.c.stepfun-inc.net/api/v1/feedback` | 400 |
  | 对照：同 origin 下故意写错的路径 | 404 |

  400 正是契约 §11.1 里"events 空数组"的拒绝码，而错误路径给 404 —— 说明 400 不是兜底响应，
  四条路由都真实存在且命中 ingest handler。这覆盖了 M1 担心的"URL 打错一个字"风险，
  **包括带路径段的 release origin 没有被 `URL().origin` 归一化掉**。

- **下载量口径的端到端不变量**（tmux 跑真实 TUI + 本地 stub collector）：
  - 第 1 次运行（真实 HOME 此前无 `~/.stepcode/device-id`）：收到
    `cli_started` / `first_launch` / `system_metrics` ×2 / `cli_exited`，
    device-id 文件被创建为 `318eaee9-…`。
  - 第 2 次运行：收到 `cli_started` / `system_metrics` / `cli_exited`，
    **`first_launch` 不再出现**，且 `deviceId` 与第 1 次完全相同。

  即：PV 每次运行 +1，UV 的去重键跨运行稳定，下载量（新安装）每台机器恰好 1 条。

### 未做（需另行决策）

- **会话级事件未验证**：本机没有可用凭据（TUI 停在登录选择页），
  `session_started` / `turn_completed` / `tool_call_completed` 没有实跑覆盖。
  这三个不影响 UV/PV/下载量,但影响看板的漏斗与 token 面板。
- 设计文档 P1 的卫生守卫 `check-endpoint-hygiene.mjs` 与薄契约文档未做。

## M1 验收门：已关闭（2026-09-21 21:22，用户授权打生产）

设计文档假设"observer 写-only、不可读回，所以落库无法自证"。该前提**不成立**：
`https://stepcliobserserver-dashboard.stepfun-inc.com/api/v1/events/dashboard` 是服务端渲染的
只读看板（表 `step_cli_events`），可按 `?range=&channel=` 过滤，另带只读 SQL 探索面板。
未找到 test 环境的对应看板（两个候选 404、一个 DNS 不通），故经用户确认后打生产 collector。

**做法**：`STEPCODE_TELEMETRY_ENDPOINT=https://api.stepfun.com/stepcliobserserver/api/v1/events`
跑 `./step-test.sh --no-env --version`。channel 保持 `dev`，而库中既有数据全是 `release`，
所以本次写入在看板上可被 channel 筛选完全隔离出来。

**发出**（eventId 取自 spool 的同批副本）：

| eventId | event |
|---|---|
| `7635ef36-4310-4054-bfa9-1e8e136ee2ab` | cli_started |
| `e5cf8efc-b166-4e7c-8757-2863100300f8` | system_metrics |
| `8453c372-dd2d-459f-a633-dcb9c570f9fd` | cli_exited |

未生成 `failed-*.jsonl`（运行时仅在 HTTP 永久失败时写该文件）→ POST 得到 2xx。

**服务端读回**（`?range=1h&channel=dev`）：

| 看板指标 | 值 | 对照 |
|---|---|---|
| 事件总数 | 3 | = 发出的 3 条 |
| 活跃设备 | 1 | = 本机唯一 deviceId `318eaee9-…`（**UV 计数器本身**） |
| 事件分布 | cli_started 1 / system_metrics 1 / cli_exited 1 | 逐条对上 |
| 登录账号 / 使用者 / 会话数 | 0 / 0 / 0 | 未登录、未开会话，一致 |

过滤前该时间窗的 channel 取值只有 `release`，本次运行后出现 `dev`——筛选器取值由库中
distinct 得出，这本身即落库证据。

结论：endpoint URL 正确、信封被接受、记录真实入库，且看板的"活跃设备"就是
`context.deviceId` 的按天去重计数——UV 口径经真实服务端确认。

### 补验 `first_launch`（21:36）

首轮生产验证里没有 `first_launch`：该事件在 21:07 的 tmux 冒烟中已随 device-id 文件的创建
发出过一次，而那次 endpoint 是本地 stub，所以生产库看不到。这本身即"一次性"不变量成立的证据。

为把下载量口径也验到服务端，删除 `~/.stepcode/device-id` 后重跑一次生产上报。
新 deviceId `bbef5db9-…`，库中查得 4 条，`first_launch` 在列：

| event_id | event_name | client_ts |
|---|---|---|
| `e3b2d452-b39e-40c8-a29b-90231b7cf5a0` | cli_started | 21:36:25.526 |
| `a0f5f3c8-bf46-4517-a35c-c690b3869a41` | **first_launch** | 21:36:25.536 |
| `6836567e-6bf5-43be-bb67-75e9a855f1c8` | system_metrics | 21:36:25.540 |
| `9ec3ff73-93a3-4421-9b50-07db6b192906` | cli_exited | 21:36:25.540 |

按 `channel='dev'` 汇总两个 deviceId：

| device_id | 事件数 | first_launch |
|---|---|---|
| `318eaee9-…`（已有 device-id 的那次） | 3 | 0 |
| `bbef5db9-…`（新建 device-id 的那次） | 4 | 1 |
| **合计** | **7（PV 依据）** | **1** |

三个指标全部在真实服务端闭环：PV = `cli_started` 计数、UV = `device_id` 去重（2）、
下载量 = `first_launch` 计数（1，且只在创建 device-id 的那一次出现）。

**代价**：dev 通道共 7 条事件永久留在生产分析表（`INSERT IGNORE on eventId`，无删除入口）。
按 channel 过滤即可与 release 数据完全隔离，不影响任何 release 口径的读数。

### 看板 SQL 探索的已知缺陷（非本次引入）

`POST /api/v1/explore/query` 的服务端 SQL 清洗器会在函数名与左括号之间插入空格，
MySQL 因而把 `COUNT (` 解析为自定义函数：

- `SELECT COUNT(*) …` → `Error 1064 … near '* ) AS n FROM step_cli_events'`
- `SELECT COUNT(1) …` → `Error 1630: FUNCTION stepcli.COUNT does not exist`

`SUM` 同样中招，`COUNT(DISTINCT …)` 不可用，派生表被显式禁止
（"derived tables are not allowed"）。结果是该面板**只能做行级查询，不能做聚合**，
无法自助写"按天 UV/PV/下载量"。页面自带面板不受影响（Go 侧直接计算）。
属看板侧缺陷，需另行报给其维护方。

## 边界（本次不做）

- 不建 span→observer 桥（设计文档 D6）。
- 不翻转 dev 默认上报（D5），dev 仍只 spool。
- 不恢复 `trace-headers.ts` 的内建 cloud-trace origin。
- 不新增/删除/重排事件，不动传输/缓冲/重试/spool/脱敏，不加 auth。
- 不补 `tool_call_repeat`（设计文档 §11.4 既有缺口，独立工作项）。
- 不碰 `github-opensource` 分支：那里有 `scripts/check-no-observability.mjs` 硬守卫，
  本次实现按仓库既有 `[Main-only]` 约定只落 `main`。
- 真实"下载量"（含下载未运行）需分发侧在下载入口计数，不在本仓范围。

## 需要确认的副作用

步骤 2 的 channel 统一是**可观测行为变更**：修好后 release 二进制会**开始**真正上报
（此前恒为 dev、只落 spool）。这正是本次要达成的目标，但意味着上线后 observer 会首次收到 release 流量。
