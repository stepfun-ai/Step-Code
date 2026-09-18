# 2026-09-18 workflow 注册默认开启(完全对齐 Claude Code)

## 背景

workflow 工具注册当前是 opt-in:`resolveWorkflowRegistration` 要求
`options.enabled === true` 或 `STEP_ENABLE_WORKFLOW` 环境变量,而产品入口
(`apps/cli/src/bootstrap/extensions.ts`)不传 `workflow.enabled`,也没有任何
config 开关——导致默认安装下 workflow / `/workflows` / `/ultraloop` 完全不可用,
且是静默 no-op(用户实测"输入 workflow 也不生效")。Claude Code 侧该工具默认注册,
使用侧才靠 ultracode/触发短语 opt-in。用户明确指示"完全对齐":注册默认开,
`STEP_DISABLE_WORKFLOW` 保留为唯一关门开关。

## Step / Tool / Expectation / Rollback

1. **Step** 翻转注册门:`registration-gate.ts` 中 disable env 优先判,
   `options.enabled === false` 显式关,默认(undefined/true)进入 VM 可用性检查;
   不再读 `STEP_ENABLE_WORKFLOW`。同步更新 `WORKFLOW_VM_UNAVAILABLE_WARNING`
   文案(默认开后该警告默认可触发,不再提 enable flag,补 disable 提示)。
   **Tool** Edit/Write `packages/coding-agent/src/features/workflow/registration-gate.ts`。
   **Expectation** 空 options + 空 env → `{ enabled: true }`;
   `STEP_DISABLE_WORKFLOW=1` 或 `enabled: false` → 拒绝;VM 缺失且无
   vmExecutor → `vm-unavailable`(默认路径也会警告)。
   **Rollback** `git checkout -- <file>`(单文件还原,不影响他人)。

2. **Step** 注释对齐:`step-capabilities.ts` options 注释、`ultraloop-opt-in.ts`
   头注释里 "STEP_ENABLE_WORKFLOW gates REGISTRATION" 的表述改为默认开 +
   disable 开关。**不动** `step-workflow.ts` 的 tool description 与
   promptGuidelines(模型可见文本冻结,只能加可选属性)。
   **Tool** Edit 两个文件的注释行。
   **Expectation** 注释与新语义一致;`npm run check` 无新告警。
   **Rollback** 同上单文件还原。

3. **Step** 测试更新:`test/workflow-registration.test.ts` 改为默认注册锚点
   (默认 enabled、embedder `enabled:false`、`STEP_DISABLE_WORKFLOW` 压倒一切、
   `STEP_ENABLE_WORKFLOW` 不再被读、vm-unavailable 默认路径警告一次、关门静默);
   `test/workflow-extension.test.ts:76` "disabled by default" 用例改为
   "registers by default + 两个关门开关"。
   **Tool** Write/Edit 两个测试文件,逐文件跑
   `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>`。
   **Expectation** 两文件全绿;`workflow-ultraloop-opt-in.test.ts`(全显式
   enabled 选项)不需改动、跑一遍确认。
   **Rollback** 还原测试文件。

4. **Step** 收尾:根 `CHANGELOG.md` `[Unreleased] → Changed` 增补一条;
   `npm run check` 全量过;报告中显式标注两项已被用户接受的风险
   (release 二进制无 isolated-vm 时默认出现启动警告;RL/eval 默认多出
   workflow 工具面,RL 侧需 `STEP_DISABLE_WORKFLOW=1`)。
   **Tool** Edit CHANGELOG + Bash `npm run check`。
   **Expectation** check exit 0;不提交、不推送(等用户确认落点,当前分支
   背着 MR !81)。
   **Rollback** 还原 CHANGELOG 行。

## 边界

- 不动 `step-workflow.ts:149/:184` 模型可见文本里的 "(STEP_ENABLE_WORKFLOW)"
  字样(描述冻结约束;语义上"registered 是环境能力不是 consent"仍然成立)。
- 不新增 config.toml 开关(用户否决了 config-switch 方案,要求纯对齐)。
- `docs/plan-loop-cron-workflow-hoh.md` 是历史设计计划,不回改。
