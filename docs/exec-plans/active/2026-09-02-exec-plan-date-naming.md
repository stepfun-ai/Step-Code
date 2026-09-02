---
title: Exec-plan 日期前缀规范
status: completed
---

# Exec-plan 日期前缀规范

## Step

1. 在 `AGENTS.md` 中明确 exec-plan 文件名必须使用 `YYYY-MM-DD-<kebab-name>.md`。
2. 将现有 `docs/exec-plans/active/` 计划文件重命名为带日期前缀的格式，并保留正文内容。
3. 检查引用、差异和工作区状态，提交本次规范变更并推送当前分支。

## Tool

- 使用 `apply_patch` 更新 `AGENTS.md` 和本计划。
- 使用 `git mv` 重命名现有计划文件。
- 使用 `rg`、`git diff --check`、`git status` 和 `git diff` 验证。
- 使用显式路径 `git add`、`git commit`、`git push` 交付变更。

## Expectation

- 规则明确说明日期前缀格式、日期含义和新建计划的命名示例。
- active 目录下每个 exec-plan 文件名均符合该格式，正文无意外变化。
- 校验通过，提交只包含本次规范和计划文件改名，不包含既有用户修改。

## Rollback

- 若校验或提交前发现问题，恢复 `AGENTS.md` 的对应段落并将计划文件改回原名。
- 若推送失败，保留本地提交并报告远端错误，不重复创建提交。

## Result

- `AGENTS.md` 已明确日期前缀格式和命名示例。
- active 目录中的现有计划已按首次提交日期补齐前缀。
- 旧路径无引用，`git diff --check` 通过。
