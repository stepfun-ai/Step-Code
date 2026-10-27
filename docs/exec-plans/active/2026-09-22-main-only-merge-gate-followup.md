# 主仓开发分支合并门禁修复

## 目标

允许项目的正常开发分支直接合并到 `main`。开源同步由独立的 `github-opensource` promotion 流程负责，不再用 CI 分支白名单阻断主仓开发。

## 执行步骤

1. **移除错误门禁**
   - **Tool**：从 `.gitlab-ci.yml` 删除 `enforce-merge-order` job。
   - **Expectation**：正常开发分支的 `main` MR 不再被误判为非法开源 promotion；其他 lint/test 仍照常执行。
   - **Rollback**：恢复该 job 原始 `case` 分支判断。

2. **验证与发布**
   - **Tool**：运行 YAML 解析、分支矩阵检查、`npm run check`；提交并推送当前 CI-only 分支，创建目标为 `main` 的 MR。
   - **Expectation**：CI-only MR 的 lint/test pipeline 正常运行，MR 无代码同步到 `github-opensource`。
   - **Rollback**：关闭 MR，删除源分支，恢复 `.gitlab-ci.yml`。

3. **合并**
   - **Tool**：确认 pipeline、审批和无冲突状态后合并 MR 到 `main`。
   - **Expectation**：`main` 不再用错误的 promotion 白名单限制正常开发分支。
   - **Rollback**：按 GitLab 权限执行 revert，不改动开源分支。
