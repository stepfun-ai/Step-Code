# Step Code 贡献者 SOP

给想帮 Step Code 修问题、做改进的开发者看。先认领问题，再动手开发；提交后由内部维护者审核并合并。本文是流程速览，详细要求以 [CONTRIBUTING.md](CONTRIBUTING.md) 为准。

## 项目在哪里

- 项目仓库：[Step Code](https://github.com/stepfun-ai/Step-Code)
- GitHub Issues：[查看问题列表](https://github.com/stepfun-ai/Step-Code/issues)
- 项目贡献规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- 开发说明：[docs/development.md](docs/development.md)
- 提交模板：[PR 模板](.github/pull_request_template.md)

## 一句话流程

**找问题 → 确认认领 → 改代码和自测 → 提交 PR → 内部维护者审核、合并。**

这里说的“MR”在 GitHub 上叫 PR（Pull Request），是同一类代码审核请求。

## 1. 从哪里找问题？

GitHub 上已经有 Issue：优先看 Issue 的描述和讨论。想做的话，先在 Issue 下留言说明打算怎么解决，请维护者确认是否已有其他人在做、方案是否合适，避免做完才发现方向不对。

其他社区反馈的问题：先联系维护者，确认问题背景、负责人、预期结果和是否已有对应的 GitHub Issue，再开始开发，避免多人重复工作。没有对应 Issue 时，与维护者确认是否需要先创建 Issue。

看到已有 PR 链接：可以用来了解问题、复现方式和已有思路，但不代表可以直接合并那个外部 PR。请以当前仓库代码和问题要求为准，自己核对方案、实现、测试和来源；不要未经确认照搬别人的代码。发现重复工作，先联系维护者。

问题说不清、影响范围很大，或需要改公开接口时，先讨论清楚再开工。安全漏洞不要公开贴凭据或敏感细节，按项目的 [SECURITY.md](SECURITY.md) 报告。

## 2. 开发前先看什么？

1. 阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和根目录的 [AGENTS.md](AGENTS.md)；修改某个模块时，还要看该目录及其祖先目录下的 `AGENTS.md`。
2. 确认要解决的具体问题、完成标准和修改范围。从最新 `main` 开工作分支，不要直接改 `main`。开发环境和依赖安装方式参见 [开发说明](docs/development.md)。
3. 保持改动聚焦：一个 PR 尽量只解决一个问题；不顺手塞无关重构。新功能先判断是否适合用扩展实现，而不是都加进核心。
4. 可以用 AI 辅助写代码，但提交者必须能解释自己改了什么、为什么这么改、怎么验证。

## 3. 提交代码有什么要求？

- 提交信息和 PR 内容用英文。Commit 标题和 PR 标题使用 Conventional Commits，例如 `fix(session): preserve queued input after cancellation`。按完整、独立的改动拆分提交，不要为了凑提交数拆成很多空碎提交。
- Git 的 author / committer 应是开发者本人已验证的 GitHub 身份；不要把 AI 工具写成共同作者，也不要附带 AI 工具生成的署名尾注。
- 改行为时补上相关测试、必要文档；注意旧行为是否被破坏，以及配置、命令行参数、会话数据、扩展接口等是否受影响。不要把密钥、私人项目内容或内部资料提交到公开仓库。
- 开发中先跑与改动相关的测试，测试选择参见 [docs/testing.md](docs/testing.md)。提交或更新 PR 前，在仓库根目录运行以下两项检查，两项都要通过：

  ```bash
  npm run check
  ./test.sh
  ```

  `check` 可能自动修改格式，提交前看一遍 diff。若有环境限制或尚未验证的部分，在 PR 中如实写明，不要写“已通过”。

## 4. 怎么提交审核？

按项目贡献规范，仓库的 PR 创建权限应设为 **Collaborators only**；实际配置由维护者确认。认领问题不等于自动获得提交或合并权限：需要由维护者邀请并开通协作者权限。没有权限时，先在 Issue 中联系维护者，确认提交方式；不要假设可以直接从 fork 向仓库发 PR。

有权限后，可以在工作分支或 fork 中开发，向仓库的 `main` 提 PR。参照仓库的 [PR 模板](.github/pull_request_template.md)，写清楚：

- 关联哪个 GitHub Issue；没有 GitHub Issue 时把问题背景写清楚；
- 问题怎么复现、根因是什么（如果是 Bug），改完后用户会看到什么；
- 改了哪些地方，有没有兼容性影响和已知风险；
- 实际运行了哪些检查、结果如何，哪些没跑、为什么没跑。

审核意见来了就按讨论修改并回复。新增代码后，按实际变化重新验证；不要把旧的通过结果当作新代码的结果。

## 5. 谁来审核和合并？

PR 会由项目内部维护者审核；至少需要一位非 PR 作者、属于 [.github/CODEOWNERS](.github/CODEOWNERS) 内部审核名单的维护者批准，外部协作者的批准不能替代内部审核。必要的 CI 要通过，讨论要处理完；审核后如果代码又变了，需要重新审核。最终由内部维护者合并，贡献者不要直接推送到 `main`。

现阶段我们的原则是：欢迎参考外部 Issue 和 PR，也欢迎按上述流程参与贡献；但不把外部贡献者的现成 PR 跳过内部审核直接合并。如需调整提交方式或权限，以维护者的最新通知和仓库实际设置为准。审核与权限配置说明参见 [docs/repository-review.md](docs/repository-review.md)。
