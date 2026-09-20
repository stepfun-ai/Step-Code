# 提交环境变量清理 MR

用户已明确要求按仓库规范提交 MR，授权本次提交、推送源分支和创建 MR。
范围为已验证的环境变量清理，不包含第三方 provider 或实验 CLI 命名清理。

| Step | Tool | Expectation | Rollback |
|---|---|---|---|
| 核对文件归属、验证记录和目标分支 | git status/diff、读取已完成计划 | 仅包含本会话修改，目标为 github-opensource | 不修改其他会话文件 |
| 从当前 github-opensource 创建 codex/drop-pi-environment-variables | git switch -c | 基线仍为 github-opensource | 保留提交与工作区，不强制切换 |
| 显式暂存本会话文件并提交 | git add 指定路径、git commit | pre-commit 与类型/边界检查通过 | 修正本会话提交，不绕过 hook |
| 推送并创建中文 MR | git push、glab mr create | 源/目标分支和远端 SHA 核对一致 | 如需撤销，关闭 MR；不强推或合并 |
| 回读 MR 并记录链接 | glab mr view | MR 为 open，描述含验证与 AI 署名 | 修正 MR 元数据 |

## 验证依据

代码实现和完整测试记录见 `../done/2026-09-20-drop-pi-environment-variables.md`。
本轮不改变运行时代码；提交 hook 会再次执行完整 check。已通过的全量测试无需重复。
