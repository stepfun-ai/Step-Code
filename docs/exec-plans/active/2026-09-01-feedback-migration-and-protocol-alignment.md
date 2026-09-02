---
title: Feedback 迁移、隐私与采集协议对齐
status: active
---

# Feedback 迁移、隐私与采集协议对齐

## 问题与范围

`step feedback`、TUI `/feedback` 和 session archive 已从旧 Step CLI 迁入
Step Harness。反馈正文和会话包是两个独立请求：正文已接收时，会话包仍可能失败，
不能把两者折叠成一个成功状态。Harness 使用 Pi 的单文件 JSONL session，也不能原样
复用旧 Step CLI 的 session 目录归档。

本计划合并并取代同日的迁移复核、输出对齐和 bundle 协议三份计划。范围包括 feedback
入口、独立配置、旧配置迁移、context、脱敏、diagnostics、session 选择与归档、stderr
dev log、投递与 pending 重试、CLI/TUI 同意展示、telemetry 和匹配文档。不修改 Pi 的
agent loop、session authority 或普通 telemetry 投递骨架。

对照契约为 `../step-cli/docs/contributor/feedback-ingest-contract.md`。跨进程字段或行为有
变化时，必须同步更新 Harness 的运行时文档，不能只更新本执行记录。

## 安全与行为不变量

- Feedback 默认启用，但只受 feedback 独立配置和环境 opt-out 控制，不受 telemetry 开关控制。
- Comment 和 diagnostics 在出机边界执行凭据脱敏；session JSONL 在 Harness 的归档边界执行凭据脱敏。
- Diagnostics 发送前逐字展示最终有界内容；session archive 展示文件、大小、note、session、最后活动时间，并明确说明包含完整对话。
- 猜测 session 只允许最后活动 10 分钟内的最新项；显式 session 跳过窗口。
- 正文成功、bundle 失败仍是正文提交成功；bundle 失败单独保留并报告。
- Pending 正文或归档只在对应请求成功后删除；无效或陌生旧归档保持原样。
- 测试只使用临时目录和 mocked collector；test runtime 指向内置真实 collector 时必须立即拒绝，不上传或删除真实 pending 文件。

## 执行状态

| Step | Status | Tool | Expectation | Rollback |
| --- | --- | --- | --- | --- |
| 注册顶层 `step feedback` 和 TUI `/feedback`，接入独立开关及 dev/release body、bundle endpoint | completed | `step-cli.ts`、`extensions/step.ts`、`slash-commands.ts`、`feedback/settings.ts`、`feedback/endpoints.ts` | 两个入口可用；dev 默认发 test collector，release 默认发 production collector；feedback gate 与 telemetry 独立 | 移除两个命令接线和 feedback 专属配置，不影响 Pi 原生命令 |
| 对齐 feedback context 身份字段 | completed | `feedback/types.ts`、`feedback/context.ts`、Step extension dependencies | Context 与 telemetry envelope 逐字段一致；顶层 CLI 和 TUI 均携带可用的 `uid`、`username`，且不创建 device id | 只撤销新增身份字段和注入，不修改 telemetry context |
| 迁移 legacy `feedback.enabled` 并保持现有用户设置优先 | completed | `config-migration.ts`、`settings-manager.ts` | Global/project canonical 与 nested alias 按 scope 正确覆盖；已有 opt-out 不会被旧配置重新启用；解析失败不写完成 marker；v3 升级不重放模型迁移；写入使用同一锁语义 | 回退 feedback migration phase，不回退既有模型/凭据迁移 |
| 校验分类与 comment，并在出机边界脱敏 | completed | `feedback/validate.ts`、`feedback/submission.ts`、`secret-redaction.ts` | Category/rune 上界保持；comment、整段 diagnostics 的 labeled secret、header、JSON key 和 PEM 均脱敏，脱敏后重新应用 diagnostics 上界 | 回退对应调用点和 focused tests，保留独立 redactor 文件供其他边界使用 |
| 有界读取 diagnostics | completed | `feedback/diagnostics.ts`、`feedback/validate.ts` | 只读尾部 64KB；完整清理 ANSI、OSC、CR、backspace 等终端控制序列和绝对路径；newest-first；input trace note 优先；失败降级为无附件 | 回退 diagnostics reader 和断言，不影响正文提交 |
| 修正交互式 CLI 的 diagnostics 默认发现和快捷提交判定 | completed | `feedback/command.ts` | 裸交互命令默认发现并预览 diagnostics；带正文快捷提交不意外进入 guided 附件流程；显式跳过/附带仍生效 | 回退 CLI flow 改动，保留共享 submit/delivery |
| 选择 session 并生成 collector-compatible archive | completed | `feedback/bundle.ts`、`feedback/types.ts` | Pi JSONL 映射为 `events.jsonl`，必含 `bundle.json`；10 分钟猜测窗口；脱密后仍按完整行重新限制为 collector 的 entry 上界并更新 note；压缩超过 8MB 时只做一次 2MB fallback | 回退 bundle builder 和 focused tests，不影响正文提交 |
| 捕获 stderr dev log 并附带有界错误上下文 | completed | `stderr-dev-log.ts`、`step-cli.ts`、`feedback/bundle.ts` | 原 stderr 不变；跨 chunk 的 token/PEM 也在写盘前脱密；显式退出前可靠 flush；文件/目录权限受限；长生命周期进程仍按日执行七天保留；bundle 只附带含 `error` 的有界上下文并防御性再脱密 | 移除安装调用和日志模块；bundle 继续只含 session 条目 |
| 在 CLI/TUI 最终确认前展示实际附件 | completed | `feedback/command.ts`、`feedback/consent.ts`、`slash-commands.ts` | Diagnostics 逐字展示最终发送内容；bundle 使用同一份已构建字节展示完整 manifest、大小、session 信息和完整对话警告；TUI 可分页审阅；Esc 取消不会变成空正文 | 回退 consent UI 改动；不得改变已经构建的附件字节 |
| 分离正文与 bundle 投递结果并保留 recovery pair | completed | `feedback/delivery.ts`、`feedback/pending-store.ts`、CLI/TUI 输出 | Body 先发，bundle 后发；body 成功而 bundle 失败不返回正文失败；HTTP 400/404/409/413/429/5xx 分类明确；恢复文件正确配对 | 回退 delivery/output 增量，不删除现有 pending 文件 |
| 严格转换旧 pending archive 并补齐 transport/retry 安全边界 | completed | `feedback/pending-store.ts`、`feedback/delivery.ts` | 只转换准确的 `session.jsonl` + `manifest.json` 旧形状并保留安全的 file note；文件名与正文 `feedbackId` 必须一致；只重试 429/5xx，transport exception 立即失败；共同主机不可达后不逐条烧完退避预算，body/bundle 404 分别收敛；test runtime 不得访问内置 collector | 移除 legacy converter 或 retry guard；所有未成功文件继续保留 |
| 对齐成功/失败文案和 telemetry | completed | `feedback/command.ts`、`slash-commands.ts`、`telemetry-events.ts` | 正文成功打印 feedback ID/support 提示；bundle pending 单独说明；`bundle_included`/`bundle_bytes` 只反映成功上传，不携带用户正文 | 回退文案和 telemetry 属性计算，不改变 wire payload |
| 同步运行时文档 | completed | `packages/coding-agent/docs/step-integration.md` | Integration matrix 不再声称 `/feedback` 未迁移，并说明 feedback/bundle ownership | 回退对应文档，不修改运行时代码 |
| 补齐回归覆盖并运行仓库验证 | completed | 定向 Vitest、根 source-path type check、`npm run check`、`git diff --check`、`git status --short` | 覆盖 consent、diagnostics/inline JSON/cross-chunk secret、alias precedence、marker failure、脱密后 JSONL 上界、退出 flush、七天保留、bundle telemetry、transport policy、retry wall、test collector guard；本任务 focused 检查和全仓门禁均通过 | 只修本计划范围文件；不 reset、stash、clean 或处理其他 session 的改动 |

## 当前审查发现

初轮审查的 14 项问题均已收口。后续边界审计额外发现并修复：

1. TUI 80×24 consent 现在可分页查看全部正文、diagnostics 和 bundle 信息，Yes/No 始终可见；极窄、极矮终端禁止在没有可用预览区时确认。
2. 所有 consent metadata 会中和 C0/C1、CSI/OSC 与换行注入；CLI diagnostics 文件名使用同一展示层清理，wire 内容保持不变。
3. Secret redactor 支持敏感 JSON Schema 容器、PGP private key、显式 Bearer、原始 `@` URL 密码和 stderr 跨行标签；候选集与源行均有明确安全预算。
4. Session bundle 在取 24 MiB tail 前以有界流式扫描收集全文件 credential 语境；无法安全扫描时跳过归档，2 MiB fallback 从已脱敏内容派生。
5. Pending body 会校验文件名/正文 ID、category、at 与 context；pending archive 会拒绝多 gzip member 和 trailing data，所有无效文件保持原样。
6. 显式 session 文件的 ID 选择顺序为有效 header、可信 live session ID、安全 basename，避免正文 context 与 manifest 不一致。
7. 取值型 CLI option 缺值时不再吞掉后续 option。
8. Session JSONL 的每个非空物理行必须是完整、非 null、非数组的 object record；无法证明 tail 边界安全时只提交正文并跳过归档。
9. Pending gzip 会验证单 member、精确 DEFLATE 结束位置、CRC32、ISIZE 和 48 MiB 解压上界，并拒绝未展示的 FEXTRA/FNAME/FCOMMENT；tar 必须与 manifest 时间戳重建出的 canonical ustar 完全一致，合法的 alternate DEFLATE encoding 仍可重试。
10. Stderr stream redactor 会把新发现的 credential 传播到后续 echo；敏感值、UTF-8 code point 和 private-key body 可跨 chunk/flush，nested private-key marker 与任意超过 64 KiB 的物理行永久 fail-closed。
11. Guided CLI 测试使用隔离的 session root；readline EOF 在 category、comment 或最终确认阶段均安全取消，不提交也不埋点。
12. 正文 413/其他永久拒绝与 bundle recovery 使用一致的不可重试文案，不再同时建议对同一 pending pair 执行 `step feedback --retry`。
13. CLI telemetry 子进程测试使用仓库标准的 `tsx --tsconfig <root>/tsconfig.json` source-path 启动方式；运行前需要 hydrate/build 被 `.gitignore` 忽略的 `packages/ai` model data，否则静态 provider 导入会在 telemetry 初始化前失败。

## 后续边界审计与修复（2026-09-02）

| Step | Status | Tool | Expectation | Rollback |
| --- | --- | --- | --- | --- |
| 修复 telemetry 硬退出、flush 生命周期和 shutdown retry | completed | `telemetry-runtime.ts`、child-process 回归测试 | 已移出 buffer 的 batch 在显式退出时可同步持久化；flush 返回时 buffer/in-flight 均已收敛；shutdown 超时不丢数据且不无故延长进程生命周期 | 仅回退本步骤涉及的 runtime 与测试改动 |
| 统一 feedback/telemetry 身份解析并分离 wire/local session 规则 | completed | `feedback/context.ts`、公共轻量 resolver、身份回归测试 | uid、version、channel、commit 在两个 envelope 中一致；旧协议允许的 session ID 不被本地文件名规则误拒绝 | 回退 resolver 与 feedback context 改动 |
| 重试 pending body 前重新执行边界校验与脱敏 | completed | `feedback/pending-store.ts`、`feedback/delivery.ts`、pending 回归测试 | 手改或损坏的 pending body 不会原样出机；无效文件保留；有效文件遵守 comment/diagnostics/context 上界 | 回退 retry guard，不删除已有 pending 文件 |
| 完成 legacy migration 字段、provider precedence 和 BOM 兼容 | completed | `config-migration.ts`、migration 回归测试 | project 覆盖只覆盖本次迁移生成的 global 条目；modelsproxy nested/proxy-only 配置、token/timeout/route 字段不静默丢失；BOM 可读 | 回退本步骤迁移投影，不回退现有 canonical 配置 |

## 已实现能力的历史记录

- 已实现 comment/session bundle 凭据脱敏、diagnostics 尾读、trace note 优先、10 分钟 session 窗口。
- 已实现 `events.jsonl` + required `bundle.json`、stderr error context、legacy archive 转换。
- 已实现正文成功而 bundle pending 的 CLI/TUI 分离文案及 recovery pair。
- 已接入 dev/release 的 body 和 bundle 默认 endpoint；旧计划中的“dev endpoint 未接线”已失效。
- 旧计划记录的 85/85、22/22、14/14 测试结果均早于后续 bundle 改动，只保留为历史信息，不作为当前验收结果。

## 当前验证

- 定向 Vitest：16 个 feedback/telemetry/migration 文件、359 个测试通过。
- `npm run check`：通过；Biome、依赖/导入检查、shrinkwrap/install-lock、全仓 `tsgo --noEmit` 和 browser smoke 均通过。
- `git diff --check`：通过。
- 未运行完整 Vitest 或 e2e suite。
- 子进程测试使用临时链接的被 `.gitignore` 忽略的模型数据目录；验证后已清理，不进入提交。
- `pnpm-lock.yaml` 与 `AGENTS.md` 的共享工作树改动不属于本计划，未纳入集成分支。

## 收口规则

当前实现与验证已收口，但代码尚未 land，因此本文件继续保留在
`docs/exec-plans/active/`。代码实际落地后再移出 active；任何回退只处理本计划对应文件，
不回滚共享工作树中的其他改动。
