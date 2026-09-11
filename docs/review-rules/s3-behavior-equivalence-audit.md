# S3 重构行为等价性审查报告

- **审查对象**: `refactor(step-harness): S3 move CLI entry to apps/cli + build packages/config` = `b8bf2ee`
- **基线**: `main` = `1cfed08`
- **父提交**: `9a70902`（S2）
- **审查日期**: 2026-09-12
- **审查方式**: 3 个并行深度 agent（入口/退出、step-cli 拆分、非入口搬迁）+ 人工逐行核对关键接缝 + 结构守卫实测 + 入口契约测试跑地面真值

## 结论速览

**用户预期**：结构不变、功能不变、业务逻辑不变。

**审查结论**：S3 是**大规模结构重构，绝大部分行为保持**——但**不是 100% 行为中性**。

| 维度 | 结论 |
|---|---|
| 退出码 | 🟢 **完全保持**。每一条 `process.exit(N)` 都映射到同条件、同数值；无路径被删/改序/改号 |
| stdout 输出 | 🟢 **完全保持**。字节干净通道（--version/--export/print-json）输出一致 |
| sdk-stdio 帧协议 | 🟢 **逐字节等价**。codec `step/stdio.ts` diff 为空，framing 留在 prepareMain 内不进 dispatch |
| 业务逻辑（auth/models/session/config/modes） | 🟢 **完全保持**。真实逻辑一行未动 |
| 进程生命周期 | 🟡 **有变化**（F1/F2，见下）。退出码不变，但短命令从硬退出改为软退出+走 finally |
| 结构 | 🟢 迁移忠实，守卫全绿（entry-freeze / layer-direction / workspace-registry） |

**一句话**：从"退出码/输出/业务逻辑"看，S3 **功能与业务逻辑确实没变**；从"进程生命周期"严格看，有 **2 处有意识的行为变化**（F1/F2）需要明确接受或处理。**没有发现真正的回归（🔴）**。

---

## ✅ 结构等价、行为保持的部分（占绝大多数）

### 1. migrations 搬到 packages/config — 🟢 逐字节等价

- 规范化 diff 后（`node:fs`→`fs` 等），**每个迁移函数体完全相同**。
- **5 步执行顺序不变**（`packages/config/src/migrations.ts:337-341`）：`migrateAuthToAuthJson` → `migrateSessionsFromAgentRoot` → `migrateToolsToBin` → `migrateKeybindingsConfigFile` → `migrateExtensionSystem`。无迁移被增/删/改序。
- `stripBom` 内联可证等价于原 `splitBom(content).text`。
- coding-agent 的 shim 是**忠实转发**，连 `= {}` 默认参数都保留了（`runMigrations(agentDir)` 这类单参测试调用仍正确解析）。
- 生产调用点（`main.ts:991-994` 传 `{agentDir, configDirName}`）与基线一致。

### 2. packages/config 新包 — 🟢 纯宿主

- 6 个文件，仅 1 个含逻辑（`src/migrations.ts`，即搬迁过来的代码）+ 9 行 barrel。
- 唯一运行时依赖是 pinned `chalk@5.6.2`；**不依赖 coding-agent**，无循环。
- 全链路 wiring 一致：deps / build chain（拓扑序 `tui → telemetry → ai → agent-loop → config → coding-agent → apps/cli`，正确）/ tsconfig paths / vitest alias / release list / workspace registry。
- commit message 里 "(b) packages/config 加进 build chain" 的修复是真的（干净 build 之前是坏的）。

### 3. sdk-stdio 帧协议 — 🟢 逐字节等价

- framing codec `packages/coding-agent/src/step/stdio.ts` **diff 为空**。
- `stdio-host.ts` 仅一处 **type-only** import 路径变化（S2 hoist），无运行时影响。
- `writeFrame`（原 `process.stdout.write.bind` ≡ 新 `captureRawStdout()`）、`sdkStdioRequested`（原 `argv.includes("--sdk-stdio")` ≡ 新）、`onExitRequested`（原 `(code)=>process.exit(code)` ≡ 新默认值）全部一致。
- framing 留在 prepareMain 内（`ca-main:1329` 跑 `stdioModeFactory`，返回 `{completed}`），**不进 dispatch switch**。

### 4. dispatch switch 三份拷贝 — 🟢 语义等价

dispatch 逻辑现存三份：基线 `main()`、coding-agent `dispatchAppMode`（`main()` 向后兼容用）、apps/cli `dispatchStepAppMode`。规范化 diff 显示**语义完全相同**：同 rpc/interactive/print 分支、同 17 个 InteractiveMode 选项、同 startup-benchmark 路径；仅 `switch/default` vs `if/else`、`if(exitCode)` vs `if(exitCode!==0)` 的写法差异（对真实退出码等价）。

- `prep.appMode` 逐字使用（不重解析），piped-stdin 的 interactive→print 翻转被正确保留。
- `toPrintOutputMode`/`resolveAppMode`/`parseArgs` 是 coding-agent barrel 的 **re-export**，非重实现。
- **apps/cli 确实绕过了 `main()`**；`main()` 仅为 3 个直接 import 的测试保留硬退出兼容壳。

### 5. bun/restore-sandbox-env 去重 + 测试搬迁 — 🟢 逐字节等价

- `apps/cli/src/bun/restore-sandbox-env.ts` 与旧 coding-agent 副本 diff = IDENTICAL；测试 verbatim 搬迁；`register-bedrock.ts` 逐字节相同。
- bun 入口移到 `apps/cli/src/bun/step-cli.ts`，仅**新增**首行 `import "#bootstrap/environment"`，其余 hook 顺序一致。无悬空 import。

### 6. commands/{auth,models,session,config}.ts — 🟢 等价（但是空骨架）

- 四个文件都是 `return {status:"not-handled"}` 的**非功能占位符**，且**没被 apps/cli/src 任何地方 import**（dead code，预留给未来）。
- 真实 auth/models/session/config 行为未动：shell 顶层 login/logout/feedback/update/config 路由与旧 `step-cli.ts` 逐字节一致，深层执行（`runAuthCommand`/`handleConfigCommand`/`handlePackageCommand`/`listModels`）在 prepareMain 里（baseline `main()` 的忠实抽取）。
- ⚠️ commit message "commands/ (auth/models/session/config) … in apps/cli" **夸大**了——它们是骨架，不是真拆分。

---

## ⚠️ 3 处需要拍板的真实变化

### F1 — 🟡 短命令：硬 `process.exit` → 软 `process.exitCode` + 走 finally

**证据**：
- 旧：`step --version/--help/--export` 在 `main()` 里直接 `process.exit(0/1)`，**跳过** step-cli 的 finally 块。
- 新：返回 `{completed, exitCode}`，apps/cli 做 `if (prep.exitCode) process.exitCode = prep.exitCode`（`main.ts:426`）后**落入 finally**（telemetry `shutdown()` + `flushStderrDevLog` + 记录 `cli_exited`）。

**影响**：退出码、stdout **完全一致**；变的是进程生命周期——短命令现在会跑 telemetry 关闭/刷盘路径。**这正是这次重构的既定目的**（修掉短命令丢 telemetry 的问题，`main.ts:417-423` 有文档）。

**副作用（不一致）**：Category-A 的 fork/session-id/open 校验错误**仍在 prepareMain helper 里硬退出**（`ca-main:445-573`，不在 shell），于是短命令的 telemetry 行为现在**非统一**：一部分走 finally，一部分硬退出跳过 finally。

### F2 — 🟡 package 命令丢了"坏扩展挂不住进程"的硬退出保护

**证据**：旧 `main.ts:855-861` 的注释明说 `process.exit(0)` 是为了**防止已加载扩展的残留 handle 让一次性命令不退出**。新路径 soft 退出后进程自然 drain——若某扩展注册了 timer/handle，`step install/list` 这类命令可能**挂住**而非退出。

**影响**：退出码仍正确，所以不是必然失败，但是一条**被记录在案的安全属性回退**。

**测试覆盖缺口（已核实）**：`apps/cli/test/package-command-paths.test.ts`（31/31 通过）**直接调用 `handlePackageCommand`**，绕过了 shell 的软退出路径，因此验证了退出码逻辑但**没有覆盖 F2**。→ 这是"还有没有漏的"里唯一确凿的未覆盖缺口。

### F3 — 🟢（已排除）telemetry finally 会污染字节干净通道吗？—— 不会

**核查**（此条是唯一"未验证即可能回归"的隐患，已查实）：
- `flushStderrDevLog` 位于 `packages/coding-agent/src/step/stderr-dev-log.ts`，仅 `appendFile` 写**文件**（`:472/:487`），从不写 stdout/stderr 控制台。
- telemetry 包（`packages/telemetry/src`）内 **0 处** `process.stdout` / `console.log` 引用。
- → finally 块的 telemetry/devlog 路径**无法污染** `--export`/`print-json` 的机器可读 stdout。**F3 干净。**

### F5 — 🟢→必要 入口检测补偿：STEP_CLI_ENTRYPOINT 环境变量

**背景**：旧 `isStepEntrypoint()` 靠**文件名**匹配（`step-cli.ts`/`step.js`/`step-bin`）；新入口叫 `main.ts`，**匹配不上**。

**补偿**：`bootstrap/environment.ts:16` 最先设 `process.env.STEP_CLI_ENTRYPOINT ??= "1"`，`config.ts:19` 改成 `isStepEntrypoint() || STEP_CLI_ENTRYPOINT==="1"`。

**影响**：**不是 scope creep，是必须的**——否则 Step 的存储命名空间（agentDir/configDir）会静默回退到 Pi 的 `~/.pi`。对普通 `pi` 启动是 inert 的（从不 import 该模块）。

---

## 🟡 良性遗留项（非回归，建议后续处理）

| # | 项 | 现状 | 风险 |
|---|---|---|---|
| C1 | `apps/cli/dist/main.js` 丢了 `chmod +x` | 该文件带 shebang 且是声明的 `bin.step`，但 apps/cli 是 `private:true` 未 link 进 `node_modules/.bin`，故当前 latent | 未来 link/全局安装时会咬人 |
| C2 | `build-coding-agent-bundle.mjs` 硬编码 `npm` | pnpm monorepo 里用 `npm --prefix` 重编 apps/cli；且新增独立排序依赖（standalone 跑需先 build coding-agent） | 脆弱性，非行为变化 |
| C3 | `local-release.mjs` scope creep | 顺带修了 `packages/contracts`（9a70902 已存在且本就缺） | 仅发布工具，无运行时影响 |

---

## 实测证据

- 结构守卫：`check:coding-agent-entry-freeze` ✅ / `check:layer-direction` ✅ / `check:workspace-registry` ✅（14 members）。
- 入口契约测试：`apps/cli/test/package-command-paths.test.ts` **31/31 通过**（覆盖 `handlePackageCommand` 的退出码逻辑）。
- commit message 自述：`pnpm run check` 绿、`pnpm -r test` = 2960 + apps/cli 3 通过（仅 4 个 documented baseline-red）、干净 build 绿、五通道 5/5、TUI matrix 11/11、`--sdk-stdio` byte-exact、`--version/--help` 不变。

---

## 给用户的决定项

针对"结构/功能/业务逻辑都不变"的铁律：

1. **F1（短命令软退出）**：建议**接受并记档**——这是重构核心目的（短命令不该丢 telemetry）。若要铁律绝对化，需回退成硬退出，但会重新引入 telemetry 丢失。
2. **F2（package 命令挂起保护回退）**：建议**补一个回归测试**兜住——断言"扩展注册 timer 时 package 命令仍能在 N 秒内退出"。这是唯一确凿的未覆盖缺口。
3. **F5（STEP_CLI_ENTRYPOINT）**：必须保留，已在位且正确。
4. **C1–C3**：建议单开 chore 处理，不阻塞。

**净结论**：S3 对"功能/业务逻辑"是**保真**的；对"进程生命周期"有 **2 处有意识、有文档、退出码不变**的行为变化（F1/F2），无 🔴 回归。若接受 F1、补上 F2 测试，即可判定 S3 达成"重构不改行为"的目标。
