# 修复反馈表 130 行之后处理人为徐运放的未关闭问题

## 范围

处理 Step 反馈多维表格（`AX1Qb51O4aiQcfsdZOuc0oten0g` / `tblvrOXl2Jmeigmx` / 视图
`vewcE8pjMH`）中，视图顺序第 130 行及之后、`处理人 = 徐运放`、`状态 != 已关闭` 的
17 条反馈，全部处于 `待分配`。

这些反馈来自已发布的 0.3.1–0.3.4 二进制，而 `packages/coding-agent` 已到 0.84.4，
积累了大量未发版修复。因此第一件事是区分「主干已修、等待发版」与「主干仍存在」，
避免对着已经修好的代码重复改动。

其中 6 条根因已确认，本次直接改代码；4 条主干已修，只做验证；5 条是较早版本的 TUI
问题，必须先在主干复现再决定是否写修复；2 条在拿到上游数据前无法定位，另有 2 条
一半可做、一半受阻。

## 问题清单

| 行 | 问题 ID | 级别 | 标题 | 分类 |
| --- | --- | --- | --- | --- |
| 134 | issue-dc0332266401f973 | P2 | ask 面板覆盖 `/theme` 选择面板 | C |
| 135 | issue-b39a464025061aa5 | P3 | bypass 模式快捷键提示不明显 | A6 |
| 136 | issue-dfa371614a7f8277 | P2 | 长 plan 页面闪屏，方向键切换迟滞 | C |
| 139 | issue-2870fd9014d9db67 | P1 | 输入框随滚动移动，未固定在底部 | C |
| 141 | issue-5946124f7596cd2e | P1 | `step resume <id>` 自身参数冲突 | A1 |
| 155 | issue-6d2efc619ffa072e | P2 | WS 会话长时间使用后输入卡顿 | B |
| 156 | issue-362f529360e59dd8 | P1 | 模型已中断但 UI 仍显示执行中 | D2 |
| 159 | issue-68afaf009dbad6f0 | P2 | tool call 内容重复展示 | C |
| 163 | issue-ad347397b73a811f | P2 | 工具调用密集时 working 动效重复 | C |
| 164 | issue-d59692496ef285c0 | P1 | 未注册的斜杠命令被当作提示词发给模型 | A2 |
| 166 | issue-7a391510d02b6b14 | P1 | 升级后 `unknown option '--session-id'`，随后上游 500/503 | B + D1 |
| 168 | issue-c0eaaf7492c7ace6 | P1 | 安装后 `command not found: step` | B |
| 169 | issue-3b3449394d2f8d5a | P1 | ask 模式运行 20 分钟以上不结束 | D2 |
| 174 | issue-dffd56b7286c08bd | P2 | Markdown 表格对齐标记未生效 | B |
| 175 | issue-dc10183d1aa3dda8 | P2 | 无影云环境无法粘贴图片 | A5 + D3 |
| 178 | issue-d8b499026f19831c | P1 | 非交互模式下权限拒绝静默失败 | A3 |
| 179 | issue-287bfff1a5fe7668 | P1 | 空配置时默认权限被 bypass | A4 |

分类含义：**A** 本次改代码（6 条）、**B** 主干已修仅验证（4 条）、
**C** 先在主干复现（5 条）、**D** 本次无法解决（完整 2 条，另有 2 条部分受阻）。

上表是动工前的初判。C 类五条全部复现完毕后归属有变，**最终结论以下一节为准**。

## 最终状态（按飞书表格行序）

三种状态：

- **本分支修复** — `fix/feedback-130-plus` 上有代码改动、有测试、已验证。
- **main 已修待发版** — 主干上已有修复且本分支复现不出，用户拿到的
  0.3.x 二进制里还没有，发版即可关闭。不产生新代码。
- **未修复** — 本次没有解决。

| 行 | 问题 ID | 标题 | 状态 | 依据 |
| --- | --- | --- | --- | --- |
| 134 | issue-dc0332266401f973 | ask 面板覆盖 `/theme` 选择面板 | main 已修待发版（残留不处理） | 逐秒采样两面板从未同屏，审批框边框完整。残留：进行中的主题选择被静默取消，无提示。**已决策不处理**——默认预设是 Bypass，不弹审批也就不冲突，不值得为此改 `cc5fd1e` 的取消语义。飞书按主症状已修关闭，残留另开记录 |
| 135 | issue-b39a464025061aa5 | bypass 模式快捷键提示不明显 | **本分支修复** | A6。footer 注入 `permissionCycleKey`，渲染 `⏵ Bypass shift+tab`；`footer-width.test.ts` +3 例；tmux 实测 50 列自动省略 |
| 136 | issue-dfa371614a7f8277 | 长 plan 页面闪屏，方向键切换迟滞 | main 已修待发版（有保留） | 静置 2 秒两次截屏逐字节相同；250ms 间隔 8 次上下交替全部生效；7 次连按落点正确。**保留：只测了本机 tmux，未覆盖 SSH+tmux 高延迟链路** |
| 139 | issue-2870fd9014d9db67 | 输入框随滚动移动，未固定在底部 | **设计如此 + 引导**（默认值不改） | 非缺陷而是 `regular` 模式固有行为：输入框写入终端原生 scrollback，滚动由终端接管。`--tui-mode fullscreen` 下实测已是期望行为（PageUp 后正文滚动、输入框固定且可输入）。**已决策保持 `regular` 默认**：alt-screen 退出后会话从终端 scrollback 消失，会改变所有现有用户的复制/搜索习惯，且 fullscreen 仍标记为 experimental、长 plan 重绘问题未查清。改为在 `docs/settings.md` 的 `tuiMode` 下新增「Scrolling and the input box」说明两种模式差异 |
| 141 | issue-5946124f7596cd2e | `step resume <id>` 自身参数冲突 | **本分支修复** | A1。`translateResumeArgs` 改发 `--session <id>`；新增 7 例；真实 CLI 输出 `No session found matching '...'`，exit 1 |
| 155 | issue-6d2efc619ffa072e | WS 会话长时间使用后输入卡顿 | main 已修待发版 | `4d8584c` incremental regular-mode render，在本分支历史中 |
| 156 | issue-362f529360e59dd8 | 模型已中断但 UI 仍显示执行中 | **未修复** | `agent_end` 已统一清理指示器，卡住说明 loop 没结束。无复现、无上游数据无法定位。需要卡住时的会话 JSONL + 上游 trace |
| 159 | issue-68afaf009dbad6f0 | tool call 内容重复展示 | main 已修待发版 · `cc5fd1e` | 见下方「159 / 163 的归因」 |
| 163 | issue-ad347397b73a811f | 工具调用密集时 working 动效重复 | main 已修待发版 · `cc5fd1e` | 与 159 同一根因，见下方「159 / 163 的归因」 |
| 164 | issue-d59692496ef285c0 | 未注册的斜杠命令被当作提示词发给模型 | **本分支修复** | A2。新增 `getUnknownSlashCommandName` 兜底；新增 10 例；tmux 实测 `/hlep` 报错且回填输入框，`/tmp/report.md is the file` 正常放行 |
| 166 | issue-7a391510d02b6b14 | 升级后 `unknown option '--session-id'`，随后上游 500/503 | 前半 main 已修待发版；**后半未修复** | 前半：`normalizeStepSessionSelectorArgs` 兼容 `--session-file`，9 例通过。后半：`code=20002` / `503` 来自推理网关，CLI 侧无解，需服务端定位 |
| 168 | issue-c0eaaf7492c7ace6 | 安装后 `command not found: step` | main 已修待发版 | `7a120e1`、`ddcc89f` 在本分支。隔离 HOME+ZDOTDIR 下跑 `configure_shell_path`：写入守卫块、保留原内容、二次执行不重复 |
| 169 | issue-3b3449394d2f8d5a | ask 模式运行 20 分钟以上不结束 | **未修复** | 同 156，合并为一个根因待查 |
| 174 | issue-dffd56b7286c08bd | Markdown 表格对齐标记未生效 | main 已修待发版 | `e6a71e1` 引入 `padCell`（此前无对齐逻辑）。真实 TUI 端到端验证：`\|:---\|:---:\|---:\|` 渲染出左/中/右对齐 |
| 175 | issue-dc10183d1aa3dda8 | 无影云环境无法粘贴图片 | **未修复**（A5 已撤回） | 曾加过 `describeClipboardImageUnavailable` 做失败诊断，**已全部撤回**。撤回理由见下方「A5 撤回」 |
| 178 | issue-d8b499026f19831c | 非交互模式下权限拒绝静默失败 | **本分支修复** | A3。print-mode 收集带 `terminate` 的阻断调用，写 stderr 并置 exit 1；新增 3 例 |
| 179 | issue-287bfff1a5fe7668 | 空配置时默认权限被 bypass | **本分支修复** | A4。新增 `defaulted` 来源标记，无 UI 且无任何配置时按 Ask 语义决策；新增 8 例覆盖交互/非交互 × 有无配置 |

### 计数

| 状态 | 条数 | 行号 |
| --- | --- | --- |
| 本分支修复 | 5 | 135、141、164、178、179 |
| main 已修待发版 | 8 | 134、136、155、159、163、166（前半）、168、174 |
| 未修复 | 3 | 156、169、175 |
| 设计如此 + 引导 | 1 | 139（默认值不改，补文档） |
| 另有半条无解 | — | 166 后半（上游网关）、134 残留（已决策不处理） |

17 条去重后：本分支动了代码的 5 条，发版即可关闭的 8 条，
按设计如此关闭并补引导的 1 条，真正没解决的 3 条（156/169 同一根因待查，175 见下）。

### A5 撤回（ROW 175）

原本加了 `describeClipboardImageUnavailable`：在图片和文本都没取到时，按平台判断是
`DISPLAY` 未设、缺 `xclip`/`wl-paste`、还是剪贴板确实没图，并把结论显示出来。

**已撤回，因为它的前提不成立。** 反馈方明确写了「无影云环境下 Codex 粘贴正常」。
既然同一环境里另一个 CLI 能粘，就说明剪贴板机制本身是通的，`DISPLAY`、`xclip` 这些大概率
都在。那个诊断函数只会给出「xclip is not installed」之类与事实相反的结论，把排查引向错误
方向——比原来的静默失败更糟。

真正的问题是 Step 读剪贴板的方式与该环境不匹配，而不是环境缺少机制。要修就得先搞清
Codex 在那里走的是哪条路径（终端级 bracketed paste？OSC？落盘后传路径？），这需要无影云
环境实测，本次无法进行。

撤回范围：`utils/clipboard-image.ts` 还原到 HEAD，`handleClipboardPaste` 恢复原有的
静默 catch，删除 `test/clipboard-image-unavailable.test.ts`。已验证无残留。

### 159 / 163 的归因（看过反馈截图后重做）

**先记一次返工。** 这两条最初判为「未复现」，依据是一轮 12 个并发 `write_file` 各只渲染一次。
那次测试**无效**：`write_file` 的参数是短单行，根本没触碰到触发条件。163 尤其危险——
当时看到峰值 11 个 spinner 行，我认定「一个在飞调用一行属于正常」，而那很可能就是反馈方
所说的「重复」本身。在没看截图的情况下把可能是症状的现象判成设计正常，结论不成立。

**截图显示的真实症状。** 两条是同一个根因：

- 159：`run_command(cd stepfun-docs-site && glab mr update 3 --description "$(cat <<'EOF'`
  被重复打印十余遍，每遍左侧是不同 spinner 帧，中间夹着逐渐损坏的正文
  （`changednged`、`changedined`、`ace.`）。
- 163：`run_command(python3 - <<'PY'` 同样重复打印，另有两行完全相同的
  `Working... (20s · ↓ 823 tokens)`（反馈方用红箭头标出）。

共同点是**工具参数为多行 heredoc**，且命令执行时间长到让 spinner 反复 tick。

**修复点：`cc5fd1e`**（`fix(coding-agent): stabilize approval dialogs and tool rows`）。
它改写了 `components/tool-execution.ts` 的 `clampStepLine`：

```diff
-	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "", false);
+	// One array entry must remain one physical terminal line, or spinner
+	// redraws corrupt cursor accounting.
+	const singleLine = replaceTabs(line).replace(/[\r\n]+/gu, " ");
```

改前一个数组条目可能跨多个物理行，spinner 重绘的光标计算随之错位，于是整行被反复重打、
正文被覆盖污染，Working 行也留下重影——与两张截图一致。

**按正确触发条件重测（当前主干）**：让模型用 `python3 - <<'PY'` 跑一个含 sleep 的多行
heredoc，全程约 16 秒、spinner 持续动画。结果：整个 scrollback 中两次 `run_command` 调用
各渲染 1 次，多行参数被压成单行，无重复行、无文本损坏、无重复 Working 行。

### 基线变更与 config.toml 影响复核

**分支基线被并发会话改了。** `fix/feedback-130-plus` 建立时基于 `main`（`ac2b7b8`），
但 reflog 显示随后有一次 `merge feat/unified-step-config-mcp: Fast-forward`，把分支推到了
`e262dce`，比 main 多出 5 个提交（含 `0aa660b` 统一 Step 配置到 config.toml）。
这次合并不是本任务执行的；同一 cwd 下的其他会话也把工作区文件 staged 了。
结论：**本次改动实际叠加在 config.toml 统一之上，不是在纯 main 上。**

**config.toml 对 178/179 的影响：存储位置变了，判定逻辑没变。**
`0aa660b` 把 Step 设置从 `step-settings.json` 换成 `config.toml`
（`global` 落在 `dirname(agentDir)/config.toml`），`permissionPreset` 等字段形状不变，
`resolvePermissionOptions` 的优先级链也不变。关键风险是「是否会自动写入默认 preset」——
若会，A4 的 `defaulted` 将永远为假、修复静默失效。核查结果：`config-toml.ts` 只为
provider/model/telemetry 合成默认值，不涉及权限；用户真实 config.toml 中也无权限键。

**端到端复验（隔离 `STEP_CODING_AGENT_DIR`，非交互 `--print`）：**

| 配置 | 结果 |
| --- | --- |
| config.toml 无权限键 | 拒绝执行 `rm`，文件保留；stderr 输出 `Blocked run_command: …(no interactive approval is available and no permission preset is configured)`；exit 1 |
| config.toml 写入 `permissionPreset = "bypass"` | 正常删除文件，stdout `DONE`，exit 0，stderr 为空 |

两个方向都符合预期：A4 的失败关闭与 A3 的原因上报在 config.toml 基线上均生效，
显式配置仍然优先。

### 已确认的决策

- **ROW 134 残留**：不处理。理由见上表。
- **ROW 139 默认值**：保持 `regular`，只补文档引导。理由见上表。
- **CHANGELOG**：不写，遵循 `AGENTS.md` 的非 main 分支规则。

## 已确认的根因

- **A1 / 141 行。** `packages/coding-agent/src/step/command-compat.ts:279-289` 把
  `step resume abc123` 翻译成 `["--resume", "--session-id", "abc123"]`，而
  `packages/coding-agent/src/main.ts:447-459` 恰好禁止这个组合。
  `--session <path|id>`（`src/cli/args.ts:196,406`）的语义本就是「打开这个已有会话」，
  `main.ts:520-556` 已实现 local / global / not_found 三个分支。
- **A2 / 164 行。** 提交处理函数（`src/modes/interactive/interactive-mode.ts:3492-3692`）
  是一串硬编码的 `text === "/xxx"` 比较，末尾没有兜底判断，因此未命中的 `/help` 会落入
  普通消息提交，原样发给模型。命令名集合其实已经在
  `interactive-mode.ts:959` 组装成 `combinedCommands`，但用完即丢。
- **A3 / 178 行。** `src/step/permissions.ts:428-441` 确实返回了
  `{ block: true, terminate: true, reason }`，但 `src/modes/print-mode.ts:141-157`
  只打印最后一条 assistant 消息的文本内容。拦截原因只进了模型可见的工具结果，
  从未写到 stdout 或 stderr。
- **A4 / 179 行。** `src/step/permissions.ts:238-245` 的兜底不区分交互性，一律返回
  `bypass`。这是 commit `1f0d78a` 的有意决策，因此本次改动只收敛非交互场景。
  可信项目配置已经由 `src/extensions/step.ts:326-360` 在 CLI flag 与 `STEP_*` env
  之下读取，缺口仅在「什么都没配」时的兜底取值。
- **A5 / 175 行。** `src/utils/clipboard-image.ts:254-297` 读取的是运行 Step 那台机器的
  剪贴板（`wl-paste` / `xclip` / native）。`interactive-mode.ts:3461-3483` 的
  `handleClipboardPaste()` 用裸 `catch {}` 吞掉全部异常，读取返回 null 时也不给任何反馈。
- **A6 / 135 行。** Shift+Tab 绑定在 `src/core/keybindings.ts:104-105`，并在
  `interactive-mode.ts:3396-3404` 改派给 `/permissions --cycle`。Step footer
  （`src/modes/interactive/components/footer.ts:305-341`）只渲染当前模式，
  从未提示这个快捷键。

## 执行计划

| 步骤 | 工具 / 路径 | 预期结果 | 回滚方式 |
| --- | --- | --- | --- |
| 1 | 从 `main` 切出 `fix/feedback-130-plus` | 新分支工作区干净，不触碰其他会话的文件 | 删除分支，不暂存任何文件 |
| 2 | 用 tmux 在主干复现 C 类（`./pi-test.sh`，120x40） | 134/136/139/159/163 各自记录为「已复现」或「未复现」，并写下实际观察到的行为 | 关闭 tmux 会话，不落盘 |
| 3 | A1：修改 `src/step/command-compat.ts` 的 `translateResumeArgs` | `step resume` → `["--resume"]`；`step resume <id>` → `["--session", "<id>"]` | 只回滚该函数 |
| 4 | A2：在 `createBaseAutocompleteProvider` 中缓存命令名集合，在 `onSubmit` 落入普通提交前加未注册斜杠命令兜底 | `/help` 给出「命令未注册」提示且不产生任何模型请求；`!`/bash、compaction 队列、steering 三个分支顺序不变 | 回滚兜底判断与新增字段 |
| 5 | A3：在 `src/modes/print-mode.ts` 收集被阻断的工具调用，把每条原因写入 stderr，并置非 0 退出码 | `--print` 下被拒绝的调用打印出原因并以非 0 退出；JSON 模式不变 | 回滚 print-mode 改动 |
| 6 | A4：给权限解析结果加来源标记；在 `StepPermissionController.handleToolCall` 的 `!context.hasUI` 分支把「兜底得来的 bypass」按拒绝处理 | 交互模式仍默认 Bypass；非交互且无 CLI flag、无 `STEP_*` env、无持久化 preset 时失败关闭并给出可读原因；显式配置与项目配置优先级不变 | 回滚来源标记与该分支 |
| 7 | A5：把 `handleClipboardPaste` 的静默 `catch {}` 换成具体诊断 | 粘贴失败时明确说明原因：无 `DISPLAY`、缺少 `xclip`/`wl-paste`、剪贴板无图片、或格式转换失败 | 恢复原有 catch |
| 8 | A6：在 `renderStepPresentation` 的模式段之后按宽度追加 `shift+tab` 提示，键名从 keybindings 读取 | 宽度 ≥ 60 时出现提示，窄终端自动省略；不出现硬编码按键字面量 | 回滚该 footer 段 |
| 9 | 测试：`packages/coding-agent/test/` 与 `test/suite/`（faux provider） | 新用例覆盖 A1 的 argv 翻译、A2 的不下发、A3 的 stderr 与退出码、A4 的四种交互性/配置组合 | 修实现，不弱化断言 |
| 10 | 验证 B 类，不改代码 | 174/168/166 前半/155 确认在主干已修，各自对应到具体 commit | 若仍能复现则移入 A 类 |
| 11 | `npm run check`（全量输出），随后 `./test.sh` | 无 error/warning/info；非 e2e 套件通过，或仅在既有的 `sqlite-node` FTS5 问题上失败 | 修完再继续 |
| 12 | 对 A2、A5、A6 与 B 类做 tmux 端到端验证 | 实际表现与各条反馈的期望结果一致 | 打回对应步骤 |
| 13 | 更新 `CHANGELOG.md` 的 `[Unreleased]`、`packages/coding-agent/CHANGELOG.md`；A4 另需同步 `docs/step-configuration.md` 与 `packages/coding-agent/docs/step-integration.md` | 追加到已有小节，不改动已发布版本小节 | 回滚文档改动 |
| 14 | 回写多维表格 | A 类改为处理中，B 类改为待验证并注明 commit，D 类补充说明 | 外部写操作：执行前必须单独确认 |

## 验收标准

- `step resume <id>` 要么打开会话，要么提示会话不存在，绝不再报参数冲突。
- 未注册的斜杠命令给出提示，且不产生任何模型请求。
- 无 UI 时被拒绝的工具调用会打印原因，并以非 0 退出码结束。
- 无 CLI flag、无 `STEP_*` env、无持久化 preset 时，非交互运行拒绝写入/执行类调用；
  交互运行仍默认 Bypass；显式配置与可信项目配置继续优先。
- 图片粘贴失败时能说清卡在哪一步。
- footer 提示出权限循环快捷键，且不硬编码按键。
- C 类每一条最终都落到「已复现，并给出修复方案」或「未复现，已由 <commit> 修复」。
  未复现的条目不写修复。

## 不在本次范围

- **D1，166 行后半。** `500 Upstream service unavailable code=20002`、
  `503 (no body)`、`Retry failed after 3 attempts` 来自推理网关。客户端侧的重试与
  不完整流恢复已经落地（`df9f04c`、`2026-09-11-step-sse-recovery.md`）。
  编写本计划期间，三个探索子任务同时被同一错误打断，说明网关问题当前仍在。
  需服务端定位。
- **D2，156 与 169 行。** `agent_end` 已统一清理 working 指示器与 spinner
  （`interactive-mode.ts:3959-3978`），所以 UI 卡在「执行中」只能说明循环根本没结束：
  要么在重试，要么卡在 `DEFAULT_HTTP_IDLE_TIMEOUT_MS` 的 5 分钟窗口里等一条已死的流。
  `packages/agent/src/agent-loop.ts` 既无墙钟上限也无循环检测。
  缩短空闲超时或加整轮上限属于缓解而非修复，还会误伤正常的长耗时任务。
  需要一份卡住时的会话 JSONL 与对应上游 trace 才能继续。
- **D3，175 行的根治。** 无影云是否把客户端剪贴板同步进远端 X11 selection、
  远端 shell 有没有 `DISPLAY`、是否安装了 `xclip`/`wl-paste`，没有该环境既无法判断
  也无法验证任何修复。本次只交付第 7 步的诊断改进。
- 新增 `/help` 命令。反馈只要求未注册命令不要发给模型。

## 需要确认的事项

第 14 步会写入外部系统（反馈多维表格），执行前需单独征求确认。

## 执行记录（2026-09-15）

分支 `fix/feedback-130-plus`，基线 `ac2b7b8`。

### 已完成的代码改动

| 项 | 改动 | 验证 |
| --- | --- | --- |
| A1 | `step/command-compat.ts` `translateResumeArgs` 改为 `--session <id>` / 裸 `--resume` | 新增 `test/step-resume-command-compat.test.ts`（7 例）；真实 CLI `step resume nonexistent-session-xyz` → `No session found matching 'nonexistent-session-xyz'`，exit 1 |
| A2 | `interactive-mode.ts` 新增 `knownSlashCommandNames` 与 `getUnknownSlashCommandName`，在普通提交前拦截未注册斜杠命令并回填输入框 | 新增 `test/interactive-mode-unknown-slash-command.test.ts`（10 例）；tmux 实测 `/hlep` 报错且文本保留，`/tmp/report.md is the file` 正常放行 |
| A3 | `print-mode.ts` 收集带 `terminate` 的阻断调用，写 stderr 并置 exit 1 | `test/print-mode.test.ts` 新增 3 例，共 6 例通过 |
| A4 | `permissions.ts` 加 `defaulted` 来源标记；无 UI 且 `defaulted` 时按 Ask 语义决策 | `test/step-permissions.test.ts` 新增 8 例，共 20 例通过 |
| A5 | ~~`clipboard-image.ts` 新增诊断函数~~ **已撤回**，见「A5 撤回（ROW 175）」 | — |
| A6 | footer 通过注入的 `permissionCycleKey` 渲染快捷键提示 | `test/footer-width.test.ts` 新增 3 例，共 16 例；tmux 实测 `⏵ Bypass shift+tab`，50 列自动省略，Shift+Tab 仍可循环到 Autopilot |

**A4 实现修正**：最初只改了 `handleToolCall` 的 `!hasUI` 分支，但 bypass 下
`decideStepToolCall` 在更早的分支就返回 `allow` 并短路，改动不生效。改为在无 UI 且
`defaulted` 时用降级后的 state（`mode: "confirm"`、`nonInteractiveApproval: "deny"`）
做决策。

**A6 实现修正**：footer 一开始直接读 `session.extensionRunner`，导致 4 个既有 footer
测试因假 session 缺该字段而崩。改为由 `InteractiveMode` 注入 `permissionCycleKey`
getter，footer 保持纯展示。

连带修复 `test/interactive-mode-startup-input.test.ts` 的假 `this`：补上
`knownSlashCommandNames` / `getUnknownSlashCommandName` / `showError`。

### B 类验证结果（未改代码）

- **ROW 174 表格对齐**：`e6a71e1` 在本分支。直接驱动 `Markdown` 组件渲染
  `:--` / `:-:` / `--:`，三列分别左/中/右对齐，符合期望。
- **ROW 168 安装后找不到 step**：`7a120e1`、`ddcc89f` 在本分支。在隔离 HOME +
  ZDOTDIR 下跑 `configure_shell_path`，写入守卫块、保留原有内容、二次执行不重复
  （marker 数保持 1）。
- **ROW 166 前半 `--session-id` 报错**：`test/step-session-file-compat.test.ts` 9 例通过。
- **ROW 155 长会话输入卡顿**：`4d8584c` 在本分支。

### C 类复现结果（已登录后补测）

- **ROW 139 输入框随滚动移动**：已定性。默认 `tuiMode: "regular"` 走 `TuiMainScreen`，
  写入终端原生 scrollback，输入框必然随滚动移动，这是该模式的固有行为而非缺陷。
  `--tui-mode fullscreen` 走 `TuiAltScreen`：tmux 实测 `!seq 1 60` 后按 PageUp，
  transcript 滚到 49–54 行，输入框仍固定在底部且可继续输入 —— 正是反馈的期望结果。
  待定：改默认值，还是在文档/首启提示里引导切 fullscreen。
- **ROW 134 ask 面板覆盖 /theme**：覆盖症状未复现。在 Ask 模式下于 streaming 中打开
  `/theme`，逐秒采样：t=6 主题面板在、审批面板不在；t=7 主题面板消失、审批面板出现，
  两者从未同屏，审批对话框边框完整无错位。
  残留问题：用户正在进行的主题选择被静默取消，没有任何说明。反馈方要求的
  「任务执行中禁止 /theme」属于产品决策，待定。
- **ROW 136 长 plan 页闪屏 + 方向键迟滞**：未复现。长 plan 审阅页下静置 2 秒两次截屏
  逐字节相同（无重绘漂移）；方向键 250ms 间隔 8 次上下交替，每次都正确翻转选项；
  7 次无间隔连按后落点正确，无丢键或合并。
  **注意：本次是本机 tmux，不是 SSH+tmux**，高延迟链路未覆盖。
- **ROW 159 tool call 重复展示**：未复现。一轮 12 个并发 write_file，scrollback 里
  每个调用各出现 1 次。
- **ROW 163 working 动效重复**：未复现。同一轮峰值 11 个 spinner 行，对应 11 个在飞
  调用，各一行，随后全部正常收敛为 `●`。
- **附带**：ROW 174 在真实 TUI 里端到端验证。`|:---|:---:|---:|` 三列渲染为
  `LeftCol` 左对齐、`CenterCol` 居中、`RightCol` 右对齐，数据行同样。

结论：134/136/159/163 四条的原始症状在当前主干均不复现，归入 B 类（已修待发版）；
仅 ROW 134 留下「主题选择被静默取消」这一残留项待产品决策。**未据此改动任何代码。**

### 全量验证

- `npm run check`：exit 0，无 error/warning/info。
- `./test.sh`：exit 0，全部套件通过（含 `sqlite-node` 11 个文件 87 例）。

### 意外操作与处置

安装器 PATH 测试第一次用假 `HOME` 运行，但本机 `ZDOTDIR` 指向真实 home，
`profile_targets` 取 `${ZDOTDIR:-$HOME}/.zshrc`，导致真实 `~/.zshrc` 的 step-cli 块
被替换成指向 `/tmp` 的假路径。已立即还原为原内容
（`export PATH="$HOME/.step-cli/bin:$PATH"`），`zsh -n` 校验通过，
备份留在 `/tmp/step-repro/zshrc.before-fix`。副作用：该块从原第 144 行移到文件末尾，
对 PATH 前插语义无影响。重跑测试时已同时隔离 `ZDOTDIR`。

### 未完成

- CHANGELOG 不写：已确认按 `AGENTS.md`「不要在非 main 分支或 PR 上创建 changelog 条目」
  执行，计划第 8 步的 CHANGELOG 部分作废；`step-integration.md` 的契约文档已更新。
- 未提交：`AGENTS.md` 写明「除非用户要求，否则不要提交」。
- 第 9 步回写多维表格未执行，等待确认。
