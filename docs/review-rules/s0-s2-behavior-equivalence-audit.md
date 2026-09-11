# S0–S2 重构行为等价性审查报告

- **审查对象**: S0 + S1(A/B/C/D/R) + S2 共 6 个 commit
  - `9ff0bf6` S0 scaffold + S1-A remove remote CBOR
  - `39a6287` S1-B remove SQLite session backend
  - `135ae6d` S1-C remove pi command
  - `b9497e5` S1-D migrate npm workspaces → pnpm
  - `f3de981` S1-R rename packages/agent → packages/agent-loop
  - `9a70902` S2 hoist theme/render + build contracts
- **基线**: `main` = `1cfed08`
- **审查日期**: 2026-09-12
- **审查方式**: 3 个并行深度 agent + 人工逐项核实关键点 + 全 commit `tsgo` 错误集 A/B diff + 保留功能地面真值测试

## 与 S3 的审查标准差异

S0–S2 **混有有意的功能移除**(CBOR / SQLite / pi 命令)+ **包管理器迁移** + **纯 hoist**。因此审查标准分两类:
- **被移除的功能**:只查是否删干净、有无悬空引用拖垮构建、保留代码有无被殃及。
- **保留的代码**:查行为是否等价。

## 结论速览

**S0–S2 整体是行为保持的**——保留代码逐字节等价,must-keep 功能全部在且经验证,无新增类型错误。但有 **1 个仍存在于 HEAD 的真 bug**(S1-C 的 `test/rpc.test.ts` 悬空路径)、**1 个 S1-C 提交时引入但 HEAD 已修的隔离性回退**、以及若干良性遗留(dead script / 文档残留,多为 S7 已记档)。

| Commit | 新类型错误 | 保留代码悬空引用 | 保留代码行为变化 | 备注 |
|---|---|---|---|---|
| S0+S1-A `9ff0bf6` | 0 | 0 | 无 | S0 弄坏 `npm run clean`(HEAD 已修) |
| S1-B `39a6287` | 0 | 0 | 无 | 最干净的一个 |
| S1-C `135ae6d` | 0 | **1**(`test/rpc.test.ts:21`,HEAD 仍在) | `RpcClient` 公开默认值 | 4 测试丢隔离(HEAD 已修) |
| S1-D `b9497e5` | 0 | 0 | 无(protobufjs 是假警报) | dead script 残留 |
| S1-R `f3de981` | 0 | 0 | 无 | 教科书式重命名 |
| S2 `9a70902` | 0 | 0 | 无(runtime) | 4 个 stale 测试(S3 全catch) |

**地面真值实测**:4 道结构守卫(layer-direction / tui-no-ai / workspace-registry / ts-imports)全绿;`check:ts-imports`(S2 的 ~130 路径重算后置网)通过;JSONL/memory session 套件 6 文件 / 119 测试通过(SQLite 删除后的保留后端);package-command 契约 31/31 通过。

---

## 逐 commit 详述

### S0 + S1-A(`9ff0bf6`)删除 remote CBOR — 🟢 删除干净,🟡 S0 非纯追加

**删除干净(agent 用 `tsgo` 错误集 A/B diff 证明零新增错误)**:
- `git grep` 全树对已删的 `pi-client/protocol/server` 包名与路径**零命中**,无悬空引用(含动态 `await import`)。
- coding-agent/src 改动面恰好 3 个文件(`src/client/{index,remote-session,transcript}.ts` 删除),别无其他。
- 6 个 root tsconfig alias + coding-agent/vitest alias + `build:binary` cd-chain + local-release manifest + bundle entry 全部一致清理。

**Must-keep 全部在且逐字节等价**(`1cfed08` vs `135ae6d` 比对,并功能验证):

| Must-keep | 状态 |
|---|---|
| `--mode rpc`(`modes/rpc/*`) | 逐字节相同;实测发 NDJSON RPC 事件 |
| `--sdk-stdio`(`step/stdio.ts`) | 逐字节相同;实测发 length-prefixed `step-agent-sdk` v1 帧 |
| `server/create-harness.ts` | 逐字节相同(注意:是 `coding-agent/src/server/create-harness.ts`,**不同于**被删的 `packages/server/`) |
| `STEP_PROTOCOL_VERSION`/`SDK_STDIO_PROTOCOL_VERSION` | `step/stdio.ts:16,22`,值 `1`,逐字节相同 |
| `isRemoteSession` | `utils/clipboard.ts:22`,纯 env 检测,与 CBOR client 无耦合 |

**保留代码行为**:`main.ts`/`modes/rpc/*`/`step/stdio*.ts`/`create-harness.ts` 从 `1cfed08` 到 `135ae6d` **全部逐字节相同**。无 session-backend/transport 注册表带默认值会被静默改变。agent-loop 套件 424 passed / 1 skipped,四个 commit 一致。

**🟡 S0 非纯追加——弄坏 root `npm run clean`**:root `clean` 是 `npm run clean --workspaces`(**无** `--if-present`),而 S0 的 `apps/cli` 当时没定义 `clean` → `9ff0bf6` 起 `npm run clean` exit 1。**HEAD 已修**(`apps/cli/package.json:18` 现有 `"clean": "shx rm -rf dist"`,我核实过)。

**🟡 `check:browser-smoke` 覆盖面缩小**: dropped `typeof PiClient`/`PROTOCOL_VERSION`/`decodeCbor(encodeCbor(...))`——不可避免(符号没了),但浏览器侧 Node-only import 的守卫变弱。

---

### S1-B(`39a6287`)删除 SQLite session backend — 🟢 最干净

- "zero-referenced" 经对抗性核查成立:删除前全树 case-insensitive `sqlite`/`session-backend` grep 只剩自引用 + 5 处注册。
- 5 处注册全部清干净(root build/build:offline cd-chain、tsconfig alias+2 include、biome 2 include、local-release manifest、两处 workspace glob + registry row 13→12)。`packages/session-backends/` **整目录消失**。
- 保留代码:`packages/agent/src/harness/session/index.ts` 只导出 context/jsonl/memory/session/types——**无 backend 注册表、无 `storageKind` 默认值会被静默改变**。JSONL/memory conformance harness 通用且未动。套件 424 passed,删前删后一致。
- 唯一残留是文档(`AGENTS.md`/`agent/README.md`/`docs/*.md`),commit 明确记档 deferred to S7——**已承认,非殃及**。

---

### S1-C(`135ae6d`)删除 pi 命令 — 🟢 架构干净,🔴 留 1 个 HEAD 仍在的 bug,🟡 隔离性回退(HEAD 已修)

**删除干净**:
- 无悬空相对 import(唯一动态 import 被删 `../cli.ts` 的 `src/bun/cli.ts` 同 commit 删除)。bundler `entryNames:"[name]"` + `entryPoints:{step:dist/step-cli.js}` 确实产出 `dist/bundle/step.js`,与 `bin.step` 一致。
- 被删的 `.github/workflows/build-binaries.yml` **确属 pi-only**(tag 触发 `pi-v*`,发 `pi-*` 资产)。
- **`rpc-entry.ts` 之谜**:S1-A 列为 must-keep、S1-C 删除它——它们是**同一个文件**(`coding-agent/src/rpc-entry.ts`,13 行 pi-RPC launcher)。删除它**没殃及任何东西**(唯一消费者是 `exports["./rpc-entry"]` + bundler entry,都已 drop);也**没殃及** `create-harness.ts`(后者在 `1cfed08` 就已是 test-only,逐字节不变,是既存 dead code)。
- `--sdk-stdio` 在 `39a6287` 就**已**是 step-entry-only(`main.ts` gate on `stdioModeFactory`,仅 step-cli 提供)——删 pi 入口**没移除任何可达能力**。

**🔴 仍存在于 HEAD 的 bug — `packages/coding-agent/test/rpc.test.ts:21`**:
```ts
cliPath: join(__dirname, "..", "dist", "cli.js"),   // dist/cli.js 已不存在
env: { PI_CODING_AGENT_DIR: sessionDir },            // 应为 STEP_CODING_AGENT_DIR
```
- **我核实过 HEAD 仍在**:`ls dist/cli.js` → No such file;测试仍用 `PI_CODING_AGENT_DIR`。
- 被两重掩盖:整个 `describe` 是 `skipIf(!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)`,且 coding-agent vitest 无 `exclude`。**有凭证的机器上这套会 spawn 不存在的路径**。且单纯改路径不够——line 23 传 `PI_CODING_AGENT_DIR`、lines 61/104 断言 `join(sessionDir,"sessions")`,而 step entry 忽略它(见下)。
- **这是 S0–S2 批次里唯一需要动手修的真 bug。**

**🟡 S1-C 提交时:4 个重定向测试丢 agent-dir 隔离(HEAD 已修)**:
- 根因:`ENV_AGENT_DIR` 在 vitest 父进程是 `PI_CODING_AGENT_DIR`(APP_NAME=pi),在 step 子进程是 `STEP_CODING_AGENT_DIR`;且 `applyStepEnvironment()` 从 HOME 重算目录后**clobber 两者**。于是 `env:{[ENV_AGENT_DIR]:agentDir}` 在 4 个测试里成了死配管。
- A/B 证明:同样假 HOME,`39a6287`(src/cli.ts)跑完 HOME **全空**(隔离有效);`135ae6d`(src/step-cli.ts)跑完 HOME 有 `.step-cli/agent/{auth.json,...}` + telemetry spool + dev-log。→ 4 测试读写开发者真实 `~/.step-cli`。
- 后果:`session-id-readonly.test.ts:110` 的负断言一度** vacuous**(child 从不写测试临时目录)。
- **HEAD 已修**:`session-id-readonly.test.ts` 现在同时设 `ENV_AGENT_DIR` 和 `STEP_CODING_AGENT_DIR`(我核实过 lines 61/65)。隔离性已恢复。

**🟡 `RpcClient` 公开默认值改变**:`modes/rpc/rpc-client.ts:81` `"dist/cli.js"` → `"dist/bundle/step.js"`。**必要**(旧路径没了)且新值正确(匹配 bin.step),但 `RpcClient` 是从 `src/index.ts:430` 导出的公开 API——`new RpcClient({})` 现在拿到 Step 产品门面(`.step-cli` 存储、Step-only provider 白名单、Step telemetry/模型默认)而非裸 pi CLI。无测试覆盖默认值(3 处调用都显式传 cliPath)。

**🟡 未记档文档残留**:commit 的 deferral 列表含 `auto-pi.sh`/`profile`/`docs/rpc.md`,但**漏了** `README.md:61`(`./pi-test.sh`,本 commit 删的)和 `AGENTS.md:197-202`(tmux recipe 跑 `./pi-test.sh`)。`scripts/auto-pi.sh` + `profile-coding-agent-node.mjs` 多处指向 `dist/cli.js`(含 line 590 硬 guard 会 throw)——这些是**已承认 deferred** 的 dev-helper,`npm run profile:tui/rpc` 从本 commit 起坏。

---

### S1-D(`b9497e5`)npm → pnpm 迁移 — 🟢 无行为变化(protobufjs 是假警报)

**🔴→🟢 protobufjs "7.6.6→7.6.5 降版" 是 commit message 的错误陈述,无版本变化**:
- 我亲自 diff:main `1cfed08:package.json` 的 `overrides.protobufjs` **本来就是 7.6.5**;pnpm commit 只是把它从 `overrides` 挪到 `pnpm.overrides`,**值一模一样**。
- 两个 lockfile 都证明有效版本是 7.6.5(旧 npm lock `7.6.5.tgz`,新 pnpm lock `protobufjs@7.6.5`)。commit message 说"was silently 7.6.6"**与 lockfile 事实不符**。
- protobufjs 经 `@google/genai`(packages/ai 的 runtime dep)进运行时树,但版本没变 → **protobuf 序列化行为无变化**。`packages/*/src` 无 protobufjs 运行时 import。
- 唯一真实传递漂移:`@protobufjs/utf8` 1.1.1→1.1.2(patch,字节长度工具,语义等价),低风险。

**pnpm strict-layout 修复全部正确且必要**:
- **photon wasm**:旧 `build-binaries.sh:306` 硬编码 `cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`(扁平 hoist 路径,pnpm 严格布局下必断);新 `copy-photon-wasm.mjs` 用 `createRequire` 从 cwd=coding-agent 解析(同文件名同目的地)。✅
- **bundle `resolveDir→aiDir`**:`HttpsProxyAgent` shim 需 `https-proxy-agent@7.0.6`,是 packages/ai 的 dep,pnpm 下不 hoist 到 root → `resolveDir:repoRoot` 会失败,`aiDir` 是正确修。✅
- **phantom devDep**:`@smithy/types@4.18.0`(packages/ai,仅 `import type`,编译期擦除)+ `yaml@2.9.0`(root,仅测试用)——**确是 dev-only**,零运行时足迹。✅
- **workspace linking**:`.npmrc` `link-workspace-packages`+`prefer-workspace-packages`;lock 显示 8 个 workspace 内部跨包依赖全是 `link:`,无一从 registry 拉。`pi-agent-core` 是 private,没这俩 flag pnpm 根本解析不了——**是 load-bearing 不是装饰**。✅
- **CI**:5 workflow + `.gitlab-ci.yml` → `pnpm install --frozen-lockfile` + corepack;无残留 `npm ci`。lockfile guard 改守 `pnpm-lock.yaml`,`PI_ALLOW_LOCKFILE_CHANGE` 逃生舱保留。✅

**🟡 良性遗留(dev/release 工作流,不影响发布二进制)**:
- 少了 2 道依赖漂移 CI gate(`check:shrinkwrap`/`check:install-lock:coding-agent`)——可辩(coding-agent 是 private,bun bundle,从不 `npm pack`),但依赖漂移守卫没了。
- orphaned cruft:`coding-agent/package.json:27` 的 `files` 仍列已删的 `npm-shrinkwrap.json`;`generate-coding-agent-shrinkwrap.mjs`/`install-lock.mjs` 仍在但没接任何 script(dead code);`sync-versions.js:12` 仍 filter `install-lock`(仅防御性 `.filter()`,不 hard-fail)。

---

### S1-R(`f3de981`)packages/agent → packages/agent-loop — 🟢 教科书式

- **包名不变**(`@earendil-works/pi-agent-core`)→ import 按包名解析,**0 处 import 需改**。~91 文件 100% similarity 纯重命名。
- 8 处路径配置全部正确重指 agent-loop:root tsconfig paths、vitest.base.ts、coding-agent tsconfig.build(`../agent-loop/dist`)、root build cd-chain、profile-coding-agent-node.mjs、local-release.mjs、workspace-registry dir、被移包的 vitest.harness 自引用。
- pnpm-lock importer key 重生成 `packages/agent-loop:`(`--frozen-lockfile` 继续通过的必要)。
- **无残留构建/配置路径引用**:CI/scripts/configs 扫 `packages/agent`(排除 `-loop`/`-old`)为空。剩余 `packages/agent/` 提及只是注释/changelog fixture 字符串/录制对话数据(S7 deferred,不挡构建)。
- 🟡 既存(非本 commit 引入):`tsconfig.json:27` 映射 `pi-agent-old` → 不存在的 `./packages/agent-old`(baseline `1cfed08` 就有,无害,仅当 import 该 specifier 才生效)。

---

### S2(`9a70902`)hoist theme/render + build contracts — 🟢 runtime 行为保持,🔴 提交时 4 个 stale 测试(S3 全 catch)

**Part 1 hoist(agent 程序化解析全部 2199 个相对 import,零悬空)**:
- 12 个文件全部 clean git rename:8 theme(5 json + theme-schema + theme-controller + theme.ts)+ 4 render  helper。新位置在、旧位置没、零重复零删除。132 个 theme importer 行,匹配 "~130"。
- 非机械编辑全是纯 import 重指、符号集不变、深度数学正确(index.ts / main.ts / interactive-mode.ts / components barrel)。
- **getThemesDir 双分支**:non-bun 分支 → `src/theme`,bun 分支不动(`<exeDir>/theme`,由 `build-binaries.sh:297` 读 `dist/theme/*.json` 喂)。flat-bun vs nested-node/tsx 的分裂是**既存非 S2 引入**,S2 同步更新了 bun 分支的喂给。三种运行场景(bun 二进制 / built Node `dist/theme/` / tsx `src/theme/`)解析到同一套 6 个 theme JSON。
- **3 个 copy 点**全部 `src/theme/*.json` → `dist/theme/`,复制同样 6 文件,**无 theme 资产漏拷**。png/`getInteractiveAssetsDir` 正确留给 S4。(旁注:新状态其实比父提交更自洽——父提交 `copy-binary-assets` 写 `dist/theme/` 而 `build-binaries.sh` 读 `dist/modes/interactive/theme/`,靠 `copy-assets` 也跑才救回来。)
- **reverse-dep 22→0**:core/step 进 modes/interactive 的 import 从 22 变 0(message 说 23,散文 off-by-one,实质成立)。树里剩 5 处 modes/interactive import 都来自 `src/cli/`(顶层编排 import UI 组件),合法。

**Part 2 packages/contracts(父提交 `f3de981` 根本不存在,message "was empty scaffold" 略有偏差,是全新 12 文件)**:
- name `@step-harness/contracts`,exports `.`→in-process + `./wire`→wire,**无 dependencies**(仅 devDeps),"runtime deps EMPTY" 成立。
- **没有任何东西 import contracts**,也没有 package.json 依赖它——纯 inert scaffold,**无 rewire、无运行时变化**。
- **frame codec 是重复实现**:同一种 wire 算法(4 字节大端 uint32 长度前缀 + payload),但**两份独立实现**:coding-agent `step/stdio.ts`(Node `Buffer`、有状态 class decoder、`maxFrameBytes=8MiB` 守卫、FRAME_TOO_LARGE 错)vs contracts `wire/frame.ts`(`DataView`/`Uint8Array`、无状态函数、**无尺寸上限**、序列化无关)。**现在字节兼容,但会 drift**,且 contracts 版缺 max-frame 守卫。`step/stdio.ts` S2 未动。→ **future-wiring debt,非当前行为变化**。
- **protocol version const 前缀**:contracts `STEP_AGENT_SDK_PROTOCOL_VERSION="1"`(**string**)是新常量非改名;coding-agent `STEP_PROTOCOL_VERSION=1`(**number**)不变。无消费者需更新(没人 import contracts)。**latent risk**:两个描述同一协议名的 "version 1" 常量**类型不同**,若哪天比较 `1 === "1"` 为 `false`。

**🔴 S2 提交时 shipped 4 个 failing 测试(🟢 S3 全 catch)**:
- `test/resource-loader.test.ts:135,443,688` — `readFileSync(join(process.cwd(),"src","modes","interactive","theme","dark.json"))`,文件搬了 → ENOENT → 测试失败。
- `test/theme-picker.test.ts:51` — `endsWith(join("modes","interactive","theme","step.json"))`,loader 现返回 `src/theme/step.json` → 断言失败。
- 这些是 split-form `join(...,"modes","interactive","theme",...)` **运行时路径**,不是 import,`pnpm run check`(tsgo)**结构上看不见**,只有 `pnpm -r test` 暴露——所以 S2 只跑 check 没跑 `-r test` 就漏了。
- **S3(`b8bf2ee`)恰好修了这 4 个**(3 resource-loader + 1 theme-picker)。agent 做了详尽扫描(contiguous-string / POSIX split-form / URL-form / 每个 theme-json 读 / 所有 `.mjs/.sh/.js` 构建工具 / theme-dir 断言),**确认 S2 没留第 5 个 stale theme-path 引用**。→ 纯测试问题,非 runtime 行为。

---

## 跨 commit 横向

| | 新类型错误 | 保留代码悬空 | 保留代码行为变化 | 殃及 |
|---|---|---|---|---|
| S0+S1-A | 0 | 0 | 无 | root `npm run clean` 坏(HEAD 已修);browser-smoke 覆盖缩小 |
| S1-B | 0 | 0 | 无 | 仅文档(S7 已记档) |
| S1-C | 0 | **1**(HEAD 仍在) | `RpcClient` 公开默认 | 4 测试丢隔离(HEAD 已修);2 处文档未记档 |
| S1-D | 0 | 0 | 无(protobufjs 假警报;仅 @protobufjs/utf8 patch) | 2 CI gate 没了;dead script |
| S1-R | 0 | 0 | 无 | 既存 `pi-agent-old` 悬空路径(baseline 就有) |
| S2 | 0 | 0 | 无(runtime) | 4 stale 测试(S3 全 catch);contracts 重复 codec/类型不一(latent) |

## 需要动手的(按优先级)

1. **🔴 `packages/coding-agent/test/rpc.test.ts:21`(HEAD 仍在)** — 改 `dist/cli.js` → `dist/bundle/step.js` **且** 把 `PI_CODING_AGENT_DIR` 换成 `STEP_CODING_AGENT_DIR`(否则 lines 61/104 的 `join(sessionDir,"sessions")` 断言在 step entry 下不成立)。当前被凭证门掩盖,有凭证的机器上会挂。这是 S0–S2 唯一仍需修的真 bug。
2. **🟡 S1-D 遗留 cruft** — 删 dead script(`generate-coding-agent-shrinkwrap.mjs`/`install-lock.mjs`)、清 `coding-agent/package.json:27` 的 stale `files` 条目。可单开 chore。
3. **🟡 S1-C 未记档文档残留** — `README.md:61`、`AGENTS.md:197-202` 的 `./pi-test.sh` 引用。归 S7。
4. **🟡 contracts latent debt** — frame codec 重复实现(缺 max-frame 守卫)+ `1` vs `"1"` 版本常量类型不一。仅在将来 wire in 时才有影响,建议 wire in 前统一。

**净结论**:S0–S2 对保留代码是**保真**的(must-keep 逐字节等价、功能实测通过、零新增类型错误);有意的三项移除(CBOR/SQLite/pi)都删得干净、没殃及保留代码。**唯一的真 bug 是 S1-C 的 `test/rpc.test.ts` 悬空路径(HEAD 仍未修)**;S0 的 `npm run clean` 断裂和 S1-C 的测试隔离回退都已在 HEAD 修复。protobufjs "降版" 是 commit message 的误述,实际无版本变化。
