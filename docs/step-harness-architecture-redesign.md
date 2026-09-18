# step-harness 项目结构（最终架构）

## 1. 结构总览

step-harness 是一个 **pnpm workspace monorepo**（pnpm 9.15.9，Node ≥ 22.19.0，仓库只有 `pnpm-lock.yaml`）。它有 **12 个 workspace 成员**：1 个宿主 app、10 个 package、1 个 extension，全部 `private: true`（产品以发布二进制交付，不发布 npm 包）。

~~~text
step-harness/
├── apps/
│   └── cli/                     @step-harness/cli — 唯一进程宿主；交互式 TUI 也在这里
│       └── src/
│           ├── main.ts          唯一进程入口：argv → mode → dispatch → exit
│           ├── args/            参数解析
│           ├── bootstrap/       环境 / 配置 / 遥测引导
│           ├── bun/             bun 单文件编译入口（step-cli.ts）
│           ├── commands/        顶层子命令：logout / mcp / login / feedback / update / config
│           ├── modes/           print / json / rpc / sdk-stdio
│           └── ui/              交互式 TUI（内部分层 host > runtime > view > state）
├── packages/
│   ├── coding-agent/            @step-harness/coding-agent — 编码产品：工具、权限、会话、扩展、step 集成、主题、非交互 mode
│   ├── agent-core/              @step-harness/agent-core — 通用 agent loop 与 harness（产品无关）
│   ├── providers/               @step-harness/providers — LLM API / dialect / catalog / auth，含 step-provider
│   ├── tui/                     @step-harness/pi-tui — 纯终端渲染库（零 AI 依赖）
│   ├── contracts/               @step-harness/contracts — host↔agent 契约 + JSONL/SDK wire（零运行时依赖）
│   ├── config/                  @step-harness/config — 中立配置格式 / 加载 / 启动迁移
│   ├── telemetry/               @step-harness/telemetry — 中立遥测契约
│   ├── realtime/                @step-harness/realtime — 实时音频中立契约（零运行时依赖）
│   ├── voice-agent/             @step-harness/voice-agent — 语音通道，与 coding-agent 平级，不拥有 loop
│   ├── evals/                   @step-harness/evals — 评测工具，位于产品层之上
│   └── extensions/
│       └── realtime-voice/      @step-harness/realtime-voice — 音频设备驱动 extension（首期 mock driver）
├── infra/release/               发布链路：release-bundle、build-binaries、install
├── plugins/
├── scripts/                     构建与门禁脚本：14 条 check-*.mjs + workspace-registry.json
└── docs/
~~~

此外 `packages/coding-agent/examples/extensions/` 下有 5 个示例扩展（`pi-extension-*`，用非 `@step-harness` 的旧命名），它们也是 workspace 成员，用于扩展开发示例，由 `check-workspace-registry` 标记为 `example` 角色并豁免 scope 约束。

## 2. workspace 成员与分层

`scripts/workspace-registry.json` 是这份结构的机器登记表：每个成员一行 `{dir, role, reason}`，由 `check-workspace-registry` 强制与 `pnpm-workspace.yaml` / 根 `package.json` 的 glob 完全一致。它把每个包钉在一个架构角色上：

| 角色 | 包（目录） | 拥有什么 |
| --- | --- | --- |
| APP（宿主） | `@step-harness/cli`（apps/cli） | 进程入口、argv、TTY 生命周期、退出码、组合根；交互式 TUI |
| PRODUCT（产品） | `@step-harness/coding-agent`（packages/coding-agent） | 编码 prompt、读写/bash/编辑等工具、权限策略、会话管理、扩展系统、MCP、step 集成、主题、print/json/rpc mode |
| INTERACTION（交互） | `@step-harness/voice-agent`（packages/voice-agent） | 语音通道：ASR/turn-taking/播报的领域编排；挂载到已有 coding session，不拥有 loop |
| ENGINE（引擎） | `@step-harness/agent-core`、`@step-harness/providers`、`@step-harness/telemetry`、`@step-harness/config` | agent loop、模型 API/dialect、遥测契约、配置格式——跨产品的稳定语义 |
| RENDERER（渲染） | `@step-harness/pi-tui`（packages/tui） | 终端差分渲染原语；必须保持零 AI 依赖 |
| CONTRACT（契约） | `@step-harness/contracts`、`@step-harness/realtime` | host↔agent facade + JSONL/SDK wire；实时音频中立类型；均零运行时依赖 |
| EXTENSION（扩展） | `@step-harness/realtime-voice`（packages/extensions/realtime-voice） | 可选的外部设备/厂商实现，由组合根按需注册 |
| TOOLING（工具） | `@step-harness/evals`（packages/evals） | 位于产品层之上的评测 harness |

命名例外值得记住：`packages/tui` 的包名是 `@step-harness/pi-tui`（保留 pi- 词根），其余 `packages/*` 的包名与目录同名。

### 2.1 两条正交轴

结构真正正交的是前两条轴——**宿主（Host）× 产品/交互（Product/Interaction）**；后面的引擎、契约、扩展是被这两条轴共同消费的底座。

- **宿主**回答“用户从哪里进入、进程如何启动”。当前只有一个宿主 `apps/cli`，交互式 TUI 作为它的 `src/ui/` 子层内建，而不是独立的 `apps/tui`——拆成独立宿主会撞上反向依赖，且没有第二个宿主消费者。
- **产品/交互**回答“提供什么领域行为”。`coding-agent` 是唯一拥有工具调用和代码任务 loop 的主 Agent；`voice-agent` 是挂载到同一个 coding session 上的语音通道，两者在目录上平级、不通过 import 相互耦合。

“正交”意味着任一宿主可组合任一产品/交互，组合数不需要新增目录。同一个 coding session 也能在文本 surface 与语音 surface 之间切换。

## 3. 包之间怎么调用

一句话规则：**依赖只许自上而下穿层，低层永远不得 import 高层。** 内部依赖图是一棵有向无环树，最深链 5 层。

### 3.1 依赖关系总图

实线＝`package.json` 里真实存在的依赖边；虚线＝由入口层显式注册/注入，或尚未接线。

~~~mermaid
flowchart TD
  subgraph A["入口层 apps<br/>拥有进程 · 终端 · 退出码"]
    cli["cli<br/>step 命令<br/>含全屏界面的交互编排"]
  end

  subgraph P["能力层 packages"]
    coding["coding-agent<br/>编码助手<br/>工具 · 权限 · 会话 · 扩展 · MCP"]
    agentcore["agent-core<br/>对话循环<br/>+ 上下文装配与压缩"]
    providers["providers<br/>模型接入<br/>dialect · 目录 · 厂商 SDK"]
    voice["voice-agent<br/>语音通道（桩）"]
    contracts["contracts<br/>进程内接口<br/>+ 跨进程帧格式"]
    rtc["realtime<br/>音频格式约定"]
    cfg["config<br/>配置"]
    tel["telemetry<br/>埋点"]
    tk["pi-tui<br/>终端绘制基础<br/>零 AI 依赖"]
  end

  subgraph E["可替换层 packages/extensions"]
    rtv["realtime-voice<br/>麦克风与播放（mock）"]
  end

  evals["evals<br/>评测（devDep）"]

  cli --> coding
  cli --> agentcore
  cli --> providers
  cli --> cfg
  cli --> tk

  coding --> agentcore
  coding --> providers
  coding --> cfg
  coding --> tk

  agentcore --> providers
  agentcore --> tel
  providers --> tel

  voice --> contracts
  voice --> rtc
  rtv --> rtc

  cli -. "创建并注入 session（未接线）" .-> voice
  cli -. "注册（仅语音时，未接线）" .-> rtv
  evals -. devDep .-> coding
  evals -. devDep .-> providers
~~~

图之外要记住七条规则：

1. **箭头只能从上往下。** 能力层不许反过来依赖入口层，扩展层也不例外——这条由 `check-layer-direction` 规则 3／4 机器强制（§3.4）。

2. **`contracts` 只放契约，不含实现。** 所以箭头是 `voice-agent` **指向**它（实现方指向定义），不是反过来。约束是硬的：它的依赖列表必须为空，一出现运行时依赖就是塞错了东西——由 `check-contracts-deps-empty` 焊死。`realtime` 同理。

3. **入口层是唯一知道"具体实现是谁"的那一层。** 这条容易看反：`apps/cli` 既连 `providers`/`agent-core` 拿类型与能力，又连 `coding-agent` 造实例，因为**总得有人真的把助手创建出来，而只认接口的代码造不出实例**——接口没有构造函数。把"知道具体实现"集中到一处，正是为了让其余各层只认接口。所以入口层那几条边不是规则的漏洞，是它的代价。判断某层是否真"只认接口"，看有没有那条边即可：**`voice-agent` 到 `coding-agent` 之间没有边，也不许有**。

4. **`coding-agent` 与 `voice-agent` 之间没有连线。** 由入口层分别创建两者，再把会话句柄交给语音通道。这是"语音只是通道、不是第二个助手"在代码上的体现（§7）。

5. **可替换层是虚线入边，由入口层显式注册**，能力层不许自己注册扩展、也不许按目录名扫描加载。语音设备**只在真正用语音时才注册**，普通启动不初始化麦克风。当前这两条虚线尚未接线。

6. **厂商 SDK 只住 `providers` 一层。** `@anthropic-ai/sdk` 与 `openai` 只出现在那里，`agent-core`／`coding-agent`／`pi-tui` 都拿不到——这是"provider SDK 不得外溢"的物理体现。

7. **`pi-tui` 零 AI 依赖，且现在有检查了。** 它只依赖两个第三方库，不依赖任何内部包。这个"纯绘制库"属性由 `check-tui-no-ai` 保住——只想画个框的使用方不该被拖进整个 AI 依赖链。

有四类结构**没有独立成包**，能力都内联在别处：`tools`／`session` 在 `coding-agent/src/core/` 内、`llm` 的 3 个 dialect adapter 在 `providers/src/api/`、`mcp` 在 `coding-agent/src/step/plugins.ts`、`web` 不存在。理由与后续抽取条件见 §10。

### 3.2 分层与承重

按拓扑深度（到叶子的最长路径）分带。**扇入**＝有多少个包依赖它，是"承重程度"的直接度量。

~~~text
 层                   包                                        扇入   备注
─────────────────────────────────────────────────────────────────────────────────
 L4  APP    宿主      apps/cli                                    0    唯一 bin: step
     TOOLING 工具     evals                                       0    devDep，不入产品闭环
─────────────────────────────────────────────────────────────────────────────────
 L3  PRODUCT 产品     coding-agent                                1    仅 apps/cli 依赖
─────────────────────────────────────────────────────────────────────────────────
 L2  ENGINE  引擎     agent-core                                  2
─────────────────────────────────────────────────────────────────────────────────
 L1  ENGINE  引擎     providers                                   3    承重最高；厂商 SDK 只住这里
─────────────────────────────────────────────────────────────────────────────────
 L0  基础             telemetry                                   2
     （零内部依赖）    config                                      2
     RENDERER         pi-tui                                      2    零 AI 依赖
     CONTRACT         contracts                                   1    零运行时依赖
     CONTRACT         realtime                                    2    零运行时依赖
─────────────────────────────────────────────────────────────────────────────────

 语音栈（独立子树，未接入宿主 → 与 apps/cli 之间的边数为 0，见 §7）
     INTERACTION      voice-agent      ──> contracts, realtime
     EXTENSION        realtime-voice   ──> realtime
~~~

最深的一条链（运行时主干）是线性的，值得单独记住：

~~~text
apps/cli ──> coding-agent ──> agent-core ──> providers ──> telemetry
~~~

`apps/cli` 与 `coding-agent` 之外还各自直接旁挂 `pi-tui` 与 `config`——即 UI 渲染与配置这两件事不经产品层中转。

### 3.3 完整依赖边

来自各 `package.json` 的全部 `@step-harness/*` 边，无遗漏：

| 包 | 层 | 内部出边 | 外部直接依赖 |
| --- | --- | --- | --- |
| `cli`（apps/cli） | APP | `coding-agent`、`agent-core`、`providers`、`pi-tui`、`config` | 2（chalk、grok-mermaid） |
| `coding-agent` | PRODUCT | `agent-core`、`providers`、`pi-tui`、`config` | 17（MCP SDK、highlight.js、photon-node…） |
| `agent-core` | ENGINE | `providers`、`telemetry` | 4（diff、ignore、typebox、yaml） |
| `providers` | ENGINE | `telemetry` | 6（**@anthropic-ai/sdk、openai**、proxy-agent、typebox…） |
| `telemetry` | 基础 | 无 | 0 |
| `config` | 基础 | 无 | 1（chalk） |
| `pi-tui` | RENDERER | 无 | 2（get-east-asian-width、marked） |
| `contracts` | CONTRACT | 无 | **0**（连 dependencies 字段都没有） |
| `realtime` | CONTRACT | 无 | **0** |
| `voice-agent` | INTERACTION | `contracts`、`realtime` | 0 |
| `realtime-voice` | EXTENSION | `realtime` | 0 |
| `evals` | TOOLING | `coding-agent`、`providers`（均为 **devDependencies**） | — |

三点值得注意：

- **厂商 SDK 被关在 `providers` 一层**：`@anthropic-ai/sdk` 与 `openai` 只出现在这里，`agent-core`、`coding-agent`、`pi-tui` 都拿不到——这正是"provider SDK 不得外溢"这条所有权规则的物理体现。
- **`evals` 走 devDependencies**：所以它虽然在拓扑上位于产品层之上，却不进入产品的运行时依赖闭环，发布产物不含它。
- **依赖声明有两种写法**：多数内部边固定 `^0.84.4`（全仓库锁步同版本），`config`/`contracts`/`realtime` 用 `workspace:*`。在 pnpm 下两者都解析到本地 workspace 成员，无实质差别；`check-pinned-deps` 只对外部依赖要求精确版本，跳过 `@step-harness/*`。

### 3.4 禁止的边

架构的力量在于哪些边**不允许存在**。下面每一条都有对应门禁，越界即构建失败：

| 禁止的边 | 为什么 | 门禁 |
| --- | --- | --- |
| `packages/**` → app 包（`@step-harness/cli`） | 低层不依赖高层，这是全部分层的地基 | `check-layer-direction` 规则 3 |
| `packages/extensions/*/src/**` → app 包 | 同上，扩展也不例外 | `check-layer-direction` 规则 4 |
| app 外壳 → `#ui/...` 内部 | UI 只有一个门 `#ui/index` | `check-layer-direction` 规则 1 |
| `apps/*/src/ui/**` → 外壳（main/args/bootstrap/modes/bun） | UI 不得反向依赖外壳 | `check-layer-direction` 规则 2 |
| `pi-tui` → 任何内部包或 AI/LLM SDK | 渲染层保持零 AI，可独立测试 | `check-tui-no-ai` |
| `contracts` → 任何运行时依赖 | 契约包零副作用 | `check-contracts-deps-empty` |
| `voice-agent` ↔ `coding-agent` | 两者平级，靠组合根注入 session handle 连接 | 设计约束（见 §7），无 import 边 |

规则 1/2 之所以能用 import specifier 判定，是因为 `apps/cli/package.json` 声明了子路径映射 `"#*": "./src/*.ts"`——`#ui/index` 就是 `apps/cli/src/ui/index.ts`。门禁用 TypeScript 编译器静态解析 import/export/动态 import 的 specifier，并自带 `--self-test` 覆盖每条规则。

**规则 3 的一个真实后果**（会反复咬人，值得记住）：`coding-agent` 需要渲染的交互式对话框**不能**放在 `apps/cli`，否则产品层就得 import 宿主包。所以这类组件必须住在 `packages/coding-agent/src/render/`——今天那里放着 `plan-review.ts`、`diff.ts`、`keybinding-hints.ts` 等。宿主只提供 TTY 与生命周期，产品自带自己要画的东西。

### 3.5 宿主内部再分层

`apps/cli/src/ui` 内部还有一层更细的方向约束，由 `check-ui-layer` 强制，分四级 **host > runtime > view > state**：

| 级 | 位置 | 职责 |
| --- | --- | --- |
| host | `ui/*.ts`（根，含 `index.ts` 门、`interactive-mode.ts`） | 组合根 / 状态持有者 |
| runtime | `ui/runtime/**` | 重绘、打断、输入分发、会话事件编排 |
| view | `ui/components/**`、`ui/view/**`、`ui/dialogs/**` | 组件与外观，可被 runtime 构造 |
| state | `ui/state/**` | 界面状态持有者，**叶子** |

允许向下：host→runtime/view/state、runtime→view/state、runtime→runtime、view→view、view→state。禁止的四条边：

- **A** `view → runtime`——视图不得向上触碰编排；
- **B** `runtime → host`——runtime 依赖自己内部定义的 `RuntimeContext`，而不是反向 import UI 根的状态持有者；
- **C** `runtime →` 外壳——与上面规则 2 重合的冗余保险；
- **D** `state →` 任何其他 UI 层——state 是叶子，只被别人读。

### 3.6 四条主要链路怎么走

上面是"谁能依赖谁"的静态图。下面是"一次调用实际怎么流"的四个例子。四条链路共用同一个会话模型，所以一次对话可以在它们之间接续。差别集中在两件事：谁拥有终端、走哪条输出通道。

| Case | 用户做什么 | 谁拥有终端 | 输出形态 |
| --- | --- | --- | --- |
| ① 全屏交互 | 敲 `step` | `apps/cli/src/ui`（与 `step` 同进程） | 全屏界面，实时渲染 |
| ② 直接出结果 | `step -p "…"` | 没人接管，普通标准输出 | 纯文本；`--mode json` 时逐条事件 |
| ③ 被别的程序调用 | `step --sdk-stdio` | 没人接管，走**原始**输出通道 | 带长度前缀的消息帧 |
| ④ 语音 | `step voice` 或界面里 `/voice` | 沿用 ① 或 ②，语音额外挂上 | 语音播报 + 原文字事件（当前为桩，见 §7） |

还有 `step --mode rpc`，也是"被别的程序调用"，但按行分帧、不是长度前缀。它与 ③ 的调用形态一样，下面不单独画图；**但验收必须分别覆盖**——两条协议名字相近，是最容易被误当成同一条的地方。

**① `step` → 全屏界面**（最主要的路径，同进程）

~~~mermaid
sequenceDiagram
  participant U as 用户终端
  participant CLI as apps/cli/src/main.ts
  participant P as packages/coding-agent
  participant S as coding-agent/core 的会话
  participant T as apps/cli/src/ui（TUI）
  U->>CLI: step
  CLI->>CLI: 读参数 → 判定"全屏交互"
  CLI->>CLI: 初始化配置、埋点、登录态、注册扩展
  CLI->>P: 创建编码助手
  P->>S: 创建会话
  CLI->>T: dispatchStepAppMode → InteractiveMode.run()，交出终端
  T->>S: 订阅会话事件
  U->>T: 输入一句话
  T->>S: 提交
  S-->>T: 流式返回（文字 / 工具开始 / 工具结果）
  T->>U: 渲染
  U->>T: Ctrl+C 两次退出
  T->>CLI: 恢复终端并交回控制权
  CLI->>U: 上报埋点 → 返回退出码
~~~

`apps/cli` 只做四件事：读参数、判模式、初始化、最后上报并退出。**判定要全屏之后它不再直接读写终端**，但仍是负责最终清理与退出码的那一层——所以图里最后两步回到它身上。界面只保存光标、滚动、正在输入的内容，**不保存对话内容本身**，所以同一个会话可以用 ② 开始、再用 `step --resume` 在全屏界面接着聊。

**② `step -p "修一下这个测试"` → 直接出结果**

~~~mermaid
sequenceDiagram
  participant U as 脚本 / 管道
  participant CLI as apps/cli/src/main.ts
  participant M as apps/cli/src/modes/print
  participant P as packages/coding-agent
  participant S as coding-agent/core 的会话
  U->>CLI: step -p "修一下这个测试"
  CLI->>CLI: 读参数 → 判定"非交互"（显式 -p，或检测到输出被重定向）
  CLI->>CLI: 接管标准输出 —— 在任何初始化之前
  CLI->>P: 创建编码助手
  P->>S: 创建会话
  CLI->>M: runPrintMode，带上会话
  M->>S: 提交这一句
  S-->>M: 流式返回会话事件
  M->>U: 纯文本；--mode json 时按 contracts/wire 逐条输出
  M-->>CLI: 本轮结束
  CLI->>U: 上报埋点 → 返回退出码
~~~

**全程没有人接管终端**。"接管标准输出"是把日志、警告挪到另一条通道，保证结果干净——所以它必须发生在任何会打印东西的初始化之前。机器可读格式的定义归 `contracts`，`apps/cli` 只按定义序列化，不自己决定字段。`print` 与 `json` 共用同一条 headless 路径（`runPrintMode` + `toPrintOutputMode`）。

**③ `step --sdk-stdio` → 别的程序把它当后端调用**

~~~mermaid
sequenceDiagram
  participant H as 外部程序
  participant CLI as apps/cli/src/main.ts
  participant B as apps/cli/src/bootstrap/stdout-capture
  participant M as apps/cli/src/modes/sdk-stdio
  participant S as coding-agent/core 的会话
  H->>CLI: 启动 step --sdk-stdio
  CLI->>B: 模块顶层：captureRawStdout() 先留出原始通道
  B->>B: 之后 main() 才接管标准输出
  CLI->>M: createSdkStdioMode({ writeFrame })，进"长度前缀消息"模式
  M->>S: 创建会话
  H->>M: 发一帧请求
  M->>S: 转成会话输入
  S-->>M: 会话事件
  M->>H: 沿原始通道写回一帧
~~~

**这里有一条不能颠倒的顺序**：分帧靠"消息头写明长度、后面跟内容"，必须写原始输出流，所以要在接管标准输出**之前**先把原始写入通道留出来。现在这个顺序靠 `main.ts` 模块顶层语句（`captureRawStdout()` 在 line 102、先于 `main()`）保证，并有 `check-browser-smoke` 之外的逐字节对接验收兜底：**顺序反了不会报错，只会让对接方收到一堆脏字节。**

四个名字相近、命运不同的东西一次说清（最容易误删的地方）：

| 名字 | 是什么 | 现状 |
| --- | --- | --- |
| `--sdk-stdio` | 长度前缀分帧协议 | 留 |
| `--mode rpc` | 按行分帧协议 | 留 |
| 远程 CBOR 通信 | 旧的 `client`/`server`/`protocol` 三个包 | **已删**（见 §11） |

**④ `step voice` / `/voice` → 语音**（设计链路，当前未接线）

~~~mermaid
sequenceDiagram
  participant U as 用户
  participant CLI as apps/cli/src/main.ts
  participant P as packages/coding-agent
  participant S as coding-agent/core 的会话
  participant V as packages/voice-agent
  participant D as packages/extensions/realtime-voice
  U->>CLI: step voice
  CLI->>D: 仅此时注册音频设备驱动
  CLI->>P: 创建编码助手
  P->>S: 创建会话
  CLI->>V: createInteraction，注入 session handle
  V->>S: 订阅（voice model 固定 toolCall:false）
  U-->>V: 语音输入
  V->>S: 转写 → AgentInput
  S-->>V: AgentEvent / 工具结果
  V-->>U: 播报
~~~

`/voice` 是 surface 切换，不是切到第二个拥有工具的 Agent：`voice-agent` 拿到的是一个符合接口的会话句柄，谁给的它不关心，它与 `coding-agent` 之间没有 import 边。**当前 `voice-agent`/`realtime-voice` 是第一期桩**，图里 `CLI→D`、`CLI→V` 两条注入边尚未在组装根接线（§7）；权限审批在语音 surface 上的归属也是首期降级到文本确认（§7）。

## 4. 边界规则即机器门禁

这套架构的边界不是文档约定，而是 `npm run check` 里 14 条脚本门禁，越界即构建失败：

| 门禁 | 强制的不变量 |
| --- | --- |
| `check-layer-direction` | 跨包/跨层的依赖方向（4 条规则，详见 §3.4） |
| `check-ui-layer` | 宿主 UI 内部 host > runtime > view > state 的方向（4 条规则，详见 §3.5） |
| `check-tui-no-ai` | `packages/tui` 保持纯渲染：运行时依赖限于渲染白名单，源码不得引用任何内部 scope 或 AI/LLM SDK |
| `check-contracts-deps-empty` | `packages/contracts` 的 dependencies/peer/optional 全空（只许 devDependencies），wire 编解码零运行时副作用 |
| `check-no-provider-dispatch` | `providers/src/api/**` 内禁止按厂商名选协议：无 `switch(provider)`；`model.provider === "字面量"` 必须登记在 `adapter-provider-quirks.json` |
| `check-metadata-not-in-dispatch` | dispatch 点（api/**、dialect/**、models.ts、compat.ts）不得 import `metadata/`，成本/上下文元数据只作遥测，不进协议选择 |
| `check-derived-compat-only` | 旧 provider→dialect 推导仅限 `dialect/resolve.ts`；`"derived-from-provider"` 不得出现在 adapter 选择区 |
| `check-no-secret-leak` | `providers/src/availability/**`、`dialect/**` 里禁止把凭据类变量插进字符串，探测原因/trace/遥测不带明文密钥 |
| `check-legacy-scope-prefix` | 产品源码只用 `@step-harness/*` scope，旧 `@earendil-works/pi-`、`@mariozechner/pi-` 仅在两处兼容面豁免（扩展加载器映射、主题 Symbol 键） |
| `check-coding-agent-entry-freeze` | 冻结 `coding-agent` 的入口面：bin 键与 exports 子路径只能是基线快照的子集（可减不可增） |
| `check-workspace-registry` | 两处 glob（pnpm-workspace.yaml 与根 package.json）完全一致；每个成员都有登记行；非示例成员必须用 `@step-harness/*` scope |
| `check-ts-imports` | 非声明 `.ts` 文件里禁止相对 `.js` import，源码只引用 `.ts`/无后缀/子路径 specifier |
| `check-pinned-deps` | 所有外部直接依赖固定精确版本，拒绝 `^`/`~`/`*`（跳过 `@step-harness/*` 与 workspace:/file: 等非 registry specifier） |
| `check-browser-smoke` | esbuild 打 browser/agent-treeshake 冒烟入口，断言选择性 provider bundle 正确 tree-shake |

## 5. bin 与进程入口

**`apps/cli` 是唯一真实入口**：`@step-harness/cli` 声明 `bin.step → ./dist/main.js`，`apps/cli/src/main.ts` 是唯一进程入口。它先设产品信号（`process.title=step`、`AI_AGENT=step`），引导 env/config/遥测，内联处理顶层子命令（logout/mcp/login/feedback/update/config），其余交给 `prepareMain()` 完成 argv→装配→mode 决策，再由 `dispatchStepAppMode()` 分发五种 mode：

| mode | 落点 |
| --- | --- |
| interactive | `apps/cli/src/ui`（TUI） |
| print / json | 同一条 headless 路径（`runPrintMode`） |
| rpc | JSONL RPC（`runRpcMode`） |
| sdk-stdio | 长度前缀 JSON 帧 host，在 `prepareMain` 内就地完成 |

`packages/coding-agent` 也声明了 `bin.step → dist/bundle/step.js`，但这**不是第二个入口**：它是 `scripts/build-coding-agent-bundle.mjs` 把 `apps/cli` 编译后的 main 用 esbuild 打成的单文件再发射（脚本头注释明确“The process entry moved to the @step-harness/cli app (S3)”）。它由 `check-coding-agent-entry-freeze` 以“只减不增”的方式冻结，并计划在 S3 完全落地后从 coding-agent 移除。

bun 单文件二进制入口是 `apps/cli/src/bun/step-cli.ts`（薄封装：装 Bun 专属 hook 后 `await import("#main")`），由 `scripts/build-binaries.sh` 用 `bun build --compile` 编译。承载入口路径的真正落点是 `build-coding-agent-bundle.mjs` 与 `build-binaries.sh`，`infra/release/release-targets.json` 只声明产物 `id/archiveType/binary`，不含入口路径。

## 6. AI：按 wire dialect 分流，不按厂商

`packages/providers` 把两条轴分开，**协议 dispatch 的唯一 key 是 `model.api`，永不用厂商名选 adapter**：

- **`ModelApiDialect`（`model.api`）**——线上请求/响应的 wire 格式，决定序列化、流解析、错误归一化。当前 `KnownApi` 恰好 3 个值，对应 `providers/src/api/` 下 3 个 adapter：`openai-completions`、`openai-responses`、`anthropic-messages`（`Api = KnownApi | (string & {})` 仍允许 models.json 自定义 provider 声明任意 api 字符串）。
- **`ProviderProfile`（`model.provider`）**——endpoint、认证、模型目录、展示名、遥测身份。内建构造的 profile 有两个：`anthropic`、`openai`（`providers/src/providers/all.ts`）；`models.generated.ts` 的顶层目录键也正是这两个。测试用 `faux` provider 供 coding-agent 测试 harness 使用。

**StepFun 供应商**是产品的默认 provider（`STEP_PROVIDER_ID = "step"`，`STEP_DEFAULT_PROVIDER`），作为供应商层一等公民住在 `providers/src/step-provider/`（含 `index.ts`、`callback-server.ts`、`StepModelConfig`、`STEP_MODELS`）。它不在 `all.ts` 里静态构造，而是由 `apps/cli/src/main.ts` 在运行时 `registerProvider(STEP_PROVIDER_ID, …)` 注册；它的模型被归一化为 `anthropic-messages`，即**骑在既有 dialect 上**，而不是新增一个 step 专属 adapter。

分发的核心恒等式：`createProvider` 里 `apiFor = single ?? byApi?.[model.api]`，`compat.ts` 的 `getApiProvider(model.api)`；dialect 解析优先级为 显式 `model.api`（`declared`）→ `profile.defaultApi`（`derived-from-provider`）→ `deriveFromLegacyProvider()`（唯一合法的旧映射家，今天对所有 provider 返回 undefined）。派生来源只进遥测，不作为 dispatch 输入（由 `check-derived-compat-only`、`check-metadata-not-in-dispatch` 焊死）。

新增服务商时优先新增 `ProviderProfile`；只有对端 wire 格式不同才新增 dialect adapter。“厂商”不等于“协议”，也不等于“extension”。

## 7. voice-agent：语音通道，不是第二个主 Agent

`voice-agent` 与 `coding-agent` 平级，但角色不对称。它实现 `@step-harness/contracts` 里的 `VoiceInteraction`，`attach` 到一个已存在的 `AgentSessionHandle`，把语音 turn 转成 `AgentInput`、把 `AgentEvent` 转成播报，**不拥有 Agent loop、不拥有工具、`modelPolicy.toolCall` 写死为 `false`**。它只依赖 `contracts` 和 `realtime`，不 import `coding-agent`。

典型链路：宿主创建 coding session → 创建 voice interaction → 把 session handle 注入 voice → 语音转写送进 `session.send()` → coding 的事件/工具结果由 voice 播报。`/voice` 是 surface 切换，不是切到一个拥有另一套 loop 的语音产品。

**权限审批事件的归属**是语音 surface 的关键约束：coding session 触发 bash/write 审批时，决策权始终在宿主（组合根），不在 voice-agent。voice-agent 只负责播报请求、把用户语音回应转成 canonical 输入，不得自行构造 approval 响应，也不得把这类阻塞事件落进 default 分支被静默丢弃。首期默认策略是**降级到文本确认**——因为 ASR 置信度不应直接当成不可逆授权信号。

当前语音栈是**第一期桩**，组装根接线（S6-4）延后：

- `packages/realtime`：纯类型契约，零运行时依赖（`AudioFrame`、`RealtimeDriver`、`InterruptSignal`、`Turn`、`VadEvent` 等）；
- `packages/voice-agent`：可编译的工作桩，`attach()` 建立音频 session 并订阅，但不做真实设备 I/O；`RealtimeDriver` 由组装根注入；
- `packages/extensions/realtime-voice`：设备驱动 extension 的 mock 实现（`createMockCapture/Playback/Bridge`，无真实 ASR/TTS/传输），只 import `realtime`，仅当选中语音 surface 时才由组装根加载——所以正常编码启动不会加载音频 SDK 或打开麦克风。

## 8. extensions 与 TypeScript extends

**extension** 是可替换的外部实现（外部协议、设备、可选 SDK），由 app 组装根显式静态注册，不按目录/字符串隐式扫描。判据是：能否被关闭/替换/按宿主选择、是否依赖可选外部 SDK/设备、是否有独立生命周期或测试矩阵、是否被两个以上宿主经稳定 contract 使用。当前唯一的 extension（`realtime-voice`）住在 `packages/extensions/*` 下——与被删除前的 `session-backends/*` 同构；单个 extension 不足以支撑一条独立的顶层 `extensions/` 轴，所以并入了 `packages/extensions/`。

**TypeScript `extends`** 只表示 tsconfig 配置继承，不建立运行时依赖、不注册 extension、不表示类继承。运行时依赖必须写在 `package.json`，公共 API 必须经 `exports` 暴露。`voice-agent` 不是 `coding-agent` 的子类，而是通过 composition 挂载的输入输出 adapter——两者共享 `AgentSessionHandle`/`AgentEvent` 契约，不用 `class extends`。

三代扩展 specifier 并存（`@step-harness/*` 新 + `@earendil-works/pi-*` + `@mariozechner/pi-*`）仅存活在两处豁免的产品源码里：扩展加载器（`coding-agent/src/core/extensions/loader.ts` 的 `VIRTUAL_MODULES` 与 `getAliases()`）和主题 Symbol 键（`coding-agent/src/theme/theme.ts`）。这是只加不减的向后兼容，由 `check-legacy-scope-prefix` 强制其余源码只用新 scope。

## 9. TypeScript / tsconfig 硬前提

`tsconfig.base.json` 有四项全库硬前提，各包的 `tsconfig.build.json` 继承它，**不能改也不能省**：

| 选项 | 为什么不能动 |
| --- | --- |
| `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` | 全库相对 import 都写 `.ts` 后缀，由 `check-ts-imports` 门禁强制；去掉这两项每个源文件都解析失败 |
| `module` / `moduleResolution: "Node16"` | base 的实际取值；根 `tsconfig.json` 仅为全量 `--noEmit` 检查覆写为 `NodeNext`，各包 build 配置继承的是 Node16 |
| `erasableSyntaxOnly` | 约束源码只用可擦除 TS 语法，与 bun/esbuild 转译前提绑定 |

新增包时继承 base 并只补本包字段；`paths` 指向兄弟包的 `dist/*.d.ts`（已构建声明文件）而非 `src/*.ts`，这是构建顺序能生效的原因。历史上指向不存在的 `packages/agent-old` 的死 alias（`@earendil-works/pi-agent-old`）已在重构中（`S7-3`）清除。

## 10. 仍在 coding-agent 内、尚未抽取的部分

以下能力仍在 `packages/coding-agent/src` 内，尚未独立成包（交互式 TUI 是唯一已抽出到 `apps/cli/src/ui` 的）：

| 能力 | 当前位置 | 说明 |
| --- | --- | --- |
| session-manager | `core/session-manager.ts`（+ `-factory`/`-cwd`/`-export`） | 仍是 CLI 的会话权威；契约已在 `contracts/in-process` |
| 工具集 | `core/tools/`（bash/read/write/edit/grep/find/ls…） | 与 AGENTS.md “工具契约属于 coding-agent”一致，从未打算外提 |
| in-process SDK | `core/sdk.ts` + `index.ts` barrel | barrel 刻意拓宽，让已迁出的 TUI 能 import 这些符号；`step/sdk.ts` 是选 step 存储根的薄封装 |
| agent-session-runtime | `core/agent-session-runtime.ts` | 会话装配仍是 coding-agent 内部模块 |
| MCP | `step/plugins.ts` | 声明入口仍在产品包 |

抽取判据是依赖方向、测试边界、生命周期三选一（“独立发布”在全私有仓库不成立）。将来若要抽取，顺序不变：**先冻结中立 contract，再移动实现**，且每步要有第二个消费者或明确依赖收益。当前未建、留待证据触发的候选：`apps/tui`（现并入 `apps/cli/src/ui`）、`packages/session`、`packages/tools`、`packages/sdk`、`packages/agent-runtime`、`packages/storage`、`packages/web`、`apps/desktop`、`extensions/llm`、`extensions/mcp`。

## 11. 关键判断汇总

| 主题 | 结论 |
| --- | --- |
| 包管理器 | 统一 pnpm；无 npm shrinkwrap/install-lock 门禁 |
| CBOR 远程会话 | 已完整删除：`packages/client`/`server`/`protocol` 不存在，`agent` 已更名 `agent-core`；残留的 `*PROTOCOL_VERSION*` 是 JSONL/SDK-stdio 协议，不是 CBOR |
| pi 兼容 | pi 命令与兼容层已全删，不做兼容 |
| 宿主 | 只有 `apps/cli`，TUI 内建在 `src/ui`；`apps/desktop`/`apps/tui` 未建 |
| 产品 vs 交互 | `coding-agent` 与 `voice-agent` 平级、互不 import |
| AI | `model.api`（3 个 dialect）是唯一 dispatch key；provider 只描述身份；step 骑 anthropic-messages |
| voice | `/voice` 是 surface 切换而非第二个 loop；`toolCall:false` 写死；权限默认降级到文本确认；当前为桩 |
| 拆包判据 | 依赖方向 / 测试边界 / 生命周期三选一；“独立发布”在全私有仓库不成立 |
| 边界 | 由 14 条 `check-*.mjs` 门禁机器强制，不放宽 |
