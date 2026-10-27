# 将 main 合并进 feat/stepcode-desktop-ci-pipeline-build

## 背景

`feat/stepcode-desktop-ci-pipeline-build` 从 `github-opensource` 血统的桌面分支长出
（merge-base = `81e79bc4`）。`main` 与桌面分支各自独立实现了同一套 usage telemetry：
桌面侧是 `dc9b27e1` + `03497f22`（公开安全的精简版），main 侧是 `3b8b90b6` +
`da4e03d6` + `f84b5ad5`（更晚，含 review 后的显式凭证、YAML 运行时配置、防御性
response 解析、`config.toml` 端点优先级），并且 main 的
`apps/cli/src/observability.ts` 是真实上报实现。

目标：把 main 合进桌面 build 分支，让桌面构建具备内部埋点观测能力。只本地合并，不推送。

## 决定（用户确认）

1. 遥测实现与测试整体取 main 版本，桌面侧 `dc9b27e1` / `03497f22` 被取代。
2. 跟随 main 删除 `scripts/check-no-observability.mjs` 与
   `scripts/check-public-boundary.mjs`，并从 `check` 链和 `package.json` 去掉对应条目。
3. `.gitlab-ci.yml` 保留桌面 workflow 规则（tag / web / api / trigger），另加
   `vX.Y.Z` tag；移植 main 的 CLI/TUI jobs，全部经 `.cli-docker-job` 得到
   `before_script: []`。

## Step / Tool / Expectation / Rollback

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 建本地跟踪分支 | `git switch -c ... --track origin/feat/...` | HEAD = `03497f22` | 删分支 |
| 合并 | `git merge --no-commit origin/main` | 19 个冲突文件 | `git merge --abort` |
| 遥测文件取 main | `git checkout --theirs` + `git add` | 8 个实现/测试文件与 main 逐字节相同 | `git checkout HEAD -- <path>` |
| `step.ts` 手工合并 | 保留 plan-mode 预判 + main 的 lifecycle 记录 | 两条路径都在 | 同上 |
| `index.ts` 只解遥测导出块 | 保留桌面独有导出 | web/desktop 仍可编译 | 同上 |
| `AGENTS.md` | 取 main，追加 Package-level rules | 桌面/Web 包规则保留 | 同上 |
| 文档 | 取 main 的遥测章节，补桌面侧说明 | desktop 相关陈述保留 | 同上 |
| CI | 手写合并文件 | YAML 可解析，11 个 job，无悬空 need/stage | 同上 |
| lockfile | 取 HEAD 版本后 `pnpm install --lockfile-only --ignore-scripts` | 无差异（依赖集两侧相同） | 同上 |
| 验证 | `npm run check` + `pnpm test` | 全绿 | — |

## 结果

- `npm run check` 退出码 0（含 biome、13 个校验器、tsgo、check:web、check:web-runtime、
  check:browser-smoke、check:desktop）。
- `pnpm test` 退出码 0：contracts 5 / telemetry 15 / config 12 / lark-adapter 43 /
  providers 486 / agent-core 539 / coding-agent 5192 / cli 763 / web 610 / desktop 20，
  0 失败。
- 遥测探针：`STEPCODE_BUILD_USAGE_TELEMETRY="$(node scripts/load-usage-telemetry-config.mjs)"`
  下 dev / release 两个 channel 都解析到
  `https://api.stepfun.com/stepcliobserserver/api/v1/events`；
  `STEPCODE_TELEMETRY_ENDPOINT` 仍可覆盖。
- 遥测实现文件与 main 逐字节一致（`telemetry-runtime.ts`、`telemetry.ts`、
  `usage-telemetry.ts`、`usage-telemetry-config.ts`、`observer-endpoints.ts`、
  `apps/cli/src/observability.ts`、`model-request-observer.ts`、对应测试）。
- `apps/web/test/feedback-evidence.test.ts` 两个用例按 main 的 feedback 默认路由改写：
  main 的 `resolveFeedbackEndpoint` 在 dev/release 都有内置路由，原用例断言的
  「没有 endpoint 就拒绝」在合并后不可达。

## CI 合并口径

- workflow 只允许 `desktop-v*` tag、`v*` tag，以及 web/api/trigger 手动触发；
  分支 push 与 MR 不产生 pipeline（与合并前一致）。
- CLI/TUI jobs 移植了定义，但规则收在 `.cli-check-rules`（`v*` tag，或
  `STEP_RUN_CLI_JOBS=true` 的手动 pipeline）和 `.cli-tag-rules`（`v*` tag + manual）。
  只按 `$CI_COMMIT_TAG` 判断会让 `desktop-v*` tag 也弹出 CLI bundle 上传 job，
  且它会读桌面版本号，所以必须按 tag 前缀区分。
- 所有 CLI job 经 `.cli-docker-job` 拿 `before_script: []`，否则 falcon include 的
  全局 before_script 会在 release-builder 镜像里克隆 falcon 工具链。
- stages 取并集：lint / verify / test / tag / package / macos-* / upload / publish / notify。


## 未验证 / 注意

- `./test.sh` 在本机跑不了：`PATH` 里的 `~/.local/bin/git` 是依赖真实 `$HOME` 的包装
  脚本，test.sh 隔离 HOME 后它以 126 退出。改用 CI 同款 `pnpm test`。
- GitLab CI 无法本地 lint（`glab` 未安装，falcon include 取不到）；`.gitlab-ci.yml`
  只做了 YAML 解析与 job/stage 静态检查。
- 合并后该分支带有内部遥测实现与内部端点，不可再并入 `github-opensource`。

## Rollback

`git merge --abort`（尚未提交时）；已提交则 `git reset --hard 03497f22`（仅本地分支）。
