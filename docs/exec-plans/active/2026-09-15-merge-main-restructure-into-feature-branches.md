# 把 main 的重构结构合并进 fix/feedback-130-plus 与 feat/unified-step-config-mcp

创建：2026-09-15。状态：实施中。

## 背景

`main` 在 `de256ea` 合入了 `refactor/step-restructure`，做了大范围结构调整：

- npm workspaces → pnpm（`package-lock.json` / `npm-shrinkwrap.json` / `install-lock/` 全部删除，改用 `pnpm-lock.yaml`）。
- 包重命名：`packages/ai` → `packages/providers`，`packages/agent` → `packages/agent-core`；
  删除 `packages/client` / `protocol` / `server` / `session-backends`；
  新增 `packages/config` / `contracts` / `extensions` / `realtime` / `voice-agent`。
- 内部 scope 统一：`@earendil-works/pi-*` → `@step-harness/*`
  （仅 `core/extensions/loader.ts` 与 `theme/theme.ts` 保留旧 scope 作为兼容面，见 `scripts/check-legacy-scope-prefix.mjs`）。
- 交互式 UI 从 `packages/coding-agent/src/modes/interactive/**` 搬到 `apps/cli/src/ui/**`；
  `src/step-cli.ts` → `apps/cli/src/main.ts`；`src/extensions/` → `src/features/`；
  `theme/` 与 `render/` 提升到 `packages/coding-agent/src/{theme,render}/`。
- 对应测试从 `packages/coding-agent/test/` 搬到 `apps/cli/test/`。

两个待合并分支的共同祖先是 `ac2b7b8`，且 `feat/unified-step-config-mcp` 是
`fix/feedback-130-plus` 的祖先（后者 = 前者 + 2 个提交）。因此先合 unified，
再把 unified 合进 fix，避免对同一批重构冲突解两遍。

## 风险：会静默丢功能的地方

`git merge` 的改名识别能把大部分改动正确落到新路径，但下面几类不会自己修好：

1. 分支新增的文件（`src/step/mcp-import*.ts`、`mcp-import-view.ts`、`mcp-import-prompt.ts`）
   仍然 import `../modes/interactive/**` 和 `@earendil-works/pi-tui`——在 main 上这些路径已不存在。
   直接 add 进来会编译失败（或更糟：被 `check` 之外的路径漏掉）。
2. 分支新增的交互式测试会被 add 到 `packages/coding-agent/test/`，
   而对应被测代码已搬到 `apps/cli/`，需要一并移到 `apps/cli/test/`。
3. lockfile 冲突是 modify/delete：必须接受 main 的删除，并把新依赖
   `smol-toml@1.8.0` 落到 `pnpm-lock.yaml`。
4. `src/main.ts` 与 `apps/cli/src/main.ts` 都存在，分支对旧 `main.ts`/`step-cli.ts`
   的改动可能落到已经不再被调用的那一份。解冲突时要确认真正的组合根。

## 步骤

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 1 | 在独立 worktree 上操作，不动主工作区的 main | `git worktree add` | 主工作区保持 clean | `git worktree remove` |
| 2 | `git merge main` 进 unified | `git -c merge.renameLimit=20000 merge main` | 13 处内容冲突 + 3 个 lockfile modify/delete | `git merge --abort` |
| 3 | lockfile 冲突取 main 的删除 | `git rm` 三个 npm lockfile | 工作区无 npm lockfile | `git merge --abort` |
| 4 | 逐个解 13 处冲突，保留双方语义 | 手工编辑 | 无冲突标记 | `git checkout -m <file>` |
| 5 | 修正新增文件的 import 路径与 scope | 手工编辑 | 无 `modes/interactive` / `@earendil-works` 残留 | 同上 |
| 6 | 把交互式测试移到 `apps/cli/test/` | `git mv` | 测试与被测代码同包 | `git mv` 反向 |
| 7 | `smol-toml` 依赖落到 coding-agent + 刷新 pnpm lock | `pnpm install --lockfile-only --ignore-scripts` | `pnpm-lock.yaml` 含 smol-toml | `git checkout pnpm-lock.yaml` |
| 8 | 全量校验 | `pnpm run check` | 0 error / 0 warning | 按报错回到步骤 4-6 |
| 9 | 跑受影响测试 | `./test.sh` / 指定 vitest | 全绿 | 修实现或测试 |
| 10 | 功能不丢核对 | 对 `ac2b7b8..分支` 的每个文件逐项核对落点 | 每项都在新结构里有对应实现 | 补齐 |
| 11 | 提交 unified | `git commit` | 合并提交生成 | `git reset --keep HEAD@{1}` |
| 12 | 把 unified 合进 fix 分支，重复 4-11 | 同上 | 同上 | 同上 |
| 13 | push 两个分支 | `git push origin <branch>` | 远端更新 | 见下方确认项 |

## 需要确认的副作用操作

步骤 13 会推送到远端（`origin`，两个已存在的远端分支）。用户已在本次任务中明确要求
"合并完成后把这两个分支提交并push到远端"，据此执行；不使用 force push。
