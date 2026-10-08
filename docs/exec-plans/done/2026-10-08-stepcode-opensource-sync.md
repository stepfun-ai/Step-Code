# StepCode 开源同步执行计划

## 目标

把 GitHub `stepfun-ai/Step-Code` 的最新 `main` 单向同步到内部 GitLab
`github-opensource`，再从内部 `main` 全量 promote，通过两个 MR 合入，完成
release 打包与 tag dry-run，并在实际创建 tag 前停止。

## 执行步骤

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 更新基线 | `git fetch github main`、`git fetch origin` | 本地 refs 与两个远端一致，确认 GitHub 新提交范围和共同祖先 | 不修改分支，无需回滚 |
| Stage 1 同步 | 从 `origin/github-opensource` 建同步分支并 merge `github/main` | 文件集与 GitHub 对齐，内部 `AGENTS.md`、`CLAUDE.md` 和必要边界守卫保留 | merge 未提交时 `git merge --abort`；已提交但未合并则关闭 MR |
| Stage 1 验证与 MR | 冻结安装、`pnpm run check`、`pnpm run test:scripts`、GitLab MR | 校验通过，MR pipeline 通过并以非 squash merge 合入 `github-opensource` | 修复特性分支后重跑；不直推保护分支 |
| Stage 2 promotion | 先 `git merge-tree` 预演，再从 `origin/main` 建分支 merge `origin/github-opensource` | 公共代码进入 main，内部遥测、发布链路和内部专属文件完整保留 | merge 未提交时 `git merge --abort`；未合并 MR 可关闭 |
| Stage 2 门禁与 MR | 遥测门禁、删除门禁、常规检查、定向测试、源码归档、MR pipeline | 无未审计遥测变化或删除，MR 以非 squash merge 合入 `main` | 恢复受影响内部文件或重新解析冲突后重跑 |
| Release 准备 | 六平台 bundle、校验和、当前平台烟测、`release:step --dry-run` | 产物完整且版本正确，工作区干净，目标 tag 尚不存在 | 删除本地忽略产物即可；不创建、不推送 tag |

## 边界

- 不从内部仓库向 GitHub 回推任何内容。
- 不直推 `main` 或 `github-opensource`，全部通过 MR。
- 不使用 `-X theirs` 覆盖 promotion 中含内部逻辑的文件。
- 不创建或推送 release tag；实际打 tag 由用户完成。
- commit 保持当前已验证的人类 Git 身份，不添加 AI co-author trailer。

## 执行结果

- GitHub `main` 从 `519e4de` 前进到 `494c8f2`，共同步 16 个上游提交。
- Stage 1 MR !139 合入 `github-opensource`，文件集与 GitHub 对齐。
- Stage 2 仅有两个 changelog add/add 冲突，保留内部完整历史并补入公开修复说明。
- 遥测门禁通过；唯一删除 `callback-server.ts` 经审计属于 Step CLI HTTPS init+poll 登录协议迁移。
- `pnpm run check`、脚本测试、遥测及变更定向测试通过。
- `0.1.3` 源码归档和六平台 release bundle 已生成并通过校验，macOS ARM 二进制返回 `0.1.3`。

## 完成判据

- `github/main` 是内部 `github-opensource` 的祖先，后者又是内部 `main` 的祖先。
- 两个目标分支的合并后 pipeline 通过。
- 遥测门禁、删除门禁、常规检查、定向测试和打包校验全部通过。
- release dry-run 成功且本地、远端均没有新 release tag。
