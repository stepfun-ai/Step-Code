# 清理 PI_ 环境变量

分支：`github-opensource`。本计划只覆盖 PI_ 环境变量与随之失去唯一开关的代码；
第三方 provider 清理另行计划。

## 判据

产品源码（`packages/*/src`、`apps/cli/src`）与随包分发的文档中不得出现任何 `PI_`
环境变量。不保留回退读取，不提供 `STEP_` 同义名——已有 `STEP_` 规范变量的直接删除
`PI_` 镜像；没有 `STEP_` 对应的，开关本身取消，行为固定为当前默认值。

`PI_BUNDLED_NODE` 是 esbuild 的编译期 define，不是环境变量，一并改名以免留下 `PI_` 字样。

## 变量处置

| 变量 | 处置 | 依据 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | 删写入与读取 | `STEP_CODING_AGENT_DIR` 已是规范变量 |
| `PI_CODING_AGENT` | 删两处写入 | 全仓无读取方，`AI_AGENT=step` 已是同等标记 |
| `PI_SESSION_ID/FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL` | 停止注入 | 产品向子进程输出的 PI_ 契约 |
| `PI_CACHE_RETENTION` | 删读取，固定 `short` | 无 `STEP_` 对应，默认即当前行为 |
| `PI_EXPERIMENTAL` | 删读取，连同 `core/experimental.ts` 与首次安装门 | 它是实验开关的唯一入口 |
| `PI_TIMING`、`PI_STARTUP_BENCHMARK` | 删读取与相应计时代码 | 启动 profiling 的唯一入口 |
| `PI_HARDWARE_CURSOR`、`PI_CLEAR_ON_SHRINK` | 删环境回退 | `settings.json` 已有 `showHardwareCursor` / `terminal.clearOnShrink` |
| `PI_HYPERLINKS`、`PI_IMAGE_PROTOCOL`、`PI_TRUE_COLOR`、`PI_TUI_ESC_TIMEOUT` | 删覆盖，保留自动探测 | 无 `STEP_` 对应 |
| `PI_TUI_WRITE_LOG`、`PI_TUI_DEBUG`、`PI_DEBUG_REDRAW` | 删开关与其调试输出 | 调试插桩的唯一入口 |
| `PI_TUI_DISABLE_INCREMENTAL` | 环境变量换成子进程命令行参数 | 它不是用户开关，是 `scripts/render-equivalence.test.mts` 合并门禁的驱动方式，删掉等于删门禁 |
| `PI_OAUTH_CALLBACK_HOST` | 删读取，固定 `127.0.0.1` | 无 `STEP_` 对应 |
| `PI_EVAL_ARTIFACT_DIR`、`PI_SESSION_SNAPSHOT_ARTIFACT` | 改用 `STEP_` 名 | `packages/evals` 不随包分发，但仓库内同样不留 `PI_` |

顺带清理的 pi 字样产物（同一批改动内）：`pi-crash.log`、`pi-debug.log` 文件名，
`packages/tui/src/tui.ts` 的 `~/.pi/agent` 兜底路径。

`STEP_CLI_DISABLE_PI_SERVICES` 名字里带 Pi 但前缀是 `STEP_`，且 `step --help` 会打印。
它属于"pi 相关命名"而非"PI_ 环境变量"，留到 provider 批次一起处理。

## 步骤

1. **Step** `packages/tui`：删 `terminal.ts` 的 ESC 超时覆盖与写日志开关、
   `terminal-image.ts` 的三个能力覆盖、`tui.ts` 的硬件光标/收缩清屏环境回退与
   `logDirectory` 环境兜底、`tui-main-screen.ts` 的重绘调试与渲染调试输出；
   `isIncrementalRenderDisabled()` 改为可由 `setIncrementalRenderDisabled()` 设定。
   **Tool** Edit。**Expectation** `node --test packages/tui/test/*.test.ts` 通过。
   **Rollback** 按本次 diff 逐项撤回本人改动，不覆盖其他会话文件。

2. **Step** `logDirectory` 由产品显式传入，通用 TUI 缺省使用系统临时目录：`login-flow.ts` 与 `examples/rpc-extension-ui.ts`
   在构造 `TuiMainScreen` 时显式传入 Step agent 目录。
   **Tool** Edit。**Expectation** Step 构造点不再依赖环境兜底。**Rollback** 同上。

3. **Step** `packages/coding-agent`：删 bash/powershell 的会话变量注入与
   `bashToolSystemPromptContribution` 里的 `PI_*` 提示语、`create-harness.ts` 的
   `prepare` 注入、`settings-manager.ts` 的两处环境回退、`core/experimental.ts`
   与其 5 个调用点、`core/timings.ts` 与其调用点、`first-time-setup-gate.ts`
   的实验门、`config.ts` 与 `step/auth.ts` 的注释、`step/environment.ts` 的镜像写入。
   **Tool** Edit。**Expectation** `./test.sh` 中 coding-agent 用例通过。

4. **Step** `packages/providers`：删三个 adapter 的 `PI_CACHE_RETENTION` 读取与
   `auth/oauth/anthropic.ts` 的回调主机覆盖。
   **Tool** Edit。**Expectation** providers 用例通过。

5. **Step** `apps/cli`：删 `main.ts` 的 `PI_CODING_AGENT` 写入、`startup-ui.ts`
   注释、`printTimings` 调用。**Tool** Edit。

6. **Step** `packages/evals` 与 `scripts/`：`PI_EVAL_ARTIFACT_DIR` /
   `PI_SESSION_SNAPSHOT_ARTIFACT` 改 `STEP_` 名；`profile-coding-agent-node.mjs`、
   `smoke-apps-cli.mjs`、`test.sh`、`check-lockfile-commit.mjs` 去掉 `PI_` 变量。
   **Tool** Edit。

7. **Step** 测试与文档：更新断言 `PI_` 名的测试文件；重写
   `packages/coding-agent/docs/environment-variables.md`；清掉 `README.md`、
   `docs/extensions.md`、`docs/settings.md`、`docs/tui.md`、`docs/terminal-setup.md`、
   `docs/providers.md` 里的 `PI_` 行。
   **Tool** Edit。**Expectation** 产品运行时与分发文档通过 environment-prefix 检查；旧名称仅保留在历史记录、负向测试或无产品语义的测试夹具中。

8. **Step** `npm run check`，再跑 `./test.sh`。**Expectation** 无 error/warning/info。

## 回滚

按本次 diff 逐项撤回本人改动；不覆盖其他会话的修改，不移动分支、不执行提交或发布。

## 边界

不改第三方 provider、不改 `pi` 实验子命令、不改 `@earendil-works/pi-*` 包名与
`@step-harness/pi-tui` 包名——这些属于 provider/命名批次。

## 执行记录

- 删除运行时开关和 shell 会话变量注入；目录变量固定为已有的 Step 名称，避免 APP_NAME 拼接恢复旧名称。
- 保留设置项、请求级 cacheRetention、spawnHook 和渲染等价性门禁；通用 TUI 日志缺省目录改为临时目录，Step 登录页显式传 agentDir。
- 原 TUI 启动 profiler 依赖已删除的唯一开关，移除该模式和 profile:tui 脚本，保留 RPC profiler。
- 测试中的旧变量只用作“不再生效”的回归输入；不修改发布历史 CHANGELOG。
- 补齐锁文件内缺少的 smol-toml 依赖（--frozen-lockfile --ignore-scripts），未改锁文件。
- npm run check 首次被其他工作树的配置和依赖阻塞，补充 Biome 与两个递归检查脚本的工作树排除。
- 94 个 TUI 定向测试、31 个 coding-agent 定向测试通过；渲染等价性 82 帧、335747 字节一致。
- 全量隔离测试首轮 providers 469 / agent-core 465 通过；coding-agent 6 处失败中，一处为待更新的 session env 断言，五处来自子进程未加载 tsx 而读取陈旧 dist，已修正并复验。
- 新增 environment-prefix 检查，禁止运行时与产品文档恢复旧变量。

## 完成验证

- `npm run check` 通过：Biome、类型检查、依赖/层级边界、browser smoke 与新增前缀检查全部通过。命令行工具仍打印已有的 npm/pnpm 配置提示，未调整依赖策略以消除全局包管理器提示。
- `./test.sh` 最终退出码 0。coding-agent 2853 passed / 66 skipped；providers 469 passed / 124 skipped；CLI 562 passed；evals 23 passed；agent-core 465 passed / 1 skipped。TUI 与其余包通过；scripts 43 passed / 3 skipped（PowerShell 不可用）。
- 渲染等价性门禁通过：82 帧、335747 字节，优化与基线逐字节相同。
- 额外复验 evals 模型选择与 artifact 持久化：8 passed。
- `git diff --check` 通过，未修改锁文件，未提交、推送或发布。
- 本计划完成；第三方 provider 与 pi 命令/命名的后续批次尚未实施。原会话中 provider 源码是否一并删除的范围问题仍未得到回答。
