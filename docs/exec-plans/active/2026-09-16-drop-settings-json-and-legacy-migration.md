# 移除 settings.json 与旧版 config.json 迁移

创建：2026-09-16。状态：实施中。

## 决定

Step 不再以任何形式读写 `settings.json`。配置的唯一来源与写入目标是 `config.toml`
（`StepTomlSettingsStorage`）；`models.json` 与 `auth.json` 保持 JSON，位置不变。

旧版 `config.json` 迁移整体删除——不再读旧文件，也不再产生 `settings.json`。

## 现状

运行时读取其实已经是 TOML-only：`settingsManagerFactory` 恒走
`createStepSettingsManager` → `StepTomlSettingsStorage`，pi 原生的
`FileSettingsStorage` 对 `step` 二进制不可达。首次设置门禁
（`shouldRunFirstTimeSetup`）要求 `APP_NAME === "pi"`，对 Step 恒为 false，也已失效。

真正还在碰 `settings.json` 的只有下面这些。

## 步骤

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 1 | 抽出 models.json 端点修复 | 新建 `step/models-endpoint-repair.ts`，搬 `normalizeStepModelsFile` + `normalizeStepBuiltinProvider` + `isStepBuiltinModel` + `isLegacyStepProvider` 及所需小工具 | 新模块自洽，不依赖迁移 | `git checkout` 该文件 |
| 2 | 删除迁移模块 | `git rm packages/coding-agent/src/step/config-migration.ts` | 旧投影、marker、`.bak` 归档、`readStepGlobalDefaults`、`repairStepLoginBinding` 一并消失 | `git checkout` |
| 3 | bootstrap 只读 TOML | 改 `apps/cli/src/bootstrap/config.ts`：去掉 `migrateStepConfig`/`readStepGlobalDefaults`，`StepStartupConfig` 去掉 `migration` 字段，改为调用步骤 1 的端点修复 | 启动只读 `config.toml` | `git checkout` |
| 4 | CLI 入口去迁移 | 改 `apps/cli/src/main.ts`：删 `stepConfigMigration` 警告循环、默认值兜底、`beforeRuntimeCreate` | 无 migration 引用 | `git checkout` |
| 5 | `step config` 指向 TOML | 改 `step/command-compat.ts`：删 `step config migrate` 子命令，`globalSettings`/`projectSettings` 指向 `config.toml` | `step config` 不再显示 settings.json | `git checkout` |
| 6 | barrel 导出清理 | 改 `src/index.ts`、`src/step/index.ts` | 无悬空导出 | `git checkout` |
| 7 | ~~信任资源列表~~ | 已放弃 | 见下方"信任列表保留 settings.json" | — |
| 8 | 文案 | `ui/view/dialogs/config-selector.ts`、`ui/view/dialogs/first-time-setup.ts`、`package-manager-cli.ts`、`utils/shell.ts` | 不再向用户提 settings.json | `git checkout` |
| 9 | 测试 | 删 `test/step-config-migration.test.ts`，把其中两个端点修复用例移到新模块的测试；改 `test/step-config-paths.test.ts` 用 `config.toml` | 相关用例覆盖保留 | `git checkout` |
| 10 | 文档 | `docs/step-configuration.md`、`docs/step-unified-config-and-mcp.md`、`packages/coding-agent/docs/step-integration.md` | 与实现一致 | `git checkout` |
| 11 | 校验 | `npm run check`、`npm run build`、全量测试 | 全绿（除已知的超长路径用例） | 按报错回退 |
| 12 | 合并到 fix 分支并推送 | `git merge` + `git push` | 两分支一致 | 见下 |

## models.json 端点修复也已移除（修正）

原先把 `normalizeStepModelsFile` 抽成独立模块保留，理由是"跟着迁移一起删会让老用户
卡在打不通的端点上"。这个理由不成立，实测已证伪：

Step provider 注册了 `normalizeModels` 钩子（`features/step-provider/index.ts`），
`normalizeStepModel()` 对内置 Step id **每次启动都在内存里**强制恢复
`api: "anthropic-messages"` 与规范 endpoint，非内置的 anthropic 模型则走
`normalizeStepAnthropicBaseUrl()` 循环剥离后缀。用一个同时含错误方言、旧代理 host
和 `/v1/v1/messages` 双重后缀的 models.json 直接走 ModelRuntime（不做任何文件修复），
解析结果是 `anthropic-messages` + `https://api.stepfun.com/step_plan`，
实际请求打到 `https://api.stepfun.com/step_plan/v1/messages`——正确。

所以那个模块只是把运行时已经得到的结果额外持久化一遍，对正确性没有贡献，还多了
改写用户文件的副作用；这也与 a3799398 确立的"读取时归一化、不改写用户文件"一致。
`step/models-endpoint-repair.ts`、`bootstrap/config.ts` 的调用、两处 barrel 导出
与对应测试一并删除。

## 信任列表保留 settings.json

原计划把 `"settings.json"` 从 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 移除，
理由是 Step 不再读它。这个理由不成立：pi 原生的 `FileSettingsStorage` 仍会读取项目
`settings.json`（本次不删这部分死代码），`package-command-paths` 的三个信任用例正是
覆盖这条路径。移除后，未受信任项目的 `settings.json` 会被直接采纳——是个真实的安全
回退。因此该条目保留：只要还有读取方，它就仍是项目输入。

## 副作用确认

步骤 12 会推送到 origin 上两个已存在的远端分支，沿用上一轮任务的授权，不使用 force push。
