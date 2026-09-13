# step-harness 拆包等价性修复报告

- **对比基线**：`1cfed08`（重构分叉前）→ **重构末端** `95a674b`（`refactor/step-restructure` tip）
- **修复分支**：`fix/restructure-equivalence`（基于 `95a674b`）
- **日期**：2026-09-13
- **方法**：`/workflows` 多 agent 审查（7 维等价性审查 → 对抗式校验）→ 缺陷修复设计（3 缺陷 × 设计+对抗校验）→ 应用 → 本地验证

## 概述

对 `1cfed08 → 95a674b` 的等价性审查结论：**重构对基线是保真的**。搬迁类改动（202 个逐字节移动 + ~205 个仅改 import）与 `ai→providers` 的 StepFun-only 裁剪都符合“只是包重构”的预期；保留代码逐字节等价，有意移除（CBOR / SQLite / pi）删得干净、无悬空引用。

去重后共确认 **3 个真缺陷**（本报告全部修复），另在验证中发现并修复 **1 个预存的类型门失败**。

## 修复明细

### 1. PROV-1 —（behavior-drift，藏在保留函数里）远端模型目录“陈旧抑制”门失效
- **文件**：`packages/providers/src/providers/all.ts`
- **根因**：重构把 `getBuiltinModelDataGeneratedAt()` 改成恒 `return undefined`，注释称 manifest “离线不可用”——但 `data/.manifest.json` 在 `95a674b` 是被 git 跟踪的（含真实 `generatedAt`）。这使 `remote-catalog-provider.ts` 中“本地目录比远端缓存新则丢弃陈旧远端覆盖”的门（`localGeneratedAt !== undefined && …`）永不触发，陈旧的远端 catalog（错误的 cost / contextWindow / capabilities）会盖在更新的内建目录上。影响面：anthropic / openai 内建（StepFun 的 step-provider 不走 `withRemoteCatalog`）。
- **改动**：
  - 恢复基线的 manifest 静态导入（与 `anthropic.models.ts` / `openai.models.ts` 同款 `with { type: "json" }`）：
    ```ts
    import modelDataManifest from "./data/.manifest.json" with { type: "json" };
    ```
  - 恢复读时间戳、仅在缺失/不可解析时返回 undefined：
    ```ts
    export function getBuiltinModelDataGeneratedAt(): number | undefined {
      const generatedAt = Date.parse(modelDataManifest.generatedAt);
      return Number.isNaN(generatedAt) ? undefined : generatedAt;
    }
    ```
- **验证**：新增 `packages/providers/test/builtin-model-data-generated-at.test.ts`（断言返回等于 `Date.parse(manifest.generatedAt)` 的有限数）→ ✅ 通过；`remote-catalog-provider.test.ts` 7/7 仍通过；`tsgo` 0 错。

### 2. rpc.test.ts —（removal-incomplete）指向已删构建产物 + 用错命名空间 env
- **文件**：`packages/coding-agent/test/rpc.test.ts`
- **根因**：pi→step 迁移遗漏了此测试：`cliPath` 仍指 `dist/cli.js`（构建已不产出，唯一 bin 是 `dist/bundle/step.js`）；env 用 `PI_CODING_AGENT_DIR`（step 入口读 `STEP_CODING_AGENT_DIR`，且 `applyStepEnvironment` 会从 HOME 覆盖 `PI_*`，破坏临时目录隔离）。整段 `describe.skipIf` 只按 ANTHROPIC 凭证跳过，故在有凭证的机器上会 **spawn 不存在的路径而报错**。
- **改动**（保留其作为“真实 bundle 端到端 RPC”的唯一覆盖）：
  - `cliPath` → `dist/bundle/step.js`（新增 `stepBundlePath` 常量）
  - `env` → `STEP_CODING_AGENT_DIR`
  - `skipIf` 追加 `!existsSync(stepBundlePath)`：未 build bundle 时**干净跳过而非报错**
- **验证**：`vitest run test/rpc.test.ts` → ✅ 18 skipped（干净跳过，不再报错）；`tsgo` 0 错。anthropic 仍可经 step bundle 在 rpc 模式解析（`allowedAuthProviders` 只门控交互式登录/`auth` 命令，不门控编程式 `--provider/--model`）。

### 3. F2 —（behavior-drift）package 命令丢失“坏扩展挂死进程”硬退出保护
- **文件**：`apps/cli/src/main.ts`、`packages/coding-agent/src/main.ts`
- **根因**：基线在 `handlePackageCommand` 后 `process.exit(exitCode)`，保证一次性命令即使被已加载扩展泄漏的 libuv handle 拖住也能终止。重构改为软返回 `{ kind:"completed" }` 后走 telemetry finally + 自然 drain（F1 的正当目的：让短命令也跑 telemetry），但丢了终止保证——`step install/list` 遇到注册了 unref-less timer / 常连接的扩展会**挂死**。
- **改动**（同时保留 F1 的 telemetry finally **和** 终止保证）：
  - `apps/cli/src/main.ts`：新增 `let forceOneShotExit = false`；在 `prep.kind==="completed"` 且未 `drainNaturally` 时置真；在 **telemetry finally 之后**的模块顶层 `if (forceOneShotExit) process.exit(...)`（先刷 telemetry，再强制退出）。
  - `packages/coding-agent/src/main.ts`：`MainPreparation.completed` 增加可选 `drainNaturally?: boolean`；对两条必须自然 drain 的路径置 `drainNaturally:true`——**sdk-stdio 帧宿主**（末尾定长帧需 drain）与 **win32 成功 `update`**（Node #56645 teardown assert）；更新失效注释。
  - 未受影响：`kind:"dispatch"`（interactive/rpc/print，天然不进 force-exit）；向后兼容 `main()`（读 `exitCode`，忽略新字段）。
- **验证**：`tsgo` 0 错；`package-command-paths.test.ts` 31/31 通过；对抗式校验确认补丁干净落地、语义完整、不破坏长命令生命周期。
- **⚠️ 回归测试说明**：尝试过一个 spawn 版回归测试（在项目内放一个泄漏 timer 的扩展，跑 `step list` 断言 8s 内退出）。经“禁用 force-exit 后重跑”验证，该测试**未能复现挂死**（`step list` 约 1.9s 自然退出，说明此路径未加载该 project-local 扩展）——一个无论修没修都通过的测试是**假信心**，故**未提交**。F2 修复本身经类型检查 + 逻辑对抗校验确认成立；建议团队后续按 package 命令实际的扩展加载入口补一个真能复现的回归测试。

### 4.（验证中发现）预存类型门失败：`@step-harness/realtime` 未在根 tsconfig 注册
- **文件**：`tsconfig.json`
- **根因**：S6 语音桩引入 `packages/realtime` 且 `voice-agent` 引用它，但根 `tsconfig.json` 的 `paths` **漏了** `@step-harness/realtime` 别名（其余每个 workspace 包都有）。导致 `pnpm run check` 里的 `tsgo --noEmit` 在 `95a674b` **已经红**（2 处 TS2307）。经“stash 本次改动后重跑”确认为**预存问题，非本次修复引入**。
- **改动**：补 `"@step-harness/realtime": ["./packages/realtime/src/index.ts"]`（与其他包同款）。
- **验证**：`tsgo -p tsconfig.json --noEmit` → **0 错**（此前为 2）。

## 验证汇总（本机 node v24 / pnpm 9.15）

| 检查 | 结果 |
|---|---|
| `tsgo -p tsconfig.json --noEmit`（`check` 门用的同一条） | ✅ 0 错（修前含 2 处预存 realtime 错） |
| `providers` 新增单测 `builtin-model-data-generated-at` | ✅ 1/1 |
| `coding-agent` `remote-catalog-provider.test.ts` | ✅ 7/7 |
| `coding-agent` `rpc.test.ts` | ✅ 18 skipped（干净跳过） |
| `apps/cli` `package-command-paths.test.ts` | ✅ 31/31 |
| `biome check` 改动文件 | ✅ 干净 |

> 说明：本环境未跑全量 `pnpm -r test` / `build:binaries`（耗时/凭证）。改动最小且类型干净，验证聚焦在受影响路径。

## 改动集（`fix/restructure-equivalence`，共 5 改 + 1 新增）

```
 apps/cli/src/main.ts                    | +20        (F2 shell force-exit)
 packages/coding-agent/src/main.ts       | +23 -8ish  (F2 type/win32/sdk-stdio/doc)
 packages/coding-agent/test/rpc.test.ts  | +8  -3     (rpc 修复)
 packages/providers/src/providers/all.ts | +5  -2     (PROV-1)
 tsconfig.json                           | +1         (realtime 别名)
 packages/providers/test/builtin-model-data-generated-at.test.ts  (新增, PROV-1 回归)
```

**提交状态**：改动已应用并验证，**未 commit / 未 push**（等确认）。

---

## 附录 A：待重放清单（`main` 上 09-10 的 6~7 个修复，日后自行合入）

重构 `95a674b` 分叉自 `1cfed08`，**不含**其后落到 `main`（2026-09-10）的以下修复。经“唯一新文件缺失 + 三方内容比对”确认确实缺失。合并时注意文件已被重构搬位——下表给出新结构落点；除标注外多为原地或纯移动。

| main commit | 功能 | 类型 | `95a674b` 落点 |
|---|---|---|---|
| `e6a71e1` | TUI 皮肤重设计 | TUI | `interactive/components/{footer,status-indicator,step-logo}`→`apps/cli/src/ui/view/chrome/`；`{step-message,step-spinner,tool-execution}`→`…/view/transcript/`；`settings-selector`→`…/view/dialogs/`；`step-editor`→`…/view/editor/`；`interactive/theme/{theme.ts,theme-schema.json,*.json}`→`packages/coding-agent/src/theme/`；`core/{keybindings,settings-manager,export-html/index,tools/render-utils}` **原地**；新增 `status-tips.ts`/`step-error-hints.ts` 放对应 `view/` 子目录；UI 快照测试→`apps/cli/test/`。**⚠️ `interactive-mode.ts`（R083）已被拆到 `apps/cli/src/ui/interactive-mode.ts` + `ui/runtime/*`，其 +131 行需手工分派，不能整块 apply** |
| `72439fb` | search/find 在 rg/fd 缺失时回退 git+POSIX | **Agent** | `core/tools/{find.ts,grep.ts}`、`utils/tools-manager.ts` **原地**；新增 `find-fallback.test.ts`/`grep-fallback.test.ts`→`packages/coding-agent/test/` |
| `ba8cf9f` | 修 CR 折叠吞行 + `mdTableHeader` 破坏自定义主题 | TUI | `core/tools/render-utils.ts` **原地**；`theme.ts`→`packages/coding-agent/src/theme/theme.ts` |
| `bbd8327` | 欢迎页小鸟恢复 Braille | TUI | `step-logo.ts`→`apps/cli/src/ui/view/chrome/step-logo.ts` |
| `1f0d78a` | 默认权限预设 → `bypass` | **Agent 行为** | `step/permissions.ts` **原地**（末尾 `return "ask"`→`"bypass"`）；`step-permissions.test.ts`→`packages/coding-agent/test/` |
| `7a120e1` + `a9fd8b7` | 安装器 PATH 持久化（含 Windows） | 发布 | `infra/release/{install.sh,install.ps1}` **原地且与基线逐字节相同**（重构未碰，可直接 apply）；`scripts/release-bundle.test.mjs` 原地 |

冲突面小结：**只有 `e6a71e1` 的 `interactive-mode.ts` 需手工分派**；其余多为原地（改 import 后基本自动合）、纯移动或无冲突。

## 附录 B：未修的低优先级项（当前零运行时影响，建议后续处理）

| 项 | 说明 |
|---|---|
| `packages/contracts` 重复帧 codec 缺 8MiB 上限守卫 | 仅被未接线的 voice-agent `import type` 引用，inert；属 S6 scaffold（非死代码），接线前需与 `step/stdio.ts` 统一 |
| contracts `"1"`(string) vs coding-agent `1`(number) 协议版本常量类型不一 | 同上 scaffold，inert；接线前统一 |
| `apps/cli` bin 丢 `chmod +x` | `dist/main.js` 带 shebang 且声明为 `bin.step`，但 `private` 未 link；出货 bundle 有 chmod，当前 latent（属"补 chmod"而非删死码，未动） |
| `generate-models-strict.test.ts` 删除 → `--strict` 守卫丢覆盖 | strip 文档已记“S7 重建 slim 版”，尚未补 |
| `types.ts` KnownProvider / env-api-keys / model-resolver 的删除商死字面量 | S7 死码清扫；涉及联合类型收窄，有类型风险，随 S7 谨慎处理（本轮未动） |

## 验证记录（第二轮：实测命令回归 + 再分析，2026-09-13）

在 `refactor/step-restructure`（含本次 4 修复，`f0755e7`）上，依赖重装后实跑。

**打包端到端（实测绿）**：`pnpm run build` exit 0（7 包编译）、esbuild bundle 15 文件 / 5.9 MiB、`node dist/bundle/step.js --version`=0.3.1、`--help` 正常。（首次失败仅因切分支后 node_modules 陈旧，重装即消，非缺陷。）

**命令回归 23/23 全过，0 回归**（经 `/workflows` 跑 shell 脚本）：
- `smoke-direct.sh` 5/5（version / help / auth-check + 打模型 print-text / print-json）
- `tui-matrix.sh` 12/12（startup / input / slash / @ / ctrl-p / bang-shell / resize×2 / config / feedback / resize-cycle / session-picker + 打模型 one-round）
- `smoke-apps-cli.mjs` 4/4（真实入口 + esbuild/bun bundle 解析证明）
- 已构建 bundle `--version` / `--help` 2/2
- 打模型用例本机凭证+网络可用，均真跑通（非 gated）。

**再分析（逐字节 + 功能，均对抗式校验 CONFIRMED）**：
- byte-ledger：1184 条 → R100 逐字节移动 202、R<100 仅改 import 205、M 288、D 334、A 155；**0 behavior-drift**；所有超出 import 的改动均为有意（strip / 本次 4 修复 / S3-S4 入口与 TUI 依赖倒置）。
- TUI：全部搬迁 import-only；`packages/tui` markdown/autocomplete/editor 逐字节未变；interactive-mode 拆 `runtime/*` 忠实（中断机、按键表、斜杠路由顺序、~24 分支事件 switch 全保留）。**0 功能回归**。
- coding-agent：工具/权限/会话/prompt 全不变（prompt 逐字节），dispatch 仍按 `model.api`（零 provider-name 分支）。**0 功能回归**。
- packaging：拓扑序正确、发布重锚 `apps/cli`/step bundle；实测 build 绿。

**净结论（第二轮）**：重构对基线**功能保真**（命令 23/23、TUI 与 coding-agent 零功能回归、打包绿）；本次 4 修复已并入 `refactor/step-restructure`。

## 验证记录（第三轮：盲区覆盖 + 死配置清理，2026-09-13）

**盲区覆盖（实跑对应测试套件 + shipped bundle e2e）**：前一轮列为"未覆盖"的面已实测：
- 靶向套件 **17 文件 / 156 用例通过，0 失败**（10 skip 为凭证/模型门控）：rpc（`rpc-client-clear-queue`/`clone`/`process-exit`、`rpc-jsonl`、`rpc-prompt-response-semantics`）、sdk-stdio（`step-stdio`、`step-stdio-host`）、subagent/Task（`step-subagent-events`、`step-tasks-extension`）、session/resume/fork（`sdk-session-manager`、`session-id-readonly`、`step-session-wrapper`、`step-session-file-compat`、`agent-session-branching`、`format-resume-command`）、权限/审批（`step-permissions`）、plugin/MCP（`step-plugins`）、多轮/compaction（`agent-session-compaction`、`compaction`、`agent-session-concurrent`）。
- **shipped bundle 端到端**：`node dist/bundle/step.js --mode rpc` 实跑 `new_session`+`get_state`+`bash "echo …"` → 状态响应 ✓、bash 工具输出 ✓。
- 仍未做真·外部集成两点（honest）：真实 MCP 服务器连接（仅测 `mcp.status`/plugin 装载面）、模型自发 Task 子代理 spawn（测了 agent 面 + 事件流）。需要可再补真服务器/诱导用例。

**死配置清理（已 `pnpm run check` 全绿）**：
- 删 `apps/cli/tsconfig.build.json` 指向未构建 contracts 的死别名
- 删 `.husky/pre-commit` 冗余+陈旧的 `RUN_BROWSER_SMOKE` 块（browser-smoke 已由 `pnpm run check` 无条件跑）
- 删 pi 时代 dev 包装器 `scripts/auto-pi.sh`（pi 已移除、指向不存在的 `dist/cli.js`、无引用）
- 删 `interactive-mode.ts` 不可达的 `amazon-bedrock` 登录帮助死分支 + 其唯一 import `getDocsPath`

**净结论（第三轮）**：命名盲区面全部实跑通过（156 + rpc bundle e2e）；死配置已清；`pnpm run check` 全绿。
