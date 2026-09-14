# step-harness 项目结构重构设计：宿主入口、Coding Agent 与语音交互模块

> 状态：设计提案（2026-09-07 原稿，原样保留）。**实际落地与本提案有差异，见文末「附录 A：as-built 变迁对照」**（含 2026-09-14 后续结构决策，见「附录 A.5」：顶层 `extensions/` 已并入 `packages/extensions/`）；逐步执行历程见 `step-harness-最终实施方案.md`，面向评审排期的微调版见 `step-harness 代码结构· 最终方案.md`。
>
> 日期：2026-09-07
>
> 适用仓库：step-harness/
>
> 参考文档：[cli-package-architecture-survey.md](../cli-package-architecture-survey.md)、[docs/pnpm-step-视角-删除重构指南.md](docs/pnpm-step-视角-删除重构指南.md)、[Step CLI extensions README](../step-cli/extensions/README.md)、[Step CLI Extension Surface Interface](../step-cli/docs/core-concepts/extension-surface-interface.md)

## 0. 结论先行

采用 **方案三：宿主 apps + 平级领域 packages + 分阶段抽取**。

这里的关键不是把每个产品都做成一个 app，而是把两个维度分开：

- app 表示用户从哪里进入以及进程如何运行；
- package 表示某个 Agent 产品和可复用运行时能力；
- extension 表示可替换的外部协议或设备实现。

推荐目标树如下：

~~~text
step-harness/
├── apps/
│   ├── cli/                         # [新建+抽出] coding-agent 的 step/cli/bun/modes/stdio 入口
│   │   ├── package.json             # step bin；过渡期可带 pi 兼容 bin
│   │   ├── src/
│   │   │   ├── main.ts              # 唯一 CLI 进程入口
│   │   │   ├── commands/
│   │   │   │   ├── step.ts          # coding-agent 命令
│   │   │   │   ├── voice.ts         # voice surface：挂载 voice-agent 到 coding session
│   │   │   │   ├── auth.ts
│   │   │   │   └── models.ts
│   │   │   ├── modes/               # print/json/rpc/sdk-stdio
│   │   │   └── bootstrap/           # 配置、日志、扩展注册、退出清理
│   │   └── tsconfig.build.json
│   ├── tui/                         # [新建+抽出] coding-agent interactive host，复用现有 tui 原语
│   │   ├── package.json             # 可选 step-tui bin，或仅作为宿主入口
│   │   ├── src/
│   │   │   ├── main.ts              # 唯一 TUI 进程入口
│   │   │   ├── commands/            # code / voice surface 选择
│   │   │   ├── projection/          # Agent 事件到终端视图
│   │   │   └── bootstrap/
│   │   └── tsconfig.build.json
│   └── desktop/                     # [全新] 当前没有桌面宿主；首期只预留位置，不建 manifest
│       ├── package.json             # [后续] 需求明确后才创建
│       ├── src/                     # [后续] 桌面实现
│       │   └── main.ts
│       └── tsconfig.build.json      # [后续] 与 manifest 一起创建
├── packages/
│   ├── coding-agent/                # [保留+瘦身] 当前产品包；保留 prompt/tools/permissions
│   │   ├── package.json
│   │   └── src/                     # 编码 Agent 产品逻辑，不拥有进程入口
│   ├── voice-agent/                 # [全新] 语音 interaction；不拥有 Agent loop
│   │   ├── package.json
│   │   └── src/                     # 语音交互模块，不拥有独立 Agent loop 或进程入口
│   ├── agent/                       # [保留] 当前 packages/agent 的通用 loop
│   │   ├── package.json
│   │   └── src/                     # Agent loop 和工具调用时序
│   ├── agent-runtime/               # 后续可选：满足共享 contract 后再创建
│   │   ├── package.json
│   │   └── src/                     # runtime 装配、host facade
│   ├── session/                     # [新包+抽出] coding-agent/core 的 session-manager/entry
│   │   ├── package.json
│   │   └── src/                     # 事件、恢复、fork、订阅
│   ├── storage/                     # [后续抽出，首期不创建] 持久化 adapter；保留现有 SQLite backend
│   │   ├── package.json             # [后续]
│   │   └── src/                     # JSONL/SQLite/锁和缓存适配
│   ├── ai/                          # [保留+重组] 当前 packages/ai 的 api/providers
│   │   ├── package.json
│   │   └── src/                     # dialect/provider contract、registry、catalog
│   ├── tools/                       # [新包+抽出] coding-agent/core/tools 与 bash/tool-profile
│   │   ├── package.json
│   │   └── src/                     # 工具定义、安全策略和执行 facade
│   ├── sdk/                         # [新 facade+抽出] coding-agent/core/sdk、step/sdk
│   │   ├── package.json
│   │   └── src/                     # app 和外部宿主使用的稳定 API
│   ├── tui/                         # [保留+重组] 当前 packages/tui，增加 renderer/runtime
│   │   ├── package.json
│   │   └── src/
│   │       ├── renderer/             # 通用终端渲染原语
│   │       └── runtime/              # CLI/TUI 共同调用的交互编排
│   ├── realtime/                    # [全新] 实时音频/VAD/interrupt contract
│   │   ├── package.json
│   │   └── src/                     # 音频帧、turn、interrupt 等中立 contract
│   ├── contracts/                   # [新建/重建] JSONL/SDK contract，非 CBOR protocol
│   │   ├── package.json
│   │   └── src/                     # 新的 canonical JSONL/SDK contract
│   ├── config/                      # [新包+抽出] coding-agent config/settings/stepcode
│   │   ├── package.json
│   │   └── src/                     # 配置 schema、加载和迁移
│   └── telemetry/                   # [保留] 当前 packages/telemetry
│       ├── package.json
│       └── src/
├── extensions/
│   ├── llm/                         # [抽出+重组] packages/ai 的 wire adapters
│   ├── mcp/                         # [新建+抽出] step/plugins 声明及未来 bridge
│   └── realtime-voice/              # [全新] 音频采集、播放或厂商桥接
├── infra/                           # [现有，保留] release-bundle、release-targets、install 脚本
├── plugins/
├── scripts/
└── docs/
~~~

`infra/release/` 是真实存在的发布链路（`release-bundle.mjs`、`release-targets.json`、`install.sh`/`install.ps1`），被根 `release:bundle` 脚本引用。入口从 `packages/coding-agent` 外移到 `apps/cli` 时，真正需要同步修改的是**承载入口路径的 `scripts/build-binaries.sh`**（及 coding-agent 的 `build:binary` 脚本）——它们决定 `bun build --compile` 编译哪个 entry。`release-targets.json` 只声明各发布产物的 `id`/`archiveType`/`binary`（产物 bin 文件名，如 `step`/`step.exe`），**不含任何来源/入口路径**，而且当前并未被 `release-bundle.mjs` 读取（后者硬编码了自己的 `TARGETS` 列表），因此入口迁移不涉及它。见阶段 2。

来源标记统一如下：`保留` 表示现有包继续使用；`抽出` 表示从现有 `src` 按职责移动；`重组` 表示代码保留但内部目录改变；`新建/全新` 表示当前没有对应实现；`后续` 表示首期不创建 workspace 包。

| 目标目录 | 来源或事实 | 首期动作 |
| --- | --- | --- |
| `apps/cli` | [新建+抽出] `coding-agent/src/{step-cli,cli,bun/*,modes/*,step/stdio*}` | 新 host；旧入口保留 shim |
| `apps/tui` | [新建+抽出] `coding-agent/src/modes/interactive/**`，复用 `packages/tui/src/**` | 新 TTY host；拥有进程生命周期 |
| `apps/desktop` | [全新] 当前无桌面宿主 | 首期只在文档里预留位置，不创建 manifest |
| `packages/coding-agent` | [保留+瘦身] 当前 `packages/coding-agent/src/**` | 保留 coding 产品和兼容层，移出入口/host mode |
| `packages/voice-agent` | [全新或 interaction 模块] 当前无语音 Agent loop | 只接收 `AgentSessionHandle`；不创建 Session |
| `packages/agent` | [保留] 当前 `packages/agent/src/**` | 保留通用 loop |
| `packages/ai` | [保留+重组] 当前 `packages/ai/src/api/**`、`providers/**` | 先包内建立 dialect/catalog |
| `packages/tui` | [保留+重组] 当前 `packages/tui/src/**`、`native/**` | 增加 `renderer`/`runtime`，不拆 `tui-runtime` 包 |
| `packages/agent-runtime` | [后续抽出] `coding-agent/src/core/agent-session-runtime.ts`、`agent-session-services.ts`、`session-manager-factory.ts` | 首期由 coding-agent 内部模块承担 |
| `packages/session` | [新包+抽出] `coding-agent/src/core/session-manager.ts` 及 entry/export 代码 | 先留在 coding-agent，contract 稳定后再移 |
| `packages/storage` | [后续抽出，首期不创建] 持久化 adapter 可从 `packages/agent/src/harness/session/` 与 `session-backends/sqlite-node` 整理 | 首期保留 JSONL/memory 与 SQLite backend；出现第二个消费者且 adapter contract 稳定后再建包 |
| `packages/tools` | [新包+抽出] `coding-agent/src/core/tools/**`、`bash-executor.ts`、`step/tool-profile.ts` | 默认工具先留产品包 |
| `packages/sdk` | [新 facade+抽出] `coding-agent/src/core/sdk.ts`、`step/sdk.ts` | 与待删除的 CBOR `packages/client` 区分 |
| `packages/realtime` | [全新] 当前无中立实时语音 contract | 需要流式/VAD/打断时才创建 |
| `packages/contracts` | [新建/重建] 从 JSONL/stdio 类型整理；不直接复用 CBOR protocol | 直接定为终名，不计划二次改名 |
| `packages/config` | [新包+抽出] `coding-agent/src/config.ts`、`core/settings-manager.ts`、`step/stepcode-config.ts` | 首期通过 coding facade 使用 |
| `packages/telemetry` | [保留] 当前 `packages/telemetry/src/**` | Step 专属事件仍在 coding-agent |
| `extensions/llm` | [抽出+重组] `packages/ai/src/api/**` 及 provider 特殊 transport | 先在 ai 内验证 dialect |
| `extensions/mcp` | [新建+抽出] `coding-agent/src/step/plugins.ts` 声明及未来 bridge | 当前声明不等于完整 MCP runtime |
| `extensions/realtime-voice` | [全新] 当前无设备桥接实现 | 按需接入外部音频 SDK |

上述来源说明适用于后面的三种方案；方案树只表示拆分时机不同，不代表重复创建同一份代码。

`renderer/` 和 `runtime/` 是目标模块边界；迁移初期可以继续让现有 renderer 文件保持在 `packages/tui/src/`，先用入口文件和依赖检查隔离 runtime，再按测试证据移动物理目录。

目录名 desktop 用单数表示一个桌面宿主。如果以后同时维护 Electron 和原生桌面两个壳，再在 apps 下增加更具体的 workspace；没有这个需求时不创建 desktops 目录。

如果仓库已经约定使用复数命名，也可以把它统一写成 apps/desktops；这只影响目录命名，不改变它作为桌面 host、以及与 cli/tui 同级的职责。

但 apps/desktop 在首期**只出现在目标树里，不创建 workspace manifest**。一个没有需求、只有 placeholder `main.ts` 的 workspace 正好落在 §3.2 列出的反例上（“为了让目录看起来对称而创建的空壳 package”），而且它会进入 workspace glob、`pnpm -r build` / `npm run build --workspaces` 的遍历范围和依赖检查规则，产生真实维护成本却没有对应收益。等桌面框架、生命周期和发布方式确定后再创建 manifest；在那之前，目标树里的 desktop 表达的是“为它保留了什么位置”，不是“现在要建什么目录”。

运行关系是：

~~~text
step / step voice
  -> apps/cli/src/main.ts
  -> apps/cli/src/commands/*
  -> coding-agent session（首期由 coding-agent 内部 runtime 创建；voice 命令额外挂载 voice-agent）
  -> packages/agent / session / ai / tools
  ->（满足条件后）packages/agent-runtime
  -> print、json、rpc 或 `@step-harness/tui-kit/runtime`

step-tui code / step-tui voice
  -> apps/tui/src/main.ts
  -> @step-harness/tui-kit/runtime
  -> coding-agent session（首期使用 coding-agent 内部 runtime；/voice 额外挂载 voice-agent）

未来 desktop
  -> apps/desktop/src/main.ts
  -> packages/sdk
  -> coding-agent session（voice surface 可挂载 voice-agent）
~~~

因此，coding-agent 和 voice-agent 在目录上是平级的领域包，只有 CLI 或 TUI 的命令负责进入它们；运行时角色并不对称。coding-agent 是唯一拥有工具调用和代码任务 loop 的主 Agent，voice-agent 是被挂载到主会话上的语音交互模块。两者不通过继承或相互 import 复用。

明确排除一种看似直观但不符合当前运行模型的拆法：按 coding-agent、voice-agent 各自创建一个产品 app，再在每个 app 里面复制 CLI/TUI。当前没有两个独立产品进程的需要；只有当未来语音交互模块真的需要独立发布、独立权限和独立生命周期时，才为它增加专门的 host。

### 0.1 Monorepo 是前提，但包管理器现状是 npm + pnpm 双轨

三种方案都建立在一个 workspace monorepo 上。目标状态由选定的包管理器维护一份 lockfile；当前仓库仍是 npm 与 pnpm 双轨，不能把下面的目标状态当成现状：

- apps、packages、extensions 由同一个 workspace 图管理；
- workspace 依赖和构建顺序由各 package 的 manifest graph 表达；
- Agent、Session、AI 的 contract 和 conformance fixture 可以在同一次变更中演进；
- 迁移期可以同时保留旧入口和新入口，逐阶段切换。

monorepo 不等于把所有代码放在一个 package。根 package 只做编排，真正有独立 API、依赖或测试边界的目录才拥有自己的 manifest。目录层级只是提示，依赖方向必须由 package.json、exports 和架构检查共同约束。

需要先纠正一个前提：**当前仓库不是纯 pnpm workspace，主线其实是 npm workspaces。** 实际状态是：

| 事实 | 证据 |
| --- | --- |
| 根 package 名为 `step-cli`，声明了 npm `workspaces` 数组 | 根 `package.json` |
| npm 与 pnpm 两套 lockfile 并存 | `package-lock.json` + `pnpm-lock.yaml` |
| 构建/测试脚本走 npm | `npm run clean --workspaces`、`npm run test --workspaces`、`npm --prefix packages/ai run …` |
| 有 npm 专属产物和 CI 门禁 | `packages/coding-agent/npm-shrinkwrap.json`（`check:shrinkwrap`）、`packages/coding-agent/install-lock/package-lock.json`（`check:install-lock:coding-agent`） |
| 版本发布依赖 npm 语义 | `version:patch/minor/major` 用 `npm version --workspaces` + `npm install --package-lock-only` |

因此本文 §13 给出的 `pnpm --filter` 脚本、§13.6 的 `pnpm-workspace.yaml` 都隐含了一次 npm → pnpm 迁移。这次迁移**不属于**本文的架构重构范围，必须作为独立前置阶段处理，否则会和入口外移绑成一个不可回滚的大提交。两种落地方式二选一：

1. **保留 npm workspaces**（推荐，改动最小）：把 §13.1、§13.6 的示例按 npm 语法理解——`pnpm --filter X build` 对应 `npm run build --workspace=X`，`pnpm -r build` 对应 `npm run build --workspaces --if-present`，`pnpm --filter X... build` 没有直接等价物，需要靠 manifest graph 或显式顺序表达。workspace 成员由根 `package.json` 的 `workspaces` 数组维护，`pnpm-workspace.yaml` 同步更新。
2. **统一到 pnpm**：新增“阶段 -1：统一包管理器”，内容包括删除 `package-lock.json`、把 `--workspaces`/`--prefix` 脚本改写为 `--filter`、重新评估 `npm-shrinkwrap.json` 与 install-lock 这两套 npm 专属产物在 pnpm 下的替代方案（这是最大的未知项，`check:shrinkwrap` 和 `check:install-lock:coding-agent` 两个门禁都建立在它们之上）、并重跑发布 smoke test。

在做出这个决定之前，不要按 §13 的脚本示例直接改根 `package.json`。

### 0.2 四层结构，两条正交轴

结构上分四层，但真正正交的是前两条轴（Host × Product）——后两层是被这两条轴共同消费的底座：

| 层 | 目录 | 回答的问题 | 拥有的东西 |
| --- | --- | --- | --- |
| 轴 1：Surface / Host | apps/cli、apps/tui、apps/desktop | 用户从哪里进入？进程如何启动？ | argv、TTY、桌面生命周期、退出码、最终清理 |
| 轴 2：Product / Interaction | packages/coding-agent、packages/voice-agent | 主 Agent 或交互模块提供什么领域行为？ | coding prompt、工具集合、权限策略；voice 的转写、turn-taking、播报 |
| 底座：Engine / Contract | packages/agent、ai 等；agent-runtime 为后续可选包 | 哪些稳定语义需要跨产品共享？ | Agent loop、事件、模型路由、存储和 SDK |
| 底座：Optional implementation | extensions/* | 哪些外部实现可以替换或禁用？ | LLM wire adapter、MCP、音频设备桥接 |

“正交”指的是：任一 host 可以组合任一 product，两者的组合数不需要新增目录。coding-agent 与 voice-agent 的关系是：

~~~text
apps/cli  ───────────────┐
apps/tui  ───────────────┼──> packages/coding-agent
apps/desktop（未来）─────┘          │
                                    ├──> coding-agent 内部 session runtime（首期）
                                    ├──> packages/agent-runtime（满足条件后）
                                    ├──> packages/agent
                                    └──> packages/session / ai / tools

apps/cli / apps/tui / desktop
  └──> packages/voice-agent（voice interaction）
             └── 注入 AgentSessionHandle -> 上面的 coding session
~~~

同一个 host 可以组合 coding-agent 和 voice-agent；同一个 coding session 也可以在文本和语音 surface 之间切换。这个复用关系就是把它们放在 packages 下的主要理由。

### 0.3 关键决策

| 决策 | 结论 |
| --- | --- |
| apps 放什么 | 只放可执行宿主和界面入口：cli、tui、desktop |
| coding-agent 放什么 | 编码领域行为，目录为 packages/coding-agent/src |
| voice-agent 放什么 | 语音交互行为，目录为 packages/voice-agent/src，与 coding-agent 平级；不拥有第二套 tool-calling loop |
| 谁解析 argv | apps/cli 或 apps/tui；领域包不解析命令行 |
| 谁拥有 Session 真相 | 首期为 coding-agent/src/core；外提后才由 agent-runtime/session 负责，UI 只订阅和发送输入 |
| 语音设备放哪里 | extensions/realtime-voice；voice-agent 依赖中立 realtime contract |
| LLM 如何分流 | 按 ModelApiDialect；provider 只描述 endpoint、认证和目录身份 |
| Step CLI 的 extensions 是否照搬 | 借鉴其边界和注册方式，不把所有内部 feature 都改成 extension |
| TypeScript extends 是否表示运行时继承 | 不表示；只用于配置文件继承 |
| TUI 包是否单独拆 runtime | 合并为一个 `packages/tui`，用 `src/renderer`、`src/runtime` 保留职责边界 |
| tui-kit 是否依赖 sdk | 不进 `dependencies`；runtime 子模块用 optional peerDependency，或直接下沉到 apps/tui（见 §13.4） |
| 包管理器 | 现状是 npm workspaces 为主、pnpm lockfile 并存；统一到 pnpm 是独立前置阶段，不属本次重构（见 §0.1） |
| 拆包判据是否包含“独立发布” | 否。当前 10 个 workspace 全部 `private: true`，有效判据只剩依赖方向、测试边界和生命周期（见 §2.1） |
| apps/desktop 首期是否建 manifest | 否，只在目标树中预留位置 |

TUI 只保留两个责任层，但不再为它们创建两个 workspace package：

- apps/tui 是可运行的 TTY host，负责进程生命周期、键盘、resize 和退出恢复；
- packages/tui/src/renderer 是不拥有进程的通用渲染原语，包含现有 terminal、layout、components、editor 和 native 辅助模块；
- packages/tui/src/runtime 是可被 CLI 和 TUI 共同调用的交互编排，只依赖中立的 SDK/contract 和 renderer，不依赖 coding-agent、voice-agent 或任何 app 私有文件；voice 模式通过注入的 input/output adapter 连接 coding session。

合并的是 package 边界，不是职责边界。根入口只导出 renderer；runtime 通过 `@step-harness/tui-kit/runtime` 子路径导出，避免消费者无意间依赖内部文件。若后续确认 runtime 只被 apps/tui 使用，应该把它移到 apps/tui/src/runtime，而不是为了保持目录对称再拆回一个 package。

### 0.4 voice-agent 的角色：语音通道，不是第二个主 Agent

`voice-agent` 这个目录名可以保留，但其 contract 应明确表示 voice interaction，而不是一个拥有独立 Session 的产品 Agent：

- `coding-agent` 创建唯一的可恢复 Agent Session，选择 coding model、工具和权限；
- `voice-agent` 负责 ASR、turn-taking、VAD、TTS/播报和语音侧的中断状态，把语音输入转换为 canonical `AgentInput`，把 `AgentEvent` 转成语音或文本输出；
- voice model 的 capability 固定为 `toolCall: false`，请求中不附带 coding tools；即使上游返回工具调用意图，也由 adapter 拒绝，不进入 Agent loop；
- coding-agent 的组合根（外提后可由 `agent-runtime` 承担）把两者连接起来，向 voice-agent 注入 `AgentSessionHandle`。voice-agent 不 import coding-agent，coding-agent 也不 import voice-agent；
- **权限审批事件必须有明确归属**：coding session 触发 bash/write 审批时，语音 surface 不能默认吞掉或自行放行，具体策略见 §4.6.1。

典型链路如下：

~~~text
apps/tui /voice
  -> createCodingAgentProduct({ model: codingModel, tools })
  -> createVoiceInteraction({ realtimeDriver, voiceModel: { toolCall: false } })
  -> attachVoiceInteraction({ voice, session: codingSession })
  -> voice transcript -> codingSession.send()
  -> coding AgentEvent/tool result -> voice.speak()
~~~

`/voice` 是交互 surface 的切换，不是把 target 切成一个拥有另一套 Agent loop 的 voice product。比如用户说“帮我写一点 HTML”，voice-agent 只把转写结果提交给 coding session；coding model 决定是否调用写文件或编辑工具，工具结果再由 voice-agent 播报。未来如果需要纯语音闲聊，可以新增不带工具的 session policy；这不改变“语音编排不拥有 coding 工具”的默认边界。

### 0.5 `agent-runtime` 的必要条件

`agent-runtime` 不是 CLI、TUI 或 voice 接入的前置层。它只在下面这段装配逻辑需要被多个消费者独立复用时才有独立 package 的价值：创建 AgentSession，连接 model/tools/storage/telemetry，执行 `new`/`resume`/`fork`/`import`，在 Session 替换时重绑宿主订阅，并完成 `abort`/`dispose` 生命周期。

当前只有 `coding-agent` 是真正拥有 tools 的主 Agent。两个 host 调用同一个 coding 产品，voice 也只接收已有的 `AgentSessionHandle`；因此首期把 `AgentSessionRuntime` 和 `session-manager` 留在 `packages/coding-agent/src/core`，由 `coding-agent` 暴露 `createCodingAgentProduct()` / `createSession()` facade。这里的“runtime”是内部模块，不必立即成为 workspace package。

只有出现第二个 tool-capable Agent、desktop/server/SDK 需要脱离 coding-agent 管理 Session，或多个宿主产生重复装配，并且实现已经能不依赖 coding-agent、voice-agent 和 UI 独立测试时，才新增 `packages/agent-runtime`。抽取顺序应是先冻结中立 contract，再移动实现；否则只是增加一层 facade、exports 和潜在循环依赖。本文后续提到的 `agent-runtime` 均按这个条件理解。

## 1. 当前基线与问题

### 1.1 当前仓库的实际形状

当前 step-harness 已经是 workspace 雏形（npm workspaces 为主、pnpm 并存，见 §0.1），但产品入口和 library 逻辑仍集中在 packages/coding-agent：

~~~text
step-harness/
├── package.json                     # name: step-cli，声明 npm workspaces 数组
├── package-lock.json                # npm lockfile
├── pnpm-workspace.yaml              # pnpm workspace 定义
├── pnpm-lock.yaml                   # pnpm lockfile（与上面并存）
├── tsconfig.base.json               # 已存在；Node16 + allowImportingTsExtensions
├── tsconfig.json                    # noEmit + 全量 path alias
├── packages/
│   ├── coding-agent/                # [保留+瘦身] 当前产品包；保留 prompt/tools/permissions
│   ├── agent/                       # [现有，保留] 通用 Agent loop
│   ├── ai/                         # [现有，保留+重组] 模型 API/provider
│   ├── tui/                        # [现有，保留+重组] renderer，后续加 runtime 模块
│   ├── telemetry/                  # [现有，保留] telemetry contract/实现
│   ├── protocol/                   # [现有，待按删除指南处理] CBOR protocol
│   ├── client/                     # [现有，待按删除指南处理] 远程 CBOR client
│   ├── server/                     # [现有，待按删除指南处理] 远程 CBOR server
│   ├── session-backends/sqlite-node/ # [现有，保留] 备用 SQLite backend，与 CBOR 无关
│   └── evals/                      # [现有，保留] 评测脚本和 fixture
├── infra/release/                   # [现有，保留] release-bundle、release-targets、install
├── plugins/
├── scripts/                         # 构建/门禁脚本：bundle、shrinkwrap、install-lock、ts-imports
└── docs/
~~~

10 个 workspace 包**全部是 `private: true`**，没有一个对外发布。此外 `packages/coding-agent/examples/extensions/` 下还有 5 个示例扩展也是 workspace 成员（见 §13.6）。

packages/coding-agent/src 同时承载了入口、产品配置、模式、运行时和远程会话兼容层：

~~~text
packages/coding-agent/src/
├── index.ts                        # 包公共入口
├── cli.ts                          # pi 入口
├── step-cli.ts                     # step 入口
├── step-cli-runtime.ts             # step 运行时装配
├── step-bootstrap.ts               # step 启动引导
├── main.ts                         # 主流程和 mode 决策
├── rpc-entry.ts                    # rpc 子进程入口
├── config.ts / migrations.ts       # 配置与迁移
├── package-manager-cli.ts          # 扩展包管理 CLI
├── step/                           # Step 配置、权限、stdio、遥测、plugins
├── cli/                            # 参数、auth、session picker
├── modes/
│   ├── interactive/
│   ├── print-mode.ts
│   ├── json-event.ts
│   └── rpc/
├── core/
│   ├── agent-session*.ts
│   ├── model-*.ts
│   ├── tools/
│   └── extensions/
├── extensions/                     # Step feature、subagent、plan、tasks、llama
├── client/                         # RemoteSession / CBOR client adapter
├── server/create-harness.ts        # 本地 AgentHarness 工厂
├── utils/                          # 通用工具
└── bun/                            # pi/step 的编译入口
~~~

其中 `step-bootstrap.ts` 和 `step-cli-runtime.ts` 是阶段 2 要拆分的核心：前者属于 host 启动引导（应进 `apps/cli/src/bootstrap/`），后者是产品侧运行时装配（应留在 `packages/coding-agent`）。两者当前混在同一层目录，是“入口和产品逻辑混在一起”最直接的体现。

这里的 coding-agent 既像一个可执行产品，又像一个库；当 voice-agent 出现时，任何新增功能都很难回答应该放在产品入口、通用 runtime 还是共享 package。

### 1.2 两份参考文档带来的约束

cli-package-architecture-survey.md 提供的是拆分顺序：先按职责形成 module，再确认 API、依赖和测试边界，最后才把稳定边界提升为独立 package。它还强调 app 是可运行宿主，package 是发布和复用边界，不能因为目录数量好看就过早细分。

docs/pnpm-step-视角-删除重构指南.md 提供的是运行时证据：pnpm step 的正常模式走 Agent、AI、TUI 和 telemetry，远程 CBOR client/server/protocol 是另一条可独立删除的链路。新结构沿用这两个约束，所以 host 外移和 CBOR 清理分别安排，避免用一次目录搬迁掩盖依赖变化。

### 1.3 pnpm step 的当前链路

删除指南已经确认，当前 step 的主链路是进程内的 Agent runtime，不是 CBOR 远程会话：

~~~text
pnpm step
  -> packages/coding-agent/src/step-cli.ts
  -> packages/coding-agent/src/main.ts
  -> resolveAppMode()
  -> AgentSessionRuntime / AgentSession
  -> packages/agent
  -> packages/ai
  -> interactive、print、json 或 rpc mode
~~~

目标链路只把 host 入口外移，保留领域行为：

~~~text
pnpm step
  -> apps/cli/src/main.ts
  -> apps/cli/src/commands/step.ts
  -> packages/coding-agent/src/index.ts
  -> packages/coding-agent/src/core/agent-session-runtime.ts（首期）
  -> packages/agent-runtime/src/*（满足触发条件后）
  -> apps/cli 的输出 mode 或 `@step-harness/tui-kit/runtime`
~~~

### 1.4 模式归属

| 当前模式 | 当前实现 | 目标 host 归属 | 目标 package 归属 | 与 CBOR 的关系 |
| --- | --- | --- | --- | :---: |
| interactive | src/modes/interactive | apps/tui；CLI 可调用 `@step-harness/tui-kit/runtime` | `packages/tui/src/runtime` + Agent SDK | 无关 |
| print | src/modes/print-mode.ts | apps/cli/src/modes/print.ts | sdk/runtime 事件 facade | 无关 |
| json | print-mode.ts + json-event.ts | apps/cli/src/modes/json.ts | contracts/sdk 类型 | 无关 |
| rpc | src/modes/rpc | apps/cli/src/modes/rpc.ts | contracts/sdk | 无关 |
| sdk-stdio | src/step/stdio-host.ts、stdio.ts | apps/cli/src/modes/sdk-stdio.ts | sdk/contracts | 无关 |
| subagent | src/extensions/step-subagent* | CLI/TUI 的组合配置 | agent-runtime feature 或独立 extension | 使用 JSONL，不是 CBOR |
| RemoteSession | src/client | 不进入默认 host | 删除或单独 remote package | CBOR |

interactive 不应继续被简单描述为 coding-agent 的 TUI。它是一个 surface：同一个 TUI host 可以启动 coding-agent，也可以通过 `/voice` 把 voice-agent 挂载到同一个 coding session 上。TUI 的渲染状态和 voice adapter 都不拥有 Session 的事实来源。

### 1.5 需要解决的问题

| 问题 | 当前表现 | 重构后的处理 |
| --- | --- | --- |
| 入口和产品逻辑混在一起 | coding-agent 产出 pi、step 并承载所有 mode | 由 apps/cli 和 apps/tui 拥有入口；Agent 包只暴露 API |
| coding 与 voice 无法共享 host | 语音入口容易复制一套 coding Agent | host 与 product/interaction 两轴正交，任一 host 可组合 coding session 和 voice interaction |
| TUI 容易被重复实现 | interactive 代码和产品配置纠缠 | 通用渲染与交互编排放在同一 `packages/tui` 的不同模块，coding 事件由主 Agent 提供，voice 只做输入输出适配 |
| 根脚本隐藏构建图 | `build` / `build:offline` 用一串 `cd packages/x && npm run build` 硬编码 10 个包的顺序 | 改用 workspace filter 和 manifest graph 表达（具体语法取决于 §0.1 的包管理器决策） |
| extension 边界不清 | coding-agent/src/extensions 混有必需 feature 和可选集成 | 按稳定 contract、可选依赖和生命周期判断 |
| AI 按厂商误分流 | provider 名被当作协议 key | Model.api/dialect 决定 wire adapter，profile 单独描述服务身份 |
| CBOR 删除容易误删正常 RPC | client、JSONL rpc、stdio 名称相近 | 先按消费者分组，CBOR 作为独立变更 |

## 2. 共用的边界规则

### 2.1 app、domain package、engine package、extension

~~~text
app
  可运行的宿主。拥有 bin、process.argv、TTY/桌面生命周期、退出码和组合根。

domain / interaction package
  一个 Agent 产品或交互模块的领域行为。拥有 src/、公共 API 和测试，但不拥有进程入口。

engine package
  跨产品的稳定语义，例如 Agent loop、Session、AI contract、存储和 SDK。

extension
  仓库维护的可替换实现。接入外部协议、设备或可选 SDK，由 app 组合根注册。

plugin
  用户或第三方按 manifest 安装的运行时扩展，权限和版本策略独立于内置 extension。
~~~

必须满足：

- apps/* 可以依赖 packages/* 和 extensions/*；
- packages/* 不得依赖 apps/*；
- extensions/* 不得导入 apps/* 的内部文件；
- coding-agent 和 voice-agent 不能通过相对路径互相导入；
- app 是唯一直接拥有 process.argv、process.exit、TTY 初始化和最终 telemetry flush 的层；
- **app 的组合根是唯一注册 extension 的地方**：packages/* 和 extensions/* 都不得注册其他 extension，也不得按目录或字符串隐式扫描加载；注册必须是显式静态的（见 §3.1）；
- Agent loop、Session 事件和模型 contract 不导入 Commander、具体 TUI 组件或具体厂商 SDK；
- **反向也要设防**：renderer、contract 一类的中立包不得反过来依赖 Agent 侧的包（典型反例见 §13.4 的 tui-kit → sdk）；
- 所有跨 package 使用都通过 package name 和 exports，禁止 ../ 穿透 src；
- package 是否拆分以依赖方向、测试边界和生命周期为依据，不以目录数量为目标。

关于拆包判据需要特别澄清一点：**“独立发布”在当前仓库不是有效判据。** 10 个 workspace 包全部声明了 `private: true`，没有任何一个对外发布，也就不存在“独立发布节奏”“版本兼容承诺”这类通常支撑拆包的理由。因此本文所有涉及是否新建 package 的判断，都只应基于三条：

1. **依赖方向**——拆开能否消除一条不该存在的依赖边，或让依赖图从环变成树；
2. **测试边界**——这部分代码能否脱离其余部分独立测试，且这种独立性有实际价值；
3. **生命周期**——它是否会以明显不同于宿主包的频率变更、或被明显不同的人维护。

三条都不满足时，用目录和 exports 子路径表达边界即可，不要新建 workspace。若未来确实要对外发布某个包（例如 sdk 或 tui-kit），再把“发布”加回判据，并同时补上版本策略和 API 冻结要求。

### 2.2 推荐依赖方向

~~~mermaid
flowchart TD
  cliApp[apps/cli] --> coding[packages/coding-agent]
  cliApp --> voice[packages/voice-agent]
  cliApp --> tuiPackage[packages/tui]
  tuiApp[apps/tui] --> coding
  tuiApp --> voice
  tuiApp --> tuiPackage
  desktop[apps/desktop（未来，首期不建包）] -. 未来 .-> sdk[packages/sdk]
  desktop -. 未来 .-> coding
  desktop -. 未来 .-> voice
  sdk -. 满足触发条件后 .-> runtime[packages/agent-runtime（可选）]
  coding -. 满足触发条件后 .-> runtime
  coding --> agent[packages/agent（首期直接复用）]
  runtime --> agent
  runtime --> session[packages/session]
  runtime --> ai[packages/ai]
  runtime --> tools[packages/tools]
  runtime --> config[packages/config]
  agent --> ai
  agent --> telemetry[packages/telemetry]
  tuiRuntime["packages/tui/src/runtime（模块，非独立包）"] -. 仅模块级 .-> sdk
  tuiRuntime --> tuiRenderer[packages/tui/src/renderer]
  llm[extensions/llm] --> ai
  realtime[extensions/realtime-voice] --> realtimeContract[packages/realtime]
  voice -. 按需 .-> realtimeContract
~~~

图中的 package 不要求在第一天全部创建。虚线表示尚未成立的依赖：`agent-runtime` 的后续抽取（首期由 coding-agent 内部的 `AgentSessionRuntime` 承担同一职责，只有 API、依赖和测试边界稳定且有多个消费者后才外提）、以及 apps/desktop 的未来接入（首期不创建 manifest，见 §0）。图中没有画出 voice 与 coding 的直接依赖，因为它们不应互相 import；组合根同时创建 voice interaction 和 coding session，再把 `AgentSessionHandle` 注入 voice adapter。

`packages/tui/src/runtime` 到 sdk 的边**是模块级依赖，不是 package 级依赖**——这条区别很关键。`packages/tui` 的 `dependencies` 中不应出现 sdk，否则只需要 renderer 的消费者也会被拖进整个 Agent SDK 的依赖闭包；exports 子路径能隔离 API 表面，隔离不了 node_modules 和构建图。落地方式见 §13.4。renderer 本身在任何情况下都保持与 Agent 无关。

建议把允许的主要依赖写成架构检查规则：

| 发起方 | 可以依赖 | 不应依赖 |
| --- | --- | --- |
| apps/cli | coding-agent、voice-agent、sdk、`@step-harness/tui-kit/runtime`、config、选中的 extensions | apps/tui 内部源码、Agent loop 私有文件 |
| apps/tui | coding-agent、voice-agent、sdk、`@step-harness/tui-kit`、选中的 extensions | apps/cli 内部源码、provider wire 细节 |
| apps/desktop（未来） | sdk、coding-agent、voice-agent、realtime contract | CLI argv parser、TUI 私有 projection |
| packages/tui（tui-kit） | renderer 只依赖终端与排版类库；runtime 子模块以 optional peer 方式使用 sdk | 把 sdk 写进 `dependencies`、coding-agent、voice-agent、任意 apps |
| packages/coding-agent | 首期为 agent、session、ai、tools、config；外提后再依赖 agent-runtime | 任意 apps、具体 TTY 组件 |
| packages/voice-agent | sdk/contracts、ai contract（仅 voice capability）、realtime contract、可选的音频 SDK facade | agent loop、tools、coding-agent、任意 apps、麦克风设备实现 |
| extensions/* | 对应 contract package、底层外部 SDK | 任意 apps/* 内部文件、其他 extension 的私有实现 |

### 2.3 Host 到 Agent 的稳定 contract

app 不应知道 coding-agent 内部有多少文件。建议为主 Agent 和语音交互模块定义不同但可组合的 facade：

~~~ts
export type AgentProductId = "coding";
export type InteractionSurface = "text" | "voice";

export interface AgentProduct {
  readonly id: AgentProductId;
  readonly version: string;
  createSession(options: CreateAgentSessionOptions): Promise<AgentSessionHandle>;
  describeCapabilities(): AgentCapabilitySnapshot;
}

export interface AgentSessionHandle {
  readonly sessionId: string;
  send(input: AgentInput): Promise<void>;
  steer(input: AgentInput): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  subscribe(listener: AgentEventListener): Unsubscribe;
  close(): Promise<void>;
}

export interface VoiceInteraction {
  readonly id: "voice";
  readonly modelPolicy: { readonly toolCall: false };
  attach(session: AgentSessionHandle): Promise<VoiceInteractionHandle>;
}

export interface VoiceInteractionHandle {
  stop(): Promise<void>;
}
~~~

coding-agent 实现 `AgentProduct`，voice-agent 实现 `VoiceInteraction`；两者可以共享类型 package，但不共享一个“万能产品类”。coding-agent 实现 coding prompt、工具集合和权限默认值；voice-agent 实现转写、turn-taking、播报和输入输出转换，不创建第二个 Agent Session。

AgentProduct、AgentSessionHandle、AgentEvent 和 VoiceInteraction 这类 host-facing 类型建议放在 packages/sdk；如果未来确实创建 agent-runtime，也可以由它 re-export 生命周期相关类型。组合根创建 coding session，再把 handle 传给 voice-agent；不要把 contract 定义在 packages/coding-agent 再让 voice-agent 反向依赖它。

### 2.4 CLI 与 TUI 如何组合 coding Agent 与 voice interaction

推荐让 apps/cli 和 apps/tui 都调用 `@step-harness/tui-kit/runtime` 或 packages/sdk，而不是互相导入源码：

~~~text
方式 A：进程内共享（推荐）
  apps/cli -> @step-harness/tui-kit/runtime -> coding-agent session
  apps/tui -> @step-harness/tui-kit/runtime -> coding-agent session
  /voice    -> voice-agent adapter -> 同一个 coding-agent session

方式 B：独立进程
  apps/cli -> 启动 step-tui 子进程
  apps/tui -> packages/sdk -> Agent package
  两个进程通过稳定 JSONL/stdio contract 通信
~~~

方式 A 启动快、调试简单，也方便未来 desktop 复用 runtime。方式 B 适合 TUI 必须独立升级、隔离崩溃或使用独立权限的情况，但会增加握手、退出、错误转发和版本兼容成本。无论选择哪种方式，都不能让 apps/cli 直接 import apps/tui/src/*。voice 只是输入输出 adapter，不能因为通过 TUI 进入就获得 coding tools。

### 2.5 Session authority

Session 的事件顺序、恢复、fork、工具结果和模型调用状态必须由 coding-agent 内部 runtime 持有；外提后才由 agent-runtime/session 持有：

~~~text
CLI / TUI / Desktop / Voice IO
             │ 输入、订阅、控制
             ▼
         SDK facade
             ▼
       coding runtime / Session       <- 首期唯一事实来源
             ├── Agent loop
             ├── Session event log
             ├── Storage
             ├── Model router
             └── Tool execution
~~~

TUI 可以保存光标、滚动位置和临时输入；音频驱动可以保存播放队列和 VAD 缓冲；这些都不是 Session 的消息真相。这样同一个 coding session 才能从 CLI 继续到 TUI，或由 voice-agent adapter 继续消费。

### 2.6 Agent target registry 与按需加载

host 可以有一个很小的 target registry，但 registry 只保存 factory，不保存产品状态：

~~~ts
type HostTarget = "coding" | "voice";
type TargetFactory = () => Promise<AgentTargetRuntime>;

interface AgentTargetRuntime {
  readonly product: AgentProduct;
  readonly session: AgentSessionHandle;
  readonly voice?: VoiceInteractionHandle;
}

export function createTargetRegistry(factories: Record<HostTarget, TargetFactory>) {
  return {
    create(target: HostTarget) {
      return factories[target]();
    },
  };
}
~~~

apps/cli 和 apps/tui 在各自的 bootstrap 中以顶层 import 提供 coding factory 与 voice interaction factory，再把 composition factory 注入 registry。coding surface 创建 coding-agent session；voice surface 仍创建 coding-agent session，然后 attach voice-agent，并把 voice model 的 `toolCall` 固定为 false。CLI 启动 coding 命令时不应因为 registry 的存在就初始化麦克风、VAD 或 voice SDK；只有选中 voice surface 后才创建语音设备并注册 realtime-voice extension。TUI 使用同一个 target contract，desktop 将来可以用 SDK 的工厂而不复制一套路由。是否做 bundler 级别的 code splitting 可以单独决定，必须保留的语义是“surface 选择在 host，产品初始化在 factory”。

## 3. Step CLI 的 extensions 与 TypeScript extends

### 3.1 Step CLI 实际借鉴的是 extensions/

Step CLI 的目录名是 extensions，不是 extends。当前仓库中的参考实现包括：

- extensions/llm；
- extensions/mcp；
- extensions/lark；
- extensions/realtime-voice；
- extensions/realtime-aec；
- extensions/realtime-vad-silero；
- extensions/surface-example。

值得注意的是 Step CLI 把实时语音拆成了三个独立 extension：`realtime-voice`（厂商/传输桥接）、`realtime-aec`（回声消除）、`realtime-vad-silero`（VAD 模型）。这正好印证 §3.4 的粒度判断——它们各自依赖不同的外部原生模块和模型文件，可以独立开关和替换，所以值得拆开；而不是因为“语音”这个主题就合成一个大包。step-harness 的 `extensions/realtime-voice` 首期可以是单个 extension，等真正引入 AEC 或本地 VAD 模型时再按同样理由拆分。

其核心思想是：extension 通过稳定的 surface contract 向 core 贡献能力，由组合根预加载并注入。Step CLI 的 v2 surface 使用 StepCliExtension.contributeSurface() 贡献工具、system prompt、context policy 和 source adapter；resolver 负责校验、筛选、绑定 executor、生成最终 surface 和审计 hash。extension 可以提供 shutdown、exportState、loadState 等生命周期钩子，但不定义 Agent loop 或 Session 语义。

step-harness 可以借鉴这个边界：

~~~text
apps/cli/bootstrap
  -> 读取配置
  -> 预加载 extensions/llm、mcp、realtime-voice
  -> 创建 DialectRegistry / ToolContributor / RealtimeDriver
  -> 创建 coding-agent；voice 命令再挂载 voice-agent interaction

apps/tui/bootstrap
  -> 选择 coding surface 或 /voice surface
  -> 注册同一批稳定 extension contract
  -> 启动 @step-harness/tui-kit/runtime
~~~

扩展是否运行时动态加载不是边界的必要条件。Step CLI 当前是 host 预加载后注入 LoadedStepCliExtension[]；step-harness 也应优先采用显式静态注册，避免根据目录或字符串隐式扫描任意代码。

### 3.2 什么时候应该创建 extension

把代码放入 extensions/* 至少应有一个可验证理由：

1. 实现可以被关闭、替换或按 host 选择；
2. 依赖可选的外部 SDK、原生模块、设备或网络协议；
3. 有独立的权限、生命周期或测试矩阵（注意：当前所有 workspace 包均为 `private: true`，“独立发布节奏”不是有效判据，见 §2.1）；
4. 两个以上 host 需要通过同一个稳定 contract 使用它。

下面这些通常不应创建 extension：

- Agent loop、Session 事件和恢复语义；
- coding-agent 或 voice-agent 必需的默认规则；
- 只被一个函数调用的内部 helper；
- 为了让目录看起来对称而创建的空壳 package。

当前 packages/coding-agent/src/extensions/ 不能整体搬迁。subagent、plan、tasks 等内容要先判断是否与 AgentSession 强耦合、是否默认必需；如果是，就留在 domain/runtime module。能抽出稳定 contract 且有独立依赖或生命周期的部分，才逐步提升为 workspace extension。

### 3.3 extension、package、app 的判断表

| 判断问题 | packages/* | extensions/* | apps/* |
| --- | --- | --- | --- |
| 是所有产品都需要的核心语义吗 | 是 | 通常不是 | 只属于某个宿主流程 |
| 是否拥有进程、TTY、退出码 | 否 | 否 | 是 |
| 是否适配外部协议或设备 | 通常不直接适配 | 是 | 只负责组合 |
| 是否需要独立依赖和测试矩阵 | 可以有 | 通常有 | 有宿主验收 |
| 典型例子 | Agent loop、Session、AI contract | LLM adapter、MCP、音频驱动 | cli、tui、desktop |

不需要一个“大而全”的 BaseExtension 类。优先定义能力专用 contract，例如 DialectAdapter、ToolContributor、RealtimeDriver，再由 host 分别注册。extension 之间也不要通过内部路径互相导入。

### 3.4 LLM extension 的粒度

Step CLI 的 extensions/llm 同时容纳 OpenAI 和 Anthropic client。只要两者共享 HTTP transport、测试基础设施、发布节奏和生命周期，一个 llm package 就是合理的：

~~~text
extensions/llm/
├── package.json
├── src/
│   ├── openai-chat-completions.ts
│   ├── openai-responses.ts
│   ├── anthropic-messages.ts
│   └── index.ts
├── tests/
└── tsconfig.build.json
~~~

只有在依赖、权限、发布团队、运行时生命周期或 conformance matrix 明显分叉时，才拆成 llm-openai 和 llm-anthropic。目录拆分是证据驱动的结果，不是架构目标；也不要把“厂商”直接等同于“extension”。

### 3.5 TypeScript extends 的实际作用

如果用户说的 extends 是 tsconfig 中的 TypeScript 关键字，它只表示配置文件继承：

~~~text
tsconfig.base.json
        ▲
        │ extends
        ├── apps/cli/tsconfig.build.json
        ├── apps/tui/tsconfig.build.json
        ├── apps/desktop/tsconfig.build.json
        ├── packages/coding-agent/tsconfig.build.json
        ├── packages/voice-agent/tsconfig.build.json
        └── packages/ai/tsconfig.build.json
~~~

它适合统一：

- Node/ESM 目标和 module resolution；
- strict、declaration、sourceMap 等编译约束；
- noEmit、增量编译和测试环境的默认值；
- 新 workspace 项目的最低工程标准。

子配置可以覆盖同名字段，但 include、exclude、files、paths、references 等字段不能假设会按目录自动合并。特别是 paths 和 outDir 要在每个 package 有意识地确认，否则很容易出现本地能解析、发布后找不到的问题。建议只保留一层根基线加一层项目配置，避免多层继承让最终值难以追踪。

TypeScript extends 不会：

- 建立 npm runtime dependency；
- 注册 extension；
- 共享 Agent 或 Session 状态；
- 让 apps/cli 成为 apps/tui 的父模块；
- 让 packages/voice-agent 自动获得 coding-agent 的业务能力。

运行时依赖必须写在 package.json；公共 API 必须通过 exports 暴露。extends 解决“如何编译”，apps/packages/extensions 解决“谁拥有、如何依赖、如何运行”。

如果用户说的是类继承，例如 class VoiceAgent extends CodeAgent，也不建议用于这两个模块。voice-agent 不是 coding-agent 的子类型，而是挂载在 coding session 上的输入输出 adapter；语音输入、音频中断、播放生命周期与代码工具流的状态机不同。它们应共享 `AgentSessionHandle`、`AgentEvent` 等 contract，通过 composition 复用 agent-runtime。只有真实的“是一个”关系才适合 class inheritance。

因此，本设计不创建名为 extends/ 的目录，也不使用 TypeScript extends 伪装插件系统。

### 3.6 三种容易混淆的 extends 语义

讨论 Step CLI 的“extends 结构”时，最好先确认指的是哪一种东西：

| 写法或目录 | 所属层 | 真正作用 | 是否产生运行时行为 |
| --- | --- | --- | :---: |
| extensions/llm | 仓库目录和 workspace package | 放置可选实现，由 host 注册 | 是，前提是 host 注册 |
| tsconfig.build.json 的 extends | TypeScript 工程配置 | 继承编译选项和默认工程约束 | 否 |
| class Child extends Parent | JavaScript/TypeScript 语言机制 | 继承原型、方法和状态 | 是 |

三者没有隐含的对应关系。不能因为目录叫 extensions，就认为它需要一个父类；也不能因为多个项目 extends 同一个 tsconfig，就认为它们是父子模块。

对 tsconfig 的实际影响可以这样理解：

~~~json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests", "dist"]
}
~~~

TypeScript 先读取基线配置，再用当前项目的同名字段覆盖。include、exclude、files、references、paths、rootDir 和 outDir 必须在项目配置中逐项确认；尤其不要假设文件数组会自动拼接，也不要假设 paths 会根据目录自动改写。路径的相对基准还与配置文件位置有关，因此移动一个 app 时必须同时检查 extends 相对路径、rootDir、outDir 和 package exports。

对运行时的影响则完全不同：

~~~text
apps/cli
  import { openaiAdapter } from "@step-harness/llm"
  registry.register(openaiAdapter)
  createCodingAgentProduct({ registry })
~~~

这里的注册来自普通 import、factory 和 registry，不来自 tsconfig extends。若没有注册，extensions/llm 只是一个未加载的 package。

类继承也不应作为 coding-agent 与 voice-agent 的默认关系。只有当子类型满足“任何需要父类型的地方都可以替换为子类型”，并且共享不变量、生命周期和错误语义时，继承才有价值。coding-agent 拥有工具安全和 Agent loop，voice-agent 负责输入、打断和播报，更适合：

~~~text
coding-agent session  ──┐
                         ├── composition -> voice-agent adapter
                         └── shared -> coding runtime（外提后为 agent-runtime）/ session / ai
~~~

因此，“借鉴 Step CLI 的 extensions”是一个可选实现边界的决定；“使用 TypeScript extends”是一个编译配置的决定；“是否使用 class extends”是一个局部对象建模的决定。三者应分别评估，不能为了形式上的对称强行引入。

## 4. AI 设计：按 wire dialect，而不是按厂商

### 4.1 结论

packages/ai 应明确分离两条轴：

~~~text
ModelApiDialect / model.api
  线上请求和响应的 wire 格式，决定序列化、流解析和错误归一化。

ProviderProfileId / model.provider
  endpoint、认证、模型目录、展示名称和 telemetry 身份。
~~~

协议 dispatch 的唯一 key 是 model.api。不能使用 provider 名称选择协议：

~~~text
model.api
  openai-chat-completions -> OpenAICompatibleChatAdapter
  openai-responses         -> OpenAIResponsesAdapter
  anthropic-messages       -> AnthropicMessagesAdapter

model.provider / profileId
  openai-main              -> baseUrl + auth + catalog
  moonshot-compat          -> baseUrl + auth + catalog
  internal-anthropic       -> baseUrl + auth + catalog
~~~

同一个 adapter 可以服务多个 provider profile；同一个 profile 也可以为不同模型声明不同 dialect。

### 4.2 canonical 类型示意

~~~ts
export type ModelApiDialect =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ProviderProfileId = string;

export interface ModelRef {
  id: string;
  api: ModelApiDialect;
  provider: ProviderProfileId;
  contextWindow?: number;
}

export interface ProviderProfile {
  id: ProviderProfileId;
  label: string;
  baseUrl: string;
  authRef: string;
  catalog: string[];
  defaultApi?: ModelApiDialect;
}

export interface DialectAdapter {
  readonly dialect: ModelApiDialect;
  send(request: CanonicalModelRequest, context: AdapterContext): AsyncIterable<CanonicalModelEvent>;
}
~~~

api 是必需的协议语义；provider/profile 是配置和身份语义。历史配置只有 provider 时，可以在迁移器中推导 api，但要记录来源：

~~~text
{ api: "openai-responses", source: "declared" }
{ api: "openai-chat-completions", source: "derived-from-provider" }
~~~

派生字段只是兼容路径，不能成为新代码的 dispatch 依据。

### 4.3 三种格式的边界

| dialect | wire 边界 | 可使用的 endpoint | provider 名是否决定它 |
| --- | --- | --- | :---: |
| openai-chat-completions | chat/completions 请求、SSE chunk 和 tool call | OpenAI-compatible 网关 | 否 |
| openai-responses | responses input/output item 和事件流 | OpenAI Responses 或兼容网关 | 否 |
| anthropic-messages | messages content block 和事件流 | Anthropic-compatible 网关 | 否 |

Moonshot、DeepSeek 或内部网关只要遵循 OpenAI Chat Completions，就选择第一个 dialect；名称只进入 profile 和 telemetry。遵循 Anthropic Messages 的内部网关同理。

### 4.4 请求分发

~~~ts
const profile = providerRegistry.get(model.provider);
const adapter = dialectRegistry.get(model.api);

if (!profile || !adapter) {
  throw new ModelConfigurationError({
    modelId: model.id,
    provider: model.provider,
    api: model.api,
  });
}

return adapter.send(
  canonicalRequest,
  createAdapterContext({ profile, model }),
);
~~~

核心 Agent 不应该出现按 provider 名选择 adapter 的分支。

### 4.5 packages/ai 与 extensions/llm 的分工

推荐分三层：

~~~text
packages/ai
  Canonical request/event
  ModelApiDialect 和 ProviderProfile 类型
  DialectRegistry / ProviderRegistry
  authRef、catalog、配置迁移和错误模型

extensions/llm
  OpenAI Chat Completions adapter
  OpenAI Responses adapter
  Anthropic Messages adapter
  外部 SDK、HTTP 细节和 wire conformance fixtures

packages/coding-agent/src/core（首期）
  按 model.api 请求 registry，并完成 coding session 装配
  不知道某个 URL 属于哪家厂商

packages/agent-runtime（后续可选）
  只有在装配 contract 稳定且有多个消费者时，才承接上面的中立部分
~~~

如果当前实现规模还不足以单独维护 extensions/llm，可以先把 adapter 作为 packages/ai/src/adapters/* 的内部模块；先固定 dialect contract，再根据可选依赖和发布边界外提。物理目录的先后不应改变协议的正交模型。

### 4.6 Voice 模型的能力边界

voice model 与 coding model 是两个用途不同的模型配置，不代表两个 Agent loop。voice model 只负责语音侧的识别、转述或播报相关任务，必须声明 `toolCall: false`；coding model 才进入 coding-agent 的 runtime（首期位于 coding-agent 内部，外提后才成为 `agent-runtime`）并携带 coding tools。组合层应在发送请求前剥离 tools，并在 adapter 层拒绝任何意外的 tool-call 事件。

~~~text
voice input
  -> ASR / voice model (toolCall = false)
  -> canonical AgentInput
  -> coding model + coding tools
  -> AgentEvent / tool result
  -> TTS / voice model (toolCall = false)
~~~

voice-agent 可以根据 turn-taking 规则决定何时提交一轮输入、何时打断播报，但不能改变 coding session 的模型、工具权限或 Session 事件顺序。若将来增加纯语音闲聊，使用不带工具的独立 session policy，并在命令层明确选择，不把它隐式混入 `/voice` 的 coding 模式。

#### 4.6.1 权限审批事件在语音 surface 上的归属

`toolCall: false` 只约束了 voice model 自己不发起工具调用，没有回答另一半问题：**coding session 发出的权限审批请求，在语音 surface 上由谁应答。** 这是 `/voice` 落地时第一个会撞上的问题——用户说“帮我把测试跑一遍”，coding model 决定调用 bash，session 发出 approval 请求，此时如果没有约定，语音通道要么静默挂起，要么由 voice-agent 擅自放行（等于绕过权限模型）。

约束如下：

- 审批请求是 coding session 的事件，**权限决策权始终属于 host（composition root），不属于 voice-agent**。voice-agent 只负责把请求播报出去、把用户的语音回应转成 canonical 输入，不得自行构造 approval 响应；
- voice-agent 必须能识别 `AgentEvent` 中的审批/权限类事件并显式处理，**不允许落到 default 分支被静默丢弃**。收到未知类型的阻塞性事件时，行为是上报给 host 并暂停播报，而不是继续下一轮；
- 首期默认策略取 **降级到文本确认**：语音播报“需要确认执行 X”，实际的 yes/no 由 host 在文本/TTY surface 上收集。原因是语音识别的误判代价与权限授予的不可逆性不匹配，不应把 ASR 置信度直接当成授权信号；
- 若后续要支持纯语音确认，需要额外满足：审批文案可完整播报（含命令原文）、有明确的确认词表与拒绝词表、ASR 置信度低于阈值时回退到文本、且整个交互记入 session 事件日志可供回放审计。这是一条独立特性，不随 `/voice` 一起交付；
- 非阻塞的通知类事件（如工具已完成、输出摘要）可以由 voice-agent 自行决定是否播报和如何截断，不受上述约束。

验收（并入 §14.2）：`/voice` 期间触发一次 bash 审批，必须能观察到播报 + host 侧收敛的确认路径，且未经确认时工具不执行。

### 4.7 AI 验收测试

- 每个 dialect 都有请求快照、流事件和错误归一化 conformance test；
- 同一个 OpenAI adapter 至少覆盖两个不同 baseUrl/profile；
- provider profile 改名不能改变协议 dispatch；
- 显式 api 优先于旧 provider 推导；
- core 代码中不出现按 provider 名选择 adapter 的分支；
- trace 记录 dialect、profileId 和 adapter 版本，但不泄露密钥；
- OpenAI-compatible gateway 可以不引入 OpenAI 官方 SDK；
- Anthropic-compatible gateway 可以复用 Messages adapter。

### 4.8 与 Step CLI provider 设计的对应

可以把 Step CLI 的 provider/client 分层映射到 step-harness，但不要照搬厂商名称作为分支条件：

| Step CLI 中的概念 | step-harness 中的对应 | 负责什么 |
| --- | --- | --- |
| Provider 的 endpoint、auth、model catalog | ProviderProfile | 连接到哪里、用什么凭据、有哪些模型 |
| OpenAICompatibleClient | OpenAI Chat Completions dialect adapter | 如何编码 chat 请求、解析 SSE chunk 和 tool call |
| OpenAI endpointKind=responses | OpenAI Responses dialect adapter | 如何编码 responses item 和事件流 |
| AnthropicMessagesClient | Anthropic Messages dialect adapter | 如何编码 content block 和 Anthropic 事件 |
| provider registry | ProviderRegistry + DialectRegistry | 分别查找 profile 和 wire adapter |

Step CLI 的 OpenAI-compatible client 可以服务不同 base URL；Anthropic client 也可以服务兼容 Messages 的网关。这正是本设计要保留的复用方式。新增一个服务商时，优先新增 ProviderProfile；只有对端 wire 格式不同，才新增 dialect adapter。

推荐的装配顺序是：

~~~text
读取 provider profile
  -> 读取模型的显式 api
  -> 通过 api 查找 DialectAdapter
  -> 将 profile、model 和 authRef 组成 AdapterContext
  -> 发送 canonical request
~~~

这样 coding-agent 依赖 canonical AI contract 并选择 coding model；voice-agent 只在需要语音转写或播报时使用相应的模型能力，不能把 voice model 当作工具调用的 Agent。两者都不需要知道某个 profile 背后的厂商 SDK。

## 5. 方案一：Kimi 式完整 Host-centric monorepo

### 5.1 结构

方案一一次性把 host、两个领域包和共享 engine 全部拆清：

~~~text
step-harness/
├── apps/
│   ├── cli/                         # [新建+抽出] 由 coding-agent 入口和 modes 迁移
│   │   └── src/
│   │       ├── main.ts
│   │       ├── commands/
│   │       ├── modes/
│   │       └── bootstrap/
│   ├── tui/                         # [新建+抽出] interactive host；复用 packages/tui
│   │   └── src/
│   │       ├── main.ts
│   │       ├── commands/
│   │       └── projection/
│   └── desktop/                     # [全新] 当前无桌面宿主
│       └── src/main.ts
├── packages/
│   ├── coding-agent/src/             # [保留+瘦身] 当前 coding-agent 产品代码
│   ├── voice-agent/src/              # [全新] 语音 interaction；无当前 Agent loop
│   ├── agent/src/                    # [保留] 当前通用 Agent loop
│   ├── agent-runtime/                 # [后续抽出，首期不创建] coding-agent/core runtime 的中立部分
│   │   └── src/
│   ├── session/src/                  # [新包+抽出] coding-agent 的 session-manager/entry 语义
│   ├── ai/src/                       # [保留+重组] 当前 ai 的 api/providers
│   ├── tools/src/                    # [新包+抽出] coding-agent core/tools 和 bash/tool-profile
│   ├── sdk/src/                      # [新 facade+抽出] coding-agent core/sdk、step/sdk
│   ├── tui/src/                      # [保留+重组] 当前 packages/tui，新增内部 runtime
│   │   ├── renderer/
│   │   └── runtime/
│   ├── realtime/src/                 # [全新] 实时音频/VAD/interrupt contract
│   ├── contracts/src/                # [新建/重建] JSONL/SDK contract；不是 CBOR protocol 搬名
│   ├── config/src/                   # [新包+抽出] coding-agent config/settings/stepcode
│   └── telemetry/src/                # [保留] 当前 packages/telemetry
└── extensions/
    ├── llm/src/                     # [抽出+重组] packages/ai 的 wire adapters
    ├── mcp/src/                     # [新建+抽出] step/plugins 声明及未来 MCP bridge
    └── realtime-voice/src/           # [全新] 外部音频设备/厂商桥接
~~~

### 5.2 入口和依赖

apps/cli/src/commands/step.ts 解析参数后选择 coding-agent；voice.ts 创建同一个 coding session，再挂载 voice-agent interaction。首期两者都通过 coding-agent 内部 runtime 创建 Session，满足触发条件后才改为调用 `agent-runtime`。interactive 模式转给 `@step-harness/tui-kit/runtime`，print/json/rpc/sdk-stdio 留在 CLI host。

apps/tui/src/main.ts 只负责 TTY 生命周期、键盘事件和 projection；它通过 `@step-harness/tui-kit/runtime` 订阅 coding AgentEvent，`/voice` 时额外挂载 voice-agent，不直接操作 Session storage。desktop 未来通过 sdk 调用同一套 product facade。

### 5.3 优点

- 最清楚地表达“入口宿主”和“Agent 产品”是两条轴；
- coding product 和 voice interaction 可以被同一个 CLI/TUI/desktop 组合；
- runtime、Session、AI 和工具可以独立测试和发布；
- 删除 CBOR 或替换 LLM adapter 时影响范围容易审计；
- 适合最终需要 Web、IDE、ACP 或多个桌面宿主的团队。

### 5.4 代价与风险

- 一次迁移的 import、exports、build、测试和 bundle 改动最多；
- 如果 API 还不稳定，过早拆 package 会制造 facade 和循环依赖；
- TUI 当前实现可能需要先拆成 product projection 与通用渲染两部分；
- 每个 package 都需要维护 manifest、tsconfig、release 和测试入口。

### 5.5 适用条件

适合已经有明确 owner、能接受较大迁移窗口，并且短期内确实会让多个 host 同时承载 coding-agent 和 voice interaction 的情况。

## 6. 方案二：Step 风格聚合 runtime + 薄 Host apps

### 6.1 结构

方案二先把 apps 做成薄壳，保留较大的 runtime facade，减少第一阶段的 package 数量：

~~~text
step-harness/
├── apps/
│   ├── cli/                         # [新建+抽出] coding-agent 的入口和 headless modes
│   │   └── src/
│   │       ├── main.ts
│   │       ├── commands/
│   │       └── modes/
│   ├── tui/                         # [新建+抽出] interactive host，复用 packages/tui
│   │   └── src/
│   │       └── main.ts
│   └── desktop/                     # [全新] 当前无桌面宿主
│       └── src/main.ts
├── packages/
│   ├── coding-agent/               # [保留+瘦身] 当前产品包，暂持有 core facade
│   │   └── src/
│   ├── voice-agent/                # [全新] interaction facade，不复制 Agent loop
│   │   └── src/
│   ├── agent-runtime/              # [后续抽出，首期不创建] 由 coding-agent 内部 runtime 承担
│   │   └── src/
│   ├── ai/                         # [保留+重组] 当前 packages/ai
│   │   └── src/
│   ├── tools/                      # [新包+抽出] 当前 coding-agent core/tools（可延后）
│   │   └── src/
│   ├── tui/                        # [保留+重组] 当前 packages/tui
│   │   └── src/
│   │       ├── renderer/            # 复用的终端渲染原语
│   │       └── runtime/             # 交互编排
│   ├── realtime/                   # [全新] 需要实时语音时才创建
│   │   └── src/
│   └── telemetry/                  # [保留] 当前 packages/telemetry
│       └── src/
└── extensions/
    └── llm/                        # [抽出+重组] 先从 packages/ai 的 api 验证
        └── src/
~~~

### 6.2 入口和依赖

~~~text
apps/cli/src/main.ts
  -> commands/step.ts
  -> packages/coding-agent.createProduct()
  -> coding-agent 内部 createSession()（首期）
  ->（满足触发条件后）packages/agent-runtime.createSession()

apps/cli/src/main.ts
  -> commands/voice.ts
  -> packages/coding-agent.createProduct()
  -> coding-agent 内部 createSession()（首期）
  ->（满足触发条件后）packages/agent-runtime.createSession()
  -> packages/voice-agent.createInteraction(session)

apps/tui/src/main.ts
  -> @step-harness/tui-kit/runtime
  -> coding-agent session
  ->（/voice）voice-agent interaction
~~~

packages/coding-agent 可以暂时继续持有当前 core/agent-session-runtime.ts、modes facade 和 Step 配置兼容层，但它不再声明 step/pi bin，也不再接受新的宿主入口职责。packages/voice-agent 只提供 interaction facade，由 host 或 runtime 注入 coding session，不能复制一套 Agent loop 或工具权限。

方案二首期把 contracts、config 和 Session 装配留在 `coding-agent` 内部模块，通过 facade 对 host 暴露；抽取时机按 §0.5 的触发条件判断，没有这些证据时不要求创建 `packages/agent-runtime`。物理持久化继续由 `packages/agent` 和现有 `session-backends/sqlite-node` 提供；只有出现第二个存储消费者且 adapter contract 稳定时，才创建 `packages/storage`（理由见阶段 5）。

### 6.3 优点

- 首次变更少，现有 Step 行为更容易保持；
- 可以先验证 apps/cli 和 apps/tui 的 bin、构建和 smoke test；
- voice-agent 能以平级 package 加入，而不要求立即拆完所有 coding-agent 内部文件；
- 适合需要快速建立目录边界的阶段。

### 6.4 代价与风险

- agent-runtime 可能长期变成新的“大包”；
- coding-agent facade 容易继续吸收新功能，边界冻结必须写进 review 规则；
- 共享 package 的 API 可能只是旧内部类型的转发，难以保证稳定；
- 未来 desktop 或第三方 SDK 需要更多抽取时仍要做第二轮迁移。

### 6.5 适用条件

适合当前只有一个主要 CLI、需要保留 pi 兼容和快速降低入口风险的团队。它是有效的过渡结构，但不应把聚合 facade 当成最终边界。

## 7. 方案三：分阶段 Host/Product split（宿主与产品分层，推荐）

### 7.1 结构

方案三采用目标树的层级，但把 package 拆分节奏交给依赖和测试证据：

~~~text
step-harness/
├── apps/
│   ├── cli/                         # [新建+抽出] coding-agent 的入口和 modes
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── commands/
│   │       │   ├── step.ts
│   │       │   ├── voice.ts
│   │       │   └── shared.ts
│   │       ├── modes/
│   │       │   ├── print.ts
│   │       │   ├── json.ts
│   │       │   ├── rpc.ts
│   │       │   └── sdk-stdio.ts
│   │       └── bootstrap/
│   ├── tui/                         # [新建+抽出] TTY host，复用 packages/tui
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── commands/
│   │       ├── projection/
│   │       └── bootstrap/
│   └── desktop/                     # [全新，后续] 当前无桌面宿主；首期只预留位置，不建 manifest
│       ├── package.json             # [后续]
│       └── src/main.ts              # [后续]
├── packages/
│   ├── coding-agent/                # [保留+瘦身] 当前产品包；保留 prompt/tools/permissions
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── product.ts
│   │       ├── prompt/
│   │       ├── tools/
│   │       ├── permissions/
│   │       └── compatibility/
│   ├── voice-agent/                 # [全新] 语音 interaction；不拥有 Agent loop
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── interaction.ts
│   │       ├── turn-taking/
│   │       ├── prompt/
│   │       └── audio-session.ts
│   ├── agent-runtime/               # [后续抽出，首期不创建] coding-agent/core runtime 的中立部分
│   │   └── src/
│   ├── agent/src/                   # [保留] 当前通用 Agent loop
│   ├── session/src/                 # [新包+抽出] coding-agent session-manager/entry
│   ├── ai/src/                      # [保留+重组] 当前 packages/ai
│   ├── tools/src/                   # [新包+抽出] coding-agent core/tools（按需）
│   ├── sdk/src/                     # [新 facade+抽出] coding-agent core/sdk、step/sdk
│   ├── tui/src/                     # [保留+重组] 当前 packages/tui
│   │   ├── renderer/
│   │   └── runtime/
│   ├── realtime/src/                # [全新] 实时音频/VAD/interrupt contract
│   ├── contracts/src/               # [新建/重建] JSONL/SDK contract，非 CBOR 搬名
│   ├── config/src/                  # [新包+抽出] coding-agent config/settings/stepcode
│   └── telemetry/src/               # [保留] 当前 packages/telemetry
├── extensions/
│   ├── llm/src/                    # [抽出+重组] packages/ai 的 wire adapters
│   ├── mcp/src/                    # [新建+抽出] step/plugins 声明及未来 bridge
│   └── realtime-voice/src/          # [全新] 音频设备/厂商桥接
└── docs/
~~~

第一阶段让 coding-agent/src/compatibility/ 通过旧 core facade 工作，`AgentSessionRuntime` 仍留在 coding-agent；随着 contract 稳定且出现共享消费者，再把中立实现移动到 agent-runtime、session、storage 和 ai。树中的 agent-runtime 与 storage 都是后续形状，迁移过程中不要求第一天创建它们。

### 7.2 推荐入口链路

~~~text
step
  -> apps/cli/src/main.ts
  -> commands/step.ts
  -> choose target = coding
  -> packages/coding-agent/src/index.ts
  -> createCodingAgentProduct()
  -> coding-agent 内部 runtime / session / ai / tools（满足条件后再外提 agent-runtime）
  -> mode = interactive ? @step-harness/tui-kit/runtime : CLI mode

step voice
  -> apps/cli/src/main.ts
  -> commands/voice.ts
  -> choose surface = voice
  -> register extensions/realtime-voice
  -> packages/coding-agent/src/index.ts
  -> createCodingAgentProduct()
  -> coding-agent 内部 runtime / realtime / ai / session（满足条件后再外提 agent-runtime）
  -> packages/voice-agent.createInteraction(codingSession)

step-tui code
  -> apps/tui/src/main.ts
  -> command surface = coding
  -> @step-harness/tui-kit/runtime
  -> packages/coding-agent

step-tui voice
  -> apps/tui/src/main.ts
  -> command surface = voice
  -> @step-harness/tui-kit/runtime
  -> packages/coding-agent session
  -> packages/voice-agent interaction
~~~

voice-agent 的音频采集、播放、VAD、WebRTC 或厂商 SDK 不写入 apps/cli，也不直接写进 voice-agent 的核心语义；它们通过 packages/realtime 的中立类型和 extensions/realtime-voice 的实现接入。TUI 可以展示 coding Agent 的文本事件、控制录音并挂载 voice interaction，但不因为能够切换 `/voice` 就变成 voice-agent 的父包。

packages/voice-agent 可以拥有 turn-taking、语音 prompt 和 audio-session 的领域编排，但不拥有 coding tools、独立 Agent loop、麦克风设备句柄、进程信号处理或 TTY 初始化；这些属于 coding session、host 或 realtime extension。

### 7.3 为什么方案三最适合当前仓库

- 它准确表达当前运行模型：只有 CLI/TUI 命令进入 coding-agent，voice surface 再挂载 voice-agent；
- 它让 coding-agent 和 voice-agent 保持平级的 package 边界，避免 app-to-app import；
- 它保留当前 coding-agent 的渐进迁移窗口，不要求一次性重写；
- 它能在产品包稳定前先落地 host 边界和 AI dialect contract；
- 它为 desktop 预留了清晰入口，不需要把 desktop 逻辑塞进 CLI；
- 它把 Step CLI extensions 的借鉴限制在真正的可选集成边界；
- 它允许删除 CBOR、替换 provider adapter 和增加语音设备时分别回滚。

### 7.4 方案三的风险控制

迁移期必须冻结三条规则：

1. packages/coding-agent 不再新增 bin、argv 解析和 TTY 初始化；
2. 新的跨产品能力先进入 coding-agent 内部模块；只有出现第二个消费者并冻结 contract 后，才外提到 agent-runtime、session、ai、tools、sdk 或明确的 extension；
3. apps/cli 和 apps/tui 不得通过相对路径访问对方或 coding-agent/voice-agent 的内部 src。

每次抽取都先增加 facade contract 和 conformance test，再移动实现。不要先移动文件、最后才猜公共 API。

## 8. 三种方案对比

| 维度 | 方案一：一次性完整拆分 | 方案二：聚合 runtime + 薄 host | 方案三：分阶段 Host/Product（宿主与产品分层，推荐） |
| --- | --- | --- | --- |
| apps 层级是否符合 cli/tui/desktop | 是 | 是 | 是 |
| coding-agent/voice-agent 是否为平级 package | 是 | 是 | 是 |
| 首次迁移成本 | 高 | 低 | 中 |
| 当前行为回归风险 | 中高 | 最低 | 中低 |
| 最终 package 清晰度 | 高 | 中 | 高 |
| 对旧 coding-agent 的兼容 | 需要 shim | 最好 | 有明确过渡 |
| TUI 复用方式 | `packages/tui` 的 runtime 子模块 | `packages/tui` 的 runtime 子模块 | `packages/tui`，按证据决定是否下沉到 apps/tui |
| AI dialect/provider 正交化 | 一次完成 | 先包内后外提 | contract 先行、实现渐进 |
| voice-agent 接入 | coding session + voice interaction 直接组合 | 依赖大 facade | 平级 package + realtime contract + composition |
| desktop 扩展 | 直接消费 SDK | 后续需要拆 facade | 预留且不影响 CLI |
| 推荐用途 | 有大型迁移窗口 | 只求短期降风险 | 当前主线和长期目标 |

方案三不是第三种目录风格，而是把最终边界和迁移节奏同时设计进去。它可以在阶段 2 看起来接近方案二，完成阶段 4 后逐步接近方案一。

## 9. step、pi 与 host bin 的决策

### 9.1 新的 bin 所有权

step 应由 apps/cli 拥有：

~~~text
apps/cli/package.json
  bin.step -> dist/main.js

apps/tui/package.json
  bin.step-tui -> dist/main.js（如果需要独立 TUI 命令）

packages/coding-agent/package.json
  不声明 step 或 pi bin

packages/voice-agent/package.json
  不声明 voice-agent bin
~~~

voice-agent 是语音交互领域包，而不是独立进程或第二个 tool-calling Agent。只有未来明确要单独发布一个 voice-agent 可执行产品时，才另建一个专门的 host app；当前阶段不预先创建按产品命名的语音 host。

### 9.2 pi 兼容

迁移期可以让 apps/cli 临时声明两个 bin：

~~~json
{
  "bin": {
    "step": "dist/main.js",
    "pi": "dist/pi-compat.js"
  }
}
~~~

pi-compat.ts 只负责旧参数和旧配置转换，然后调用同一个 runtime facade。它不拥有第二套 Agent loop，也不应继续往 packages/coding-agent 添加新的 Step 功能。

如果产品不再承诺 pi，则在外部消费者扫描、发布说明和 smoke test 完成后删除 pi bin、兼容入口和对应 bundle。是否保留 pi 不影响 coding-agent/voice-agent 的平级关系。

### 9.3 命令目标矩阵

| 命令入口 | host | target product | 输出/设备 |
| --- | --- | --- | --- |
| step | apps/cli | coding-agent | interactive、print、json、rpc |
| step voice | apps/cli | coding-agent + voice-agent interaction | 音频设备 + coding 文本/工具事件 |
| step-tui code | apps/tui | coding-agent | TTY projection |
| step-tui voice | apps/tui | coding-agent + voice-agent interaction | TTY 控制 + realtime extension |
| desktop code（未来） | apps/desktop | coding-agent | 桌面事件 |
| desktop voice（未来） | apps/desktop | coding-agent + voice-agent interaction | 桌面音频和 coding 事件 |

实际命令名称可以根据现有 UX 调整；重要的是 target 由 host 选择，domain package 不反过来拥有 host。

## 10. CBOR 删除与入口迁移分开

删除指南已经区分了三条协议或执行路径：

- CBOR 远程会话：packages/client、packages/server、packages/protocol 以及 coding-agent/src/client；
- 本地或子进程 JSONL：modes/rpc、rpc-entry、subagent；
- Step sdk-stdio：长度前缀 JSON 的 stdio-host；
- 本地 harness：server/create-harness.ts。

如果产品不再提供远程 CBOR，建议作为独立、可回滚的变更：

~~~text
1. 扫描外部消费者是否使用 ./client export
2. 删除 packages/coding-agent/src/client 和 client/server/protocol 消费者
3. 清理 package.json exports、依赖、path alias、bundle 和 lockfile
4. 保留 modes/rpc、rpc-entry、step/stdio、subagent 和本地 create-harness
5. 单独运行 JSONL、sdk-stdio、interactive、print、json smoke test
~~~

不要因为文件名含有 client、server 或 remote 就删除正常的 JSONL RPC。CBOR 处理不应和 AI provider 改名绑成一个不可回滚的大提交。

关于时机：虽然 CBOR 删除在技术上与 host 迁移互不依赖，**但应该尽早做，排在入口外移之前**。理由是它能显著缩小后续每个阶段的搬迁面：

| 收益 | 具体变化 |
| --- | --- |
| workspace 数量 | 10 → 7（去掉 client/server/protocol；保留 session-backends/sqlite-node） |
| coding-agent 依赖 | 去掉 `@earendil-works/pi-client`、`@earendil-works/pi-protocol` |
| coding-agent exports | 去掉 `./client` 子路径 |
| 根 build 脚本 | 少 3 段 `cd ../x && npm run build` |
| bundle 脚本 | 少一个 `client` entry 和一次 dist 存在性检查 |
| 根 tsconfig | 少 6 条 CBOR alias |
| local-release 发布列表 | 少 3 条 |
| 待迁移的 `src/` 顶层目录 | 少一个 `client/` |

删除指南已经把 CBOR 这条链路论证为完全独立、可回滚，并给出了逐项引用清单和核对命令。`session-backends/sqlite-node` 与 CBOR 无关，是否保留属于备用存储的独立产品决策，不与入口迁移绑定；本设计先保留它，并把未来的统一存储 adapter 作为证据触发的后续抽取。先删 CBOR 再搬入口，阶段 2～4 要处理的文件、依赖和脚本都更少；反过来先搬后删，等于把这些引用在新旧两个位置各改一遍。

## 11. 推荐迁移计划

阶段顺序遵循两条原则：**能减少后续工作量的先做**（所以 CBOR 删除排在入口外移之前），**能独立回滚的单独成阶段**（所以 AI 正交化、voice 接入各自独立）。若选择统一包管理器，那是所有阶段之前的“阶段 -1”，见 §0.1。

### 阶段 0：冻结边界，保持行为不变

- 在 workspace 定义中增加 apps/*、extensions/* glob（注意保留现有的 5 个 example extension 成员，见 §13.6）；
- 创建 apps/cli、apps/tui 的 manifest 和最小 src/main.ts；**不创建 apps/desktop**，它只在目标树中预留位置；
- 创建 packages/coding-agent/src/index.ts 和 packages/voice-agent/src/index.ts 的 facade 约定，其中后者导出 voice interaction 而不是独立 Agent loop；
- 给每个 workspace 项目增加 tsconfig.build.json、exports、typecheck 和 smoke script；
- 增加依赖检查，禁止 packages -> apps、app-to-app 深层 import，以及中立包反向依赖 Agent 侧包；
- 冻结 packages/coding-agent 新增入口职责。

验收：现有 step --help、interactive、print、json、rpc、sdk-stdio、subagent 行为不变；`npm run check` 全绿（含 biome、pinned-deps、ts-imports、shrinkwrap、install-lock、tsgo、browser-smoke）。

### 阶段 1：独立删除远程 CBOR

按删除指南 §5～§6 执行，先剪断消费者、再删被依赖包、最后收口 lockfile：

~~~text
1. 扫描外部消费者是否使用 ./client export
2. 删除 packages/coding-agent/src/client/ 与 test/client/
3. 清理 coding-agent 的 package.json（deps、exports、build:binary）、
   tsconfig.build.json paths、vitest.config.ts alias
4. 修改 scripts/browser-smoke-entry.ts、profile-coding-agent-node.mjs、
   build-coding-agent-bundle.mjs、local-release.mjs
5. 删除 packages/client → packages/server → packages/protocol（protocol 最后）
6. 修改根 package.json 的 build / build:offline 与根 tsconfig.json 的 6 条 alias
7. 重新生成 lockfile、npm-shrinkwrap.json、install-lock
8. 更新 docs/ 下描述 protocol/client/server 的文档
~~~

保留：`modes/rpc`、`rpc-entry.ts`、`step/stdio*.ts`、`extensions/subagent/`、`src/server/create-harness.ts`（是 AgentHarness 工厂，不是 CBOR server）、`packages/agent` 的 `jsonl.ts` / `memory.ts` / `harness/session/testing/`，以及 `packages/session-backends/sqlite-node`（备用存储，与 CBOR 无关）。

验收：`rg 'PiClient|PiServer|RemoteSession|encodeCbor|decodeCbor|PROTOCOL_VERSION'`（排除 docs）命中为 0；JSONL rpc、sdk-stdio、interactive、print、json 各跑一次 smoke；`npm run build` 从头跑通；`npm run check` 全绿。该阶段可单独 revert，不影响后续入口迁移。

### 阶段 2：把 CLI 入口移到 apps/cli

新增：

~~~text
apps/cli/src/main.ts
apps/cli/src/commands/step.ts
apps/cli/src/commands/voice.ts
apps/cli/src/bootstrap/
~~~

main.ts 负责 argv、退出码和最终清理；step.ts 暂时调用 packages/coding-agent 的兼容 facade；voice.ts 创建 coding session 后挂载 voice-agent 的最小 interaction facade。`step-bootstrap.ts` 的 host 启动引导部分并入 `apps/cli/src/bootstrap/`，`step-cli-runtime.ts` 的产品装配部分留在 coding-agent。旧 packages/coding-agent/src/step-cli.ts 可以保留为 deprecated shim，直到外部消费者完成切换。

**这一阶段的真实工作量不止移动源文件。** 入口位置是被三套构建产物硬编码的，必须同步修改：

| 需要改的地方 | 当前状态 | 阶段 2 要做什么 |
| --- | --- | --- |
| `scripts/build-coding-agent-bundle.mjs` | esbuild 打包器，硬编码 `codingAgentDir`、`aiDistDir`、`bundleDir = dist/bundle` 和 entry 列表（`cli`、`step`、`rpc-entry` 等），带 `lazy-jiti-transform`、`https-proxy-agent-named-export` 两个自定义插件和 `allowedExternalPackages` 白名单 | 参数化包目录，把 entry 指向 `apps/cli/src/*`；插件与 external 白名单逻辑不变 |
| `packages/coding-agent` 的 `build:binary` | `bun build --compile` 编译 `src/bun/cli.ts` 和 `src/bun/step-cli.ts` 产出 `dist/pi` / `dist/step-bin`，前面串了 6 个 `npm --prefix ../x run build` | bun 入口随 `src/bun/` 一起迁到 `apps/cli`，前置构建串改为 workspace filter |
| `scripts/build-binaries.sh` / `build:binary` | `bun build --compile` 硬编码编译的 entry 路径 | 入口指向 `apps/cli/dist/bun/step-cli.js`（这才是入口迁移的落点） |
| `infra/release/release-targets.json` | 只声明各产物的 `id`/`archiveType`/`binary`（bin 文件名），不含来源/入口路径，当前无消费者 | 无需改动（入口迁移不涉及它） |

另外 `packages/coding-agent/tsconfig.build.json` 采用的是“对着兄弟包的 `dist/*.d.ts` 编译”模式（例如 `"@earendil-works/pi-tui": ["../tui/dist/index.d.ts"]`），新建的 `apps/cli/tsconfig.build.json` 需要沿用同一模式并补齐相对路径，否则构建顺序会失效。

回滚方式：保留 `packages/coding-agent/src/step-cli.ts` shim 与旧 bundle entry 一个版本周期，回滚时把根 step script、bundle entry 和 `scripts/build-binaries.sh` 的编译 entry 三处一起指回旧入口（`release-targets.json` 不含入口路径，无需切换）。这不涉及 runtime 逻辑，但**不是单点回滚**，三处必须同时切换。

### 阶段 3：把 TUI 入口移到 apps/tui

- 将终端备用屏、键盘、resize、退出恢复和 projection 的 host 责任放进 apps/tui；
- 将可被 CLI 和 TUI 共同调用的编排放到 packages/tui/src/runtime，与 renderer 共用一个 workspace package；
- apps/cli 的 interactive mode 调用 `@step-harness/tui-kit/runtime`，不导入 apps/tui/src；
- 为 coding 和 voice 各建立一个最小 TUI target fixture；
- 明确 CLI 与 TUI 选择 Agent 的 contract。

如果 CLI 不需要进程内复用交互编排，则把 runtime 留在 apps/tui/src/runtime，不要为了目录对称再创建独立 package。如果必须独立进程运行 TUI，使用 JSONL/stdio contract；不要建立 app-to-app 的 TypeScript 私有依赖。

### 阶段 4：迁移 coding-agent 产品逻辑

按责任移动，而不是按目录名称整体搬运：

~~~text
coding-agent/src/step-cli.ts
  -> apps/cli/src/main.ts + commands/step.ts

coding-agent/src/step/*
  -> apps/cli/src/step-support/*
  或 packages/coding-agent/src/compatibility/*

coding-agent/src/cli/*
  -> apps/cli/src/commands/* 的 host 相关部分

coding-agent/src/modes/print-mode.ts、json-event.ts
  -> apps/cli/src/modes/*

coding-agent/src/modes/interactive/*
  -> apps/tui/src/projection/*
  + packages/tui/src/runtime/*

coding-agent/src/core/agent-session-runtime.ts
  -> coding-agent/src/core（首期保留）
  -> packages/agent-runtime/src/*（满足触发条件后）

coding-agent/src/core/session-manager*.ts
  -> packages/session/src/* 或 agent-runtime facade
~~~

产品 prompt、Step 默认工具和权限策略仍归 packages/coding-agent；通用 Session 和 Agent loop 不归 apps/cli。

### 阶段 5（按证据）：抽取 runtime、session、storage、sdk

只有阶段 2～4 已经产生第二个消费者、重复装配或外部 SDK 需求时，才执行这一阶段。先定义稳定 facade，再逐个迁移实现；否则继续使用 coding-agent 内部模块：

~~~text
packages/agent-runtime（满足条件后才创建）
  createAgentSessionRuntime()
  AgentRuntimeHost

packages/coding-agent/src/core（首期）
  AgentSessionRuntime
  createAgentSessionRuntime()

packages/session
  SessionId、SessionEvent、append、replay、fork、resume

packages/agent（现有）
  SessionRepo contract、JsonlSessionRepo、MemorySessionRepo
  harness/session/testing 的 conformance 套件

packages/storage（满足第二个存储消费者后才创建）
  StorageAdapter contract
  JsonlStore / SqliteStore / lock / cache facade

packages/sdk
  createAgentClient()
  send、steer、followUp、interrupt、subscribe、close
~~~

各包的职责边界：

- agent 负责 loop 和工具调用时序，同时持有 `SessionRepo` contract 与 JSONL/memory 两个实现；现有 `session-backends/sqlite-node` 作为备用 backend 保留；
- session 负责事件语义，不决定物理存储形态；
- storage 只有在第二个存储消费者、独立生命周期或稳定 adapter contract 出现后才创建，届时收拢 JSONL/SQLite 适配，不改变 Session 事件语义；
- sdk 负责稳定 facade 和订阅，不实现 Agent loop；
- app 和 TUI 只调用 sdk/runtime facade。

> **为什么首期不抽 `packages/storage`。** 持久化实现当前就在 `packages/agent/src/harness/session/`（`jsonl.ts`、`memory.ts`），conformance 套件在同目录的 `testing/`，并由 agent 自己的测试消费；`session-backends/sqlite-node` 作为备用 backend 与 CBOR 无关，继续保留。首期只有一个主要存储消费者时，把这些实现搬出去只会增加 manifest、exports 和依赖边；等第二个宿主或独立存储进程真正需要复用，并且 adapter contract 能独立测试时，再创建 `packages/storage`。

### 阶段 6：实施 AI dialect/provider 正交化

1. 在 Model 中把 api 设为显式首选字段；
2. 引入 ProviderProfileId，旧 provider 作为兼容字段；
3. 增加 resolveModelApiDialect，记录 declared 或 derived 来源；
4. 将 switch(provider) 改为 DialectRegistry 查找；
5. 为 OpenAI Chat、OpenAI Responses、Anthropic Messages 建立 conformance fixture；
6. 先在 packages/ai 内验证 adapter，再按依赖证据外提 extensions/llm；
7. 最后再考虑拆 contract/router package。

### 阶段 7：加入 voice-agent

1. 在 packages/realtime 定义 audio frame、turn、interrupt、VAD 和 capability；
2. 将音频采集、播放和厂商桥接放入 extensions/realtime-voice；
3. 完善 packages/voice-agent/src/interaction.ts 和 audio-session.ts；
4. 让 apps/cli 的 voice 命令和 apps/tui 的 `/voice` 都创建 coding-agent session，再调用 voice-agent interaction；
5. 用同一 coding AgentSession 恢复文本和工具事件，voice model 请求固定为 `toolCall: false`；
6. 不复制第二套 Agent loop，不从 voice-agent 导入 coding-agent 或 apps 内部模块。

最小验收：语音输入能形成 canonical user message，文本和工具事件能回到语音输出，Session 能从 CLI/TUI 继续恢复，且触发一次 bash 审批时权限路径按 §4.6.1 收敛（播报 + host 侧确认，未确认不执行）。

### 阶段 8：清理旧入口

CBOR 已在阶段 1 删除，这一阶段只处理旧入口的收尾：

- 从 packages/coding-agent 删除 step/pi bin 及对应 bundle entry；
- 删除阶段 2 保留的 `step-cli.ts` deprecated shim；
- 根据产品决策删除或保留 apps/cli 的 pi-compat；
- 更新 lockfile、shrinkwrap、install-lock、README、CI 和 release smoke test；
- 清理根 tsconfig.json 中已失效的 path alias（含当前就已存在的 `@earendil-works/pi-agent-old`，指向并不存在的 `packages/agent-old`）。

## 12. 当前路径到目标路径映射

| 当前路径 | 目标路径 | 说明 |
| --- | --- | --- |
| packages/coding-agent/src/step-cli.ts | apps/cli/src/main.ts + commands/step.ts | Step 进程入口和命令装配 |
| packages/coding-agent/src/cli/* | apps/cli/src/commands/* | argv、auth、session picker 等 host 逻辑 |
| packages/coding-agent/src/step/settings-manager.ts | packages/coding-agent/src/compatibility/ 或 apps/cli/src/step-support/ | 先按是否产品专属决定 |
| packages/coding-agent/src/modes/print-mode.ts | apps/cli/src/modes/print.ts | headless 输出 |
| packages/coding-agent/src/modes/json-event.ts | apps/cli/src/modes/json.ts + packages/contracts | JSON 事件适配 |
| packages/coding-agent/src/modes/rpc/* | apps/cli/src/modes/rpc/ + packages/contracts | JSONL RPC，不能随 CBOR 删除 |
| packages/coding-agent/src/modes/interactive/* | apps/tui/src/projection/ + packages/tui/src/runtime | TTY projection 与 host 编排 |
| packages/coding-agent/src/core/agent-session-runtime.ts | 首期留在原处；满足条件后迁移到 packages/agent-runtime/src/* | runtime 装配 |
| packages/coding-agent/src/core/session-manager*.ts | packages/session/src/* | Session 语义和恢复 |
| packages/coding-agent/src/core/model-*.ts | 逐个判定：中立部分进 packages/ai/src/*，产品侧解析与归属留在 coding-agent | 见下方说明，不可整体搬运 |
| packages/coding-agent/src/core/tools/* | packages/tools/src/* 或 packages/coding-agent/src/tools/ | 依据共享程度拆分 |
| packages/coding-agent/src/server/create-harness.ts | 首期留在 coding-agent；满足条件后可迁移到 agent-runtime/src/create-harness.ts | 本地 harness 工厂，保留 |
| packages/coding-agent/src/client/* | 删除或独立 remote-cbor package | 仅属于 CBOR 远程方向 |
| packages/coding-agent/src/extensions/step-subagent* | runtime feature 或 extensions/subagent | 依据是否默认必需和 contract 稳定性决定 |
| packages/ai/src/api/* | packages/ai contract + extensions/llm adapters | api 语义与实现分离 |
| packages/tui | packages/tui/src/renderer + packages/tui/src/runtime | 一个 workspace package 内保留 renderer 与 host orchestration 边界 |
| packages/coding-agent/src/step-bootstrap.ts | apps/cli/src/bootstrap/ | host 启动引导 |
| packages/coding-agent/src/step-cli-runtime.ts | packages/coding-agent（保留） | 产品侧运行时装配，不属于 host |
| packages/coding-agent/src/bun/* | apps/cli/src/bun/* | bun 编译入口随 CLI 入口一起移动 |
| scripts/build-coding-agent-bundle.mjs | 参数化后指向 apps/cli | 当前硬编码 coding-agent 路径与 entry 列表 |
| scripts/build-binaries.sh / build:binary | 编译 entry 指向 apps/cli | 承载入口路径的真正落点 |
| infra/release/release-targets.json | 无需改动 | 只声明产物 id/archiveType/binary，不含来源路径，无消费者 |
| packages/session-backends/sqlite-node | 保留 | 备用 SQLite backend，与 CBOR 删除无关；未来可由 packages/storage adapter 统一封装 |

`core/model-*.ts` 这一组不能整体搬进 `packages/ai`。其中 `model-resolver.ts`、`model-registry.ts`、`provider-composer.ts`、`remote-catalog-provider.ts`、`provider-attribution.ts` 混合了两类逻辑：一类是与产品无关的模型解析和目录能力（属于中立 ai 包），另一类是 Step 特有的 provider 归属、可用性判定和展示规则（属于 coding-agent 产品侧）。迁移时按符号逐个判定，先把中立部分下沉，产品侧规则通过 ai 暴露的 contract 注入，不要因为文件名以 `model-` 开头就整体移动。

产品专属代码不要因为有一个 src/extensions 目录就全部搬进 workspace extensions；先看它是否真正满足 §3.2 的边界条件。

新的 JSONL/SDK 类型使用 `packages/contracts` 这个名字，避免和现有 `packages/protocol`（CBOR framed protocol）混淆。**这是终名，不要计划在 CBOR 删除后再把它改回 `protocol`。** 重命名一个 workspace 包的成本远高于表面：需要同步修改根 `tsconfig.json` 的 path alias、各包 `tsconfig.build.json` 的 paths、`vitest.config.ts` 的 resolve.alias、bundle 脚本的 external 白名单、以及所有 `workspace:*` 依赖声明。为了让名字"更好看"而做二次全量改名，收益不足以覆盖这个成本和它带来的回归风险。如果确实更喜欢 `protocol` 这个名字，就在 CBOR 删除（阶段 1）完成之后、创建这个包之前直接定名，而不是先叫 `contracts` 再改。

## 13. workspace、manifest、build 和 TypeScript 配置

### 13.1 根 package

> 前提：本节示例按 pnpm 语法书写。当前仓库主线是 npm workspaces（根 package 名为 `step-cli`，见 §0.1），落地前必须先确定包管理器。若保留 npm，按本节末尾的对照表转换。

根 package 变成私有编排包，不拥有用户执行的 bin，也不承载运行时 src：

~~~json
{
  "name": "@step-harness/monorepo",
  "private": true,
  "scripts": {
    "step": "pnpm --filter @step-harness/cli dev --",
    "tui": "pnpm --filter @step-harness/tui dev --",
    "voice": "pnpm --filter @step-harness/cli dev -- voice",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
~~~

脚本中的具体 dev 命令可以按仓库现有 bundler 调整；重要的是根脚本只编排 workspace，不再 hard-code 一串 cd 和包顺序——当前的 `build` / `build:offline` 正是把 10 个包的构建顺序写死在一行 `cd` 链里，这是 §1.5 “根脚本隐藏构建图”的具体表现。

保留 npm workspaces 时的对照：

| 本节示例（pnpm） | npm workspaces 等价写法 |
| --- | --- |
| `pnpm --filter X build` | `npm run build --workspace=X` |
| `pnpm -r build` | `npm run build --workspaces --if-present` |
| `pnpm -r --if-present test` | `npm run test --workspaces --if-present` |
| `pnpm --filter X... build` | 无直接等价物；依赖闭包需由 manifest graph 或显式顺序表达 |

以下这些根脚本与包管理器决策无关，**不在本次重构范围内，必须原样保留**：`check`（biome + pinned-deps + ts-imports + shrinkwrap + install-lock + tsgo + browser-smoke）、`generate:models` 一族、`profile:tui` / `profile:rpc`、`release:*`、`eval`。重命名根 package 时需检查 `scripts/local-release.mjs` 和 `infra/release/release-targets.json` 是否引用了旧名 `step-cli`。

### 13.2 apps/cli manifest

~~~json
{
  "name": "@step-harness/cli",
  "private": true,
  "type": "module",
  "bin": {
    "step": "dist/bundle/step.js"
  },
  "scripts": {
    "dev": "tsx --tsconfig ../../tsconfig.json src/main.ts",
    "build": "npm run build:unbundled && node ../../scripts/build-coding-agent-bundle.mjs",
    "build:unbundled": "tsgo -p tsconfig.build.json",
    "test": "vitest --run",
    "typecheck": "tsgo -p tsconfig.build.json --noEmit"
  },
  "dependencies": {
    "@step-harness/coding-agent": "workspace:*",
    "@step-harness/voice-agent": "workspace:*",
    "@step-harness/sdk": "workspace:*",
    "@step-harness/tui-kit": "workspace:*"
  }
}
~~~

注意这里的工具链必须与仓库现状一致，**不是通用的 `tsc` / `tsx` / `vitest run`**：

| 环节 | 仓库实际使用 |
| --- | --- |
| 类型检查与 emit | `tsgo`（不是 `tsc`） |
| bundle | esbuild，经 `scripts/build-coding-agent-bundle.mjs` |
| 单文件二进制 | `bun build --compile` |
| dev 入口 | `tsx --tsconfig tsconfig.json` |
| 测试（coding-agent） | `vitest --run` |
| 测试（tui） | `node --test test/*.test.ts` |

`bin` 指向 `dist/bundle/step.js` 而不是 `dist/main.js`，因为发布产物是 esbuild bundle，这与当前 `packages/coding-agent` 的 `bin` 声明方式一致。

### 13.3 apps/tui 和 apps/desktop

apps/tui 只依赖 `@step-harness/tui-kit`、coding-agent、voice-agent、sdk 以及它实际注册的 extensions。它不能依赖 apps/cli。

如果需要独立的 TUI 命令，apps/tui 可以拥有自己的 bin；如果 CLI 采用进程内共享，则这个 bin 只是另一个进入同一 `@step-harness/tui-kit/runtime` 的薄包装：

~~~json
{
  "name": "@step-harness/tui",
  "private": true,
  "type": "module",
  "bin": {
    "step-tui": "dist/main.js"
  },
  "dependencies": {
    "@step-harness/coding-agent": "workspace:*",
    "@step-harness/voice-agent": "workspace:*",
    "@step-harness/sdk": "workspace:*",
    "@step-harness/tui-kit": "workspace:*"
  }
}
~~~

`@step-harness/tui-kit` 的根导出只提供 renderer；交互编排从 `@step-harness/tui-kit/runtime` 子路径导出。apps/tui 的 package name 保持为 `@step-harness/tui`，这样不会与 workspace filter 产生歧义，也不会让 renderer-only 消费者在 API 层面依赖 runtime。

当前仓库的 `packages/tui` 实际 package name 是 `@earendil-works/pi-tui`，并且包含 native 构建、独立测试和终端组件。迁移期可以先保留这个名称和 native 边界，再逐步增加 `src/runtime`；只有在所有内部 import 和发布脚本切换完成后，才改名为 `@step-harness/tui-kit`。

apps/desktop 首期**不创建 manifest**（见 §0）：一个只有 placeholder `main.ts` 的 workspace 会进入 workspace glob、构建遍历和依赖检查规则，产生维护成本却没有对应收益，而且正好是 §3.2 列出的反例。等桌面框架和生命周期确定后再引入 Electron、Tauri 或原生 bridge 并创建 manifest。届时桌面包不应复用 apps/cli 的 argv parser，也不应通过深层路径调用 TUI。

### 13.4 packages/tui manifest

`packages/tui` 是一个 package，但公开两个有意分开的入口。根入口只包含 renderer；只有需要 Agent 事件编排的 app 才引用 `./runtime`：

~~~json
{
  "name": "@step-harness/tui-kit",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./runtime": {
      "types": "./dist/runtime/index.d.ts",
      "import": "./dist/runtime/index.js"
    }
  },
  "dependencies": {
    "get-east-asian-width": "1.6.0",
    "marked": "18.0.5"
  },
  "peerDependencies": {
    "@step-harness/sdk": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@step-harness/sdk": { "optional": true }
  }
}
~~~

**`@step-harness/sdk` 必须放在 optional peerDependencies，不能放进 `dependencies`。** 这是一条硬约束，理由如下：

当前 `packages/tui` 的 `dependencies` 只有 `get-east-asian-width` 和 `marked` 两项——它是一个完全与 Agent 无关的纯终端渲染库，这是它最有价值的属性，也是 §0.3 和 §14.1 反复要求保护的边界。如果把 sdk 写进 `dependencies`，任何只想要 renderer 的消费者都会被拖进整个 Agent SDK 的依赖闭包：node_modules 变重、构建图多出一条边、renderer 的独立测试不再能脱离 Agent 侧代码运行。

关键在于 **exports 子路径只隔离 API 表面，隔离不了依赖图**。`.` 和 `./runtime` 两个入口在类型和导入层面是分开的，但 `dependencies` 是整包生效的——声明了就会被安装，不管消费者用不用 `./runtime`。用 optional peer 才能表达真实语义：“只有使用 `./runtime` 的消费者才需要提供 sdk”，而 apps/cli、apps/tui 本来就已经直接依赖 sdk，能自然满足这个 peer。

如果 runtime 最终只有 apps/tui 一个消费者，**更好的选择是直接把它下沉到 `apps/tui/src/runtime`**，让 `packages/tui` 回到零 Agent 依赖的纯 renderer 包，连 optional peer 都不需要。这与 §0.3 结尾给出的判断一致：合并的是 package 边界，不是职责边界；没有第二个消费者就不该为目录对称保留一个跨层入口。

现有 `native/`、renderer 测试和 native build script（`build:native:darwin`、`build:native:win32`）继续归这个 package，测试仍用 `node --test test/*.test.ts`；runtime 测试单独放在 `test/runtime/`。

### 13.5 domain package manifest

~~~json
{
  "name": "@step-harness/coding-agent",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing/index.d.ts",
      "import": "./dist/testing/index.js"
    }
  },
  "scripts": {
    "build": "tsgo -p tsconfig.build.json",
    "test": "vitest --run",
    "typecheck": "tsgo -p tsconfig.build.json --noEmit"
  }
}
~~~

`private: true` 不能漏——当前 10 个 workspace 包全部是私有包，新建的包应保持一致，除非明确决定对外发布并同时补上版本策略（见 §2.1）。

voice-agent 使用相同的 workspace manifest 约定，但不复制 coding-agent 的内部模块，也不导出 `AgentProduct`。它的 `src/index.ts` 只暴露 `VoiceInteraction`、音频 session 和 turn-taking contract；两个 package 都不声明 bin。

### 13.6 workspace 成员

新增 `apps/*` 和 `extensions/*` 两条 glob，保留现有的 `packages/session-backends/*`，**其余成员必须原样保留**：

~~~yaml
packages:
  - "apps/*"
  - "packages/*"
  - "packages/session-backends/*"
  - "extensions/*"
  # 以下 5 条是现有成员，不能删
  - "packages/coding-agent/examples/extensions/with-deps"
  - "packages/coding-agent/examples/extensions/custom-provider-anthropic"
  - "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo"
  - "packages/coding-agent/examples/extensions/sandbox"
  - "packages/coding-agent/examples/extensions/gondolin"

allowBuilds:
  esbuild: set this to true or false
~~~

`packages/session-backends/*` 继续匹配现有的 SQLite backend；它与 CBOR 删除无关。若未来决定移除备用 backend，应作为独立变更同步清理根脚本、tsconfig、发布清单和 lockfile。

最后 5 条容易被遗漏：它们是 `packages/coding-agent/examples/extensions/` 下的示例扩展，当前同时登记在 `pnpm-workspace.yaml` 和根 `package.json` 的 npm `workspaces` 数组里。把它们从 workspace 中移除会破坏这些示例的依赖解析。同理，`allowBuilds` 段也要保留。

如果保留 npm workspaces（见 §0.1），对应修改的是根 `package.json` 的 `workspaces` 数组，内容一致：

~~~json
{
  "workspaces": [
    "apps/*",
    "packages/*",
    "packages/session-backends/*",
    "extensions/*",
    "packages/coding-agent/examples/extensions/with-deps",
    "packages/coding-agent/examples/extensions/custom-provider-anthropic",
    "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo",
    "packages/coding-agent/examples/extensions/sandbox",
    "packages/coding-agent/examples/extensions/gondolin"
  ]
}
~~~

注意根 `tsconfig.json` 的 `include` 已经包含 `packages/coding-agent/examples/**/*` 并在 `exclude` 中排除了 `gondolin`；改动 workspace 成员时要一并核对这两处，以及 `biome.json` 中单列的 `packages/session-backends/*` includes。

如果 docs 或新的 examples 需要 workspace 能力，单独加入对应 glob；不要把整个仓库的 docs 当成可发布 package。

常用命令：

~~~text
pnpm --filter @step-harness/cli... build
pnpm --filter @step-harness/tui... test
pnpm --filter @step-harness/coding-agent... typecheck
pnpm -r --if-present test
~~~

依赖图由 package.json 的 workspace:* 依赖表达，pnpm filter 的 ... 负责包含依赖闭包。

### 13.7 tsconfig 继承

> **`tsconfig.base.json` 已经存在，本节是增量说明，不是一份可以覆盖它的新配置。**

现有 `tsconfig.base.json` 的关键选项如下，其中四项是整个代码库的硬前提，**不能改也不能省略**：

~~~json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  }
}
~~~

四项硬前提：

| 选项 | 为什么不能动 |
| --- | --- |
| `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` | 全库的相对 import 都写 `.ts` 后缀，由 `scripts/check-ts-relative-imports.mjs` 做门禁强制。去掉这两项，每个源文件的相对 import 都会解析失败 |
| `module` / `moduleResolution: "Node16"` | 是 base 的实际取值。根 `tsconfig.json`（仅用于 `noEmit` 全量类型检查）覆写为 `NodeNext`，但各包的 `tsconfig.build.json` 继承的是 base 的 Node16。写成 NodeNext 会改变解析语义 |
| `erasableSyntaxOnly` | 约束源码只使用可擦除的 TS 语法，与 bun/esbuild 的转译前提绑定 |

新增 app/package 时的正确做法是**继承现有 base 并只补充本包特有的字段**：

~~~json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "paths": {
      "@step-harness/tui-kit": ["../../packages/tui/dist/index.d.ts"],
      "@step-harness/sdk": ["../../packages/sdk/dist/index.d.ts"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["test", "dist"]
}
~~~

`paths` 指向兄弟包的 **`dist/*.d.ts`（已构建的声明文件）而不是 `src/*.ts`**，这是仓库现有 `packages/coding-agent/tsconfig.build.json` 采用的模式，也是构建顺序能生效的原因。根 `tsconfig.json` 的 `paths` 走的是另一套（指向 `src/*.ts`），只服务于全量 `tsgo --noEmit` 检查，两者不要混用。

新增 workspace 时还需要在根 `tsconfig.json` 的 `paths` 和 `include` 中登记对应条目。顺带清理：根 `tsconfig.json` 当前有一条指向不存在的 `packages/agent-old` 的失效 alias（`@earendil-works/pi-agent-old`），可以直接删除。

apps 和 packages 的相对 extends 路径按所在层级分别调整。不要用多层 tsconfig 继承表达运行时组合关系。

## 14. 架构检查与验收标准

### 14.1 依赖边界

- [ ] apps/cli、apps/tui、apps/desktop 是唯一的 host 入口目录；
- [ ] packages/coding-agent/src 和 packages/voice-agent/src 都有独立公共入口；
- [ ] coding-agent 与 voice-agent 是平级 package，彼此没有内部 import；
- [ ] packages/* 不依赖 apps/*；
- [ ] extensions/* 不导入 app 内部文件；
- [ ] app-to-app 只能通过稳定 package contract 或 JSONL/stdio；
- [ ] Agent loop、Session、AI contract 不依赖具体 TUI 组件或厂商 SDK；
- [ ] 反向也成立：`@step-harness/tui-kit` 的 `dependencies` 中不出现 sdk 或任何 Agent 侧包（runtime 走 optional peer，见 §13.4）；
- [ ] extension 只由 app 组合根注册，packages/* 与 extensions/* 都不注册其他 extension，且无隐式目录扫描；
- [ ] 新建 package 的理由能落到依赖方向、测试边界、生命周期三条之一，不以“独立发布”为由（当前包全部 private）；
- [ ] TypeScript extends 只出现在工程配置，不承担运行时注册；
- [ ] 不存在为了架构名义创建的 extends/ 目录；
- [ ] apps/desktop 在需求明确前不存在 manifest。

工程门禁（现有的必须保持全绿，不得因重构放宽）：

- [ ] `npm run check:ts-imports`：相对 import 一律 `.ts` 后缀，无 `.js`；
- [ ] `npm run check:pinned-deps`：依赖版本仍全部固定；
- [ ] `npm run check:shrinkwrap` 与 `check:install-lock:coding-agent`：npm 专属产物与 manifest 一致（若迁移到 pnpm，需先给出替代门禁再删除这两条）；
- [ ] `tsgo --noEmit` 全量通过；
- [ ] `npm run check:browser-smoke` 通过。

### 14.2 入口和模式

- [ ] apps/cli 拥有唯一 step bin；
- [ ] packages/coding-agent 和 packages/voice-agent 不声明 bin；
- [ ] apps/tui 可以独立启动，或通过 `@step-harness/tui-kit/runtime` 被 CLI 进程内调用；
- [ ] `packages/tui` 的 renderer 与 runtime 只在模块层分开，不额外要求 `packages/tui-runtime` workspace；
- [ ] TUI runtime 不导入 coding-agent、voice-agent 或任何 app 私有源码；
- [ ] interactive、print、json、rpc、sdk-stdio、subagent 各有 smoke fixture；
- [ ] rpc 明确是 JSONL，不被 CBOR 删除误伤；
- [ ] sdk-stdio 的长度前缀和 stdout 原始写入行为不变；
- [ ] step voice 和 TUI `/voice` 都能创建 coding-agent Session 并挂载 voice interaction；
- [ ] voice model 请求不携带 tools，意外 tool-call 事件会被 adapter 拒绝；
- [ ] coding session 的权限审批事件在语音 surface 上有显式处理路径，不被静默丢弃；未确认时工具不执行（见 §4.6.1）；
- [ ] voice-agent 不通过 apps/cli 的深层源码进入，也不直接 import coding-agent。

### 14.3 AI 行为

- [ ] ModelApiDialect 是唯一协议 dispatch key；
- [ ] ProviderProfileId 只表示 endpoint、auth、catalog、label 和 telemetry；
- [ ] 同一个 OpenAI adapter 可以访问多个 OpenAI-compatible baseUrl；
- [ ] 同一个 profile 可以为不同模型声明不同 api；
- [ ] 显式 api 优先于旧 provider 推导；
- [ ] core 没有按 provider 名分支；
- [ ] OpenAI Chat、OpenAI Responses、Anthropic Messages 有独立 conformance test；
- [ ] trace 同时记录 dialect 和 profile，但不记录密钥。

### 14.4 删除和迁移

- [ ] CBOR client/server/protocol 删除是独立阶段，且排在入口外移之前（阶段 1）；
- [ ] 删除前完成 ./client 外部消费者扫描；
- [ ] src/server/create-harness.ts、本地 JSONL RPC、sdk-stdio、subagent 均保留；
- [ ] `packages/agent` 的 `SessionRepo` contract、`jsonl.ts`、`memory.ts` 与 `harness/session/testing` conformance 套件保留，`jsonl.test.ts`/`memory.test.ts` 仍全绿；
- [ ] 每个迁移阶段能通过旧 bin 或 facade 回滚；阶段 2 的回滚需同时切换根 script、bundle entry 与 `scripts/build-binaries.sh` 的编译 entry；
- [ ] `scripts/build-coding-agent-bundle.mjs`、`build:binary`、`scripts/build-binaries.sh` 的编译 entry 已随入口迁移同步更新（`release-targets.json` 不含入口路径，无需改动）；
- [ ] 文档、CI、发布 smoke test 在移除旧入口前已切换到 apps/cli；
- [ ] workspace 成员未丢失现有的 5 个 example extension；
- [ ] desktop 只有在生命周期和发布方式明确后才创建 manifest 与实现。

## 15. 最终建议

现在应把结构定为：

~~~text
apps/
  cli/       # [新建+抽出] step 命令，创建 coding session；voice 命令可挂载 voice-agent
  tui/       # [新建+抽出] TUI 命令，创建 coding session；/voice 可挂载 voice-agent
  desktop/   # [全新，后续] 未来桌面宿主；首期只预留位置，不创建 manifest

packages/
  coding-agent/src/   # [保留+瘦身] 编码领域包；首期包含 AgentSessionRuntime
  voice-agent/src/    # [全新] 语音交互模块，与 coding-agent 平级但不拥有 Agent loop
  agent/src/           # [保留] 当前通用 Agent loop + SessionRepo/JSONL/memory 持久化
  session/src/         # [新包+抽出] Session 事件与恢复语义
  storage/src/         # [后续抽出，首期不创建] 统一 JSONL/SQLite adapter；现有 sqlite-node 保留
  ai/src/              # [保留+重组] dialect 与 provider profile
  tools/src/           # [新包+抽出] 通用工具契约与实现
  sdk/src/             # [新 facade+抽出] host-facing API
  tui/src/             # [保留+重组] 终端 renderer 与 runtime
    renderer/
    runtime/
  realtime/src/        # [全新，按需] 实时音频/VAD/interrupt contract
  contracts/src/       # [新建/重建] JSONL/SDK contract
  config/src/          # [新包+抽出] 配置 schema 与加载
  telemetry/src/       # [保留] 通用 telemetry

# 当第二个消费者和中立 contract 出现后，再新增：
  agent-runtime/src/  # [后续抽出，首期不创建]

extensions/
  llm/src/             # [抽出+重组] wire adapters
  mcp/src/             # [新建+抽出] MCP 声明与 bridge
  realtime-voice/src/  # [全新] 音频设备与厂商桥接
~~~

落地要点归纳如下，避免正文中重复出现的限定条件被漏读：

| 主题 | 结论 |
| --- | --- |
| 前置决策 | 先定包管理器（npm workspaces 或统一到 pnpm），这不属于本次架构重构，见 §0.1 |
| 阶段顺序 | 阶段 1 先独立删除 CBOR，再做入口外移；先删后搬能显著缩小后续搬迁面，见 §10 |
| host 边界 | 先建立 apps/cli 与 apps/tui；apps/desktop 只预留位置，需求明确后再建 manifest |
| 产品边界 | packages/coding-agent 与 packages/voice-agent 暴露稳定 facade，互不 import |
| agent-runtime | 首期留在 coding-agent 内部；只有出现第二个消费者、重复装配或外部 SDK 需求且 contract 稳定后才外提（完整条件见 §0.5，正文各处提到的“满足条件后”均指这一条） |
| TUI | renderer 与 runtime 合并为一个 `packages/tui`，靠 `src/renderer`/`src/runtime` 和 `./runtime` 子路径维持边界；sdk 只能是 optional peer，不进 `dependencies`；runtime 若无第二个消费者就下沉到 apps/tui |
| voice | `/voice` 是 surface 切换，不是第二个 Agent loop；voice model 固定 `toolCall: false`；权限审批默认降级到文本确认，见 §4.6.1 |
| AI | 从第一天采用 api/dialect 与 provider/profile 双轴，按 wire 格式分流，不按厂商名分支 |
| extensions | 只用于真正可替换的外部实现，由 app 组合根显式注册；TypeScript extends 只用于编译配置 |
| 拆包判据 | 依赖方向、测试边界、生命周期三选一；“独立发布”在全私有仓库中不成立 |

最终关系应保持简单：

~~~text
CLI/TUI host（composition root）
    ├──> coding-agent -> coding AgentSession
    │                    └──> shared runtime / session / ai / tools
    └──> voice-agent interaction
             └──> 注入上面的 AgentSession，负责语音输入和输出
~~~

这满足当前“只有 CLI 或 TUI 命令进入 Agent 能力”的事实：CLI/TUI 选择 coding session，`/voice` 再挂载语音交互；也为未来 desktop、更多模型格式和语音设备扩展保留了清晰的演进位置。

---

## 附录 A：as-built 变迁对照（2026-09-12 竣工回填）

> 以上正文是 **2026-09-07 的原始技术论证提案（原样保留）**。重构实际执行到 S0→S7 + A1 + C8，落地形状与本提案有若干实质差异。本附录只做**提案 → as-built 的对照**，让读者看清变迁；逐步历程见 `step-harness-最终实施方案.md`，评审排期微调版见 `step-harness 代码结构· 最终方案.md`（那份已提前把 apps/tui 不建、session/tools 延后等决策写进计划）。基线 `1cfed08` → 终态 `95a674b`。

**A.1 实际落成 12 个 workspace 成员（精确命名）**

| 目录 | 实际包名 | 相对提案 |
| --- | --- | --- |
| apps/cli | `@step-harness/cli` | 唯一宿主，**含交互式 TUI**（提案里的 apps/tui 未单独建） |
| packages/coding-agent | `@step-harness/coding-agent` | 保留；仍持有 session-manager、core/tools、features/*、扩展系统 |
| packages/agent-loop | `@step-harness/agent-core` | 由 `agent` 改目录名（S1-R） |
| packages/providers | `@step-harness/providers` | 由 `ai` 改名 + step-provider 迁入（C8） |
| packages/tui | `@step-harness/pi-tui` | **保留 pi-tui 词根**（非提案里的 tui-kit，D4） |
| packages/contracts | `@step-harness/contracts` | 按提案建（S2），零运行时依赖 |
| packages/config | `@step-harness/config` | 按提案建（S3） |
| packages/telemetry | `@step-harness/telemetry` | 保留 |
| packages/realtime | `@step-harness/realtime` | 按提案建（S6，空契约） |
| packages/voice-agent | `@step-harness/voice-agent` | 按提案建（S6，桩） |
| packages/evals | `@step-harness/evals` | 保留 |
| extensions/realtime-voice | `@step-harness/realtime-voice` | 按提案建（S6，mock driver） |

内部 scope 已统一 `@step-harness/*`（A1）；对外扩展 specifier 三代并存（新 + `@earendil-works/pi-*` + `@mariozechner/pi-*`），仅存活于扩展加载器映射表 + 主题符号键 + 解析别名（向后兼容，只加不减）。

**A.2 提案里有、但实际没有建/没有抽取的结构**（经「不建空壳 + 证据驱动」判断）

| 提案结构 | 现状 | 职责当前所在 |
| --- | --- | --- |
| `apps/tui`（独立 TUI 宿主） | **未建** | `apps/cli/src/ui/`（S4 经依赖注入并入；拆独立宿主会撞反向依赖） |
| `packages/session` | **未建**（S5-10 延后） | `coding-agent/src/core/session-manager.ts`（契约已在 contracts/in-process） |
| `packages/tools` | **未建**（S4-6 未执行） | `coding-agent/src/core/tools/` |
| `packages/sdk` | **未建** | `coding-agent/src/index.ts`（barrel）+ `core/sdk.ts` |
| `packages/agent-runtime` | **未建**（§0.5 条件未满足） | `coding-agent/src/core` |
| `packages/storage` | **未建** | `agent-core/src/harness/session/`（JSONL/memory；SQLite backend 已随 CBOR 删） |
| `packages/web` / `apps/desktop` | **未建** | —（仅占位/无需求） |
| `extensions/llm` | **未建** | `providers/src/api/*`（3 主协议 adapter 仍在包内） |
| `extensions/mcp` | **未建** | `coding-agent/src/step/plugins.ts` |

将来重启抽取顺序不变：**先冻结中立 contract，再移动实现**；每步要有第二消费者或明确依赖收益。

**A.3 已被验证成立并落地的提案原理**

- **按 wire dialect 分流、不按厂商**（§4）：`model.api` 是唯一 dispatch key，核心无按 provider 名分支（`check-no-provider-dispatch` 焊死）。但按「只留 StepFun」裁剪——`KnownApi` 收敛为 3 主协议，provider 只留 step，`ai`→`providers`（C8）。
- **voice 是通道不是第二主 Agent**（§0.4/§4.6）：`voice-agent` 实现 `VoiceInteraction`、`attach` 现有 session、`toolCall:false` 写死。当前为 S6 空实现/桩，真实设备/ASR/TTS + 组装根接线（S6-4/5/6）延后。
- **边界规则/依赖方向**（§2）：由 12 条 guard 机器强制（layer-direction/ui-layer/tui-no-ai/contracts-deps-empty/…），A1 新增 `check-legacy-scope-prefix`。
- **step-provider 归属**（C8）：StepFun 身份/OAuth/模型核作供应商层一等公民居 `providers/src/step-provider/`；扩展注册胶水留 coding-agent（消费 ExtensionAPI）。

**A.4 与提案不同的关键判断**

- 包管理器：提案「npm/pnpm 双轨待定」→ **统一 pnpm**（S1-D），废 npm 专属 shrinkwrap/install-lock 门禁。
- pi 兼容：提案留 pi-compat → **pi 命令全删，不做兼容**（S1-C）。
- 过渡壳：**不造**（步骤 0 不声明 bin，真入口 S3 一次到位）。
- 步骤 4 回滚开关：**不设**，靠分提交 revert。
- tui 包名：**保留 pi-tui 词根**（非 tui-kit）。

**A.5 后续结构决策：`extensions/` 并入 `packages/extensions/`（2026-09-14）**

竣工时唯一的 extension（`@step-harness/realtime-voice`）曾落在顶层 `extensions/`（见 A.1）。之后判断：**单个 extension 不足以支撑一条独立的顶层轴**，遂将其下沉到 `packages/extensions/*`，与既有的 `packages/session-backends/*` 同构。

- 决策：取消顶层 `extensions/` 目录，改用 `packages/extensions/*`。
- 理由：拆包/建轴判据是依赖方向、测试边界、生命周期（§2.1），一个 mock 桩 extension 三条都不满足独立顶层轴；`packages/` 下已有 `session-backends/*` 的嵌套先例，沿用即可，减少 workspace glob 与 guard 的特例。
- 落地：`extensions/realtime-voice` → `packages/extensions/realtime-voice`；`pnpm-workspace.yaml` 与根 `package.json` 的 glob `extensions/*` → `packages/extensions/*`；`scripts/workspace-registry.json` 更新 `dir`；`scripts/check-layer-direction.mjs` 改为以 `packages/extensions/` 前缀识别 extension 层；该包 `tsconfig.build.json` 的 `extends` 深度 `../../` → `../../../`；`pnpm-lock.yaml` importer 路径刷新。**包名不变**，无依赖引用改动。
- 影响 §0 目标树、§2.2 依赖图、§13.6 workspace 成员示例中的顶层 `extensions/`：那些为 2026-09-07 提案形态与 A.1 竣工快照，按“原样保留”不改写；以本条为准。
