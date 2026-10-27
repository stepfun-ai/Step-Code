# 内部生命周期遥测与会话归属修复

## 目标

恢复内部 main 的实际生命周期及权限事件生产；会话归属由会话生命周期维护，模型请求只携带自身 session，不修改前台归属。公开分支保留现有边界。

已阅读能力计划 `2026-08-31-step-agent-capabilities.md` 及已完成的开源同步记录；本计划收口实际生产接线缺口。

## 执行

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 创建内部修复分支 | fetch origin/main，git switch -c fix/internal-telemetry-lifecycle origin/main | 基于最新内部 main，保留本计划 | 未提交时仅撤回本任务改动 |
| 修复事件与归属 | patch Step 扩展、生命周期与模型请求适配器 | 生命周期注册且权限事件来自实际处理；切换即时更新、结束清理、迟到请求不污染前台 | 撤回本任务补丁 |
| 回归与文档 | 实际 CLI 扩展入口的假 reporter 测试；更新遥测行为文档 | 正常轮次、权限、首次请求前、A→B、迟到请求和清理均有断言 | 按失败修复或撤回本任务补丁 |
| 验证 | 定向测试、npm run check、./test.sh、git diff --check | 所有必要检查通过 | 修复失败后重跑相关检查 |
| 提交 MR | 显式 git add、commit、push、glab mr create --target-branch main | 仅本任务改动，中文描述附验证结果 | 未合并时关闭 MR；已合并时走 revert MR |

## 授权

用户已明确确认本次覆盖 AGENTS.md 的 github-opensource 分支限制：从 origin/main 建分支，修复与测试后提交、推送并向 GitLab main 提 MR。该确认同时授权本计划的提交与发布 MR 操作；不合并 MR、不发版。

用户另行确认：本机无 glab/API 凭据，授权通过已登录的浏览器替代 glab 创建 MR。

## 执行记录

- 分支基线为最新内部 `origin/main`：`0c8d4eb`。
- 已恢复生命周期与权限生产；权限观察不重复计算策略；已移除模型请求回调对前台 session 的写入。
- CLI 实际注册入口回归 10 项通过；遥测、Step 扩展与权限相关 6 个文件共 109 项通过。
- `npm run check` 通过。npm 11 对仓库既有 pnpm 专属 `.npmrc` 字段产生兼容性提示，代码检查无诊断。
- 全仓测试首次受 HOME 隔离后本机 Git wrapper 路径失效阻断；调整 PATH 后发现 macOS 临时目录过长使 tsx IPC socket 报 EINVAL。最终验证改用系统 Git 与短 TMPDIR，不修改仓库测试脚本。
- `TMPDIR=/tmp PATH="/usr/bin:/bin:$PATH" ./test.sh` 全仓通过：脚本 48 项（跳过 3），contracts 5、telemetry 15、config 12、providers 425（跳过 6）、agent-core 524（跳过 1）、coding-agent 4087（跳过 58）、CLI 666；TUI 测试命令成功退出。
- 修复与验证完成，执行记录归档至 done，随修复提交到内部 main 的 MR。
