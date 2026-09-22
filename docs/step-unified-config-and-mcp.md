# StepCode 统一配置与 MCP 支持 — 技术文档

本文对应分支 `feat/unified-step-config-mcp` 的整体改动:把原先分散在
`settings.json` / `step-settings.json` 的配置统一到 `config.toml`,把凭据与模型
目录从 `agent/` 上提一层,并在此基础上实现 MCP(Model Context Protocol)的服务
发现、连接、工具注册、OAuth 登录与一整套 `step mcp` 指令。

---

## 1. 实现了哪些功能

### 1.1 统一配置文件 `config.toml`

改动前 Step 有三份配置来源:

| 来源 | 内容 |
| --- | --- |
| `~/.stepcode/agent/settings.json` | Pi 原生设置(主题、默认 provider/model、thinking、compaction…) |
| `~/.stepcode/agent/step-settings.json` | Step 产品设置(permissionPreset、approvalMode、autoResume、feedbackEnabled…) |
| 无 | MCP 没有配置位置 |

改动后统一为一份 TOML:

```
~/.stepcode/config.toml            # 全局
<cwd>/.stepcode/config.toml        # 项目级(可选)
```

三类内容并存于同一文档:Pi 原生设置在根表,Step 产品设置在根表,MCP 在
`[mcp_servers.<name>]` 子表(Codex 风格)。

关键点:

- **单一真相**:`createStepSettingsManager` 把 Pi 的 `SettingsManager` 与 Step
  装饰器指向同一份路径。任何在 CLI 内改的设置(`/theme`、权限预设、审批模式等)
  都写回 `~/.stepcode/config.toml`,`step` 二进制**不再创建** `settings.json`。
- **项目文件可选**:缺失即"无项目级设置",不报警告、不自动创建;只有显式保存
  项目设置时才会建文件。
- **TOML 不支持 null**:写入前用 `stripNullValues` 剥离,避免序列化失败。
- **保留头部注释**:`readLeadingComments` 在重写时把文件开头的注释块带回去。

### 1.2 目录布局调整

`auth.json` 与 `models.json` 从 `~/.stepcode/agent/` 上提到 `~/.stepcode/`,与
`config.toml` 平级。新增 `resolveStepConfigRoot()` 作为这一层的唯一解析入口。

### 1.3 MCP 服务发现 / 连接 / 工具注册

- 从全局 `config.toml` 的 `[mcp_servers]` 读取声明,再叠加插件目录里的声明。
- 两种传输:`command` → stdio(`StdioClientTransport`),`url` → HTTP
  (`StreamableHTTPClientTransport`)。
- 连接成功后把远端工具批量注册进工具注册表,供模型直接调用。
- `enabled = false` 的条目在发现阶段就跳过。

### 1.4 工具级安全控制

`enabled_tools` / `disabled_tools` 在**目录进入注册表之前**过滤。这是安全控制而
不是提示词约束:用户写了 `enabled_tools` 就是期望其余工具完全不可达,不能指望
模型"自觉不调用"。

### 1.5 HTTP 鉴权头

- `bearer_token_env_var = "FOO"` → `Authorization: Bearer $FOO`
- `http_headers` → 字面头
- `env_http_headers` → 值是**环境变量名**,取不到时**直接报错**而不是省略该头
  (省略只会发出一个未鉴权请求,然后拿到一个语焉不详的服务端错误)

### 1.6 MCP OAuth 登录

`step mcp login <name>` 走完整 OAuth 流程:动态客户端注册 → PKCE → 本地
`127.0.0.1` 回调监听 → 换取 token → 落盘 `~/.stepcode/.credentials.json`
(0600,先写临时文件再 rename)。运行期使用非交互 provider,未登录时抛出
`MCP server 'X' requires login; run step mcp login X`。

### 1.7 `/mcp` 状态视图

交互模式内 `/mcp` 显示每个服务器的 `connecting` / `connected` / `failed` /
`disabled` 及工具数量。

---

## 2. 新增了哪些指令

### 2.1 顶层命令

| 指令 | 说明 |
| --- | --- |
| `step mcp list [--json]` | 列出全局 `config.toml` 中所有 MCP 服务器 |
| `step mcp get <name> [--json]` | 查看单个服务器声明;不存在时 exit 1 |
| `step mcp add <name> --url <url> [--bearer-token-env-var VAR]` | 新增 HTTP 服务器 |
| `step mcp add <name> [--env K=V]... -- <command> [args...]` | 新增 stdio 服务器 |
| `step mcp remove <name>` | 删除服务器声明 |
| `step mcp login <name>` | 对 HTTP/SSE 服务器执行 OAuth 登录 |
| `step mcp logout <name>` | 清除该服务器的本地凭据 |

`add` 的参数校验(全部会给出用法并 exit 1):

- 名称缺失或重名
- 既没有 `--url` 也没有 `--`(无 command)
- `--url` 与 command 同时给出
- `--bearer-token-env-var` 用在非 HTTP 服务器上
- `--env` 用在 `--url` 服务器上 —— `--env` 设置的是**进程环境变量**,不是 HTTP
  头,悄悄改写语义会存下传输层根本不会发送的值

`--` 之后的内容全部视为服务器自身 argv:扫描不能越过 `--`,否则服务器自己的
`--url` / `--env` 参数会篡改 Step 即将写入的条目。

### 2.2 交互命令

| 指令 | 说明 |
| --- | --- |
| `/mcp` | 显示 MCP 服务器状态与工具数 |

---

## 3. 是如何实现的

### 3.1 `src/step/config-toml.ts`(新增,234 行)

统一配置的唯一权威:

- `resolveStepConfigPath(env, cwd?)` —— 全局文件解析自 agent 目录的**兄弟目录**
  而不是 home。否则宿主注入 `STEP_CODING_AGENT_DIR` 时,MCP 发现和
  `step mcp add` 会写到与 settings manager 不同的文件里。
- `ensureStepConfigFile(path)` —— `mkdir 0700` + `writeFileSync(..., flag: "wx")`,
  竞争到 `EEXIST` 时静默接受。
- `readStepConfig(path)` —— `readFileSync` 放在 `try` **之外**,让 `ENOENT` 原样
  抛出,调用方才能区分"文件不存在"和"TOML 非法"。
- `writeStepConfig(path, doc)` —— 写 `path.<pid>.tmp` 再 `renameSync`,保证原子。
- `readGlobalStepDefaults(env)` —— 在 Pi 的 SettingsManager 建立之前同步读取
  `defaultProvider` / `defaultModel` / `telemetry.*`。这一步必须存在:静默丢弃
  `telemetry.enabled = false` 等于把用户关掉的上报又打开。
- `updateGlobalMcpConfig(env, fn)` —— 读改写整体包在 `acquireSettingsLockSync` 内。
- `StepTomlSettingsStorage` —— 实现 Pi 的 `SettingsStorage` 接口,把 TOML 文档
  (剥掉 `mcp_servers`)以 JSON 字符串形式交给 Pi,写回时再把 `mcp_servers`
  合并回去。

### 3.2 `src/step/mcp.ts`(+294 行)

- `discoverStepMcpServers(cwd, trusted)` —— 先读全局 `config.toml`,再读插件目录。
- `connectStepMcpServer(input, signal?)` —— 按 `command` / `url` 分流传输;超时用
  `AbortSignal.any([AbortSignal.timeout(t), signal])`,并挂 `closeOnAbort`。
- 超时拆分:原来一个 `MCP_TIMEOUT_MS = 30_000` 同时管启动和调用,现在分成
  `MCP_STARTUP_TIMEOUT_SEC = 30` 与 `MCP_CALL_TIMEOUT_SEC = 300`,并可被
  `startup_timeout_sec` / `tool_timeout_sec` 覆盖。
- 状态数组 `currentMcpStatuses` + `getStepMcpStatuses()` / `formatStepMcpStatuses()`
  供 `/mcp` 读取。
- `session_shutdown` 先 `controller.abort()` 再 `await startup`,确保被替换的
  会话不会把迟到的工具或警告灌进新会话。

### 3.3 `src/step/mcp-oauth.ts`(新增,287 行)

- 凭据 key 为 `` `${name}|${url}` ``,同名不同地址不会串号。
- CSRF `state` 用 `randomBytes(32)` 生成,比较用 `timingSafeEqual`(带长度预检)。
- 回调端口:`callback_port ?? 0`。**声明了端口就必须用这个端口** —— 只接受预注册
  redirect URI 的 provider 会拒绝其它端口,端口被占用必须报错而不是悄悄换一个。
- **不传 `resourceMetadataUrl`**,把 RFC 9728 元数据发现交给 SDK。自己拼的 URL 会
  丢掉资源路径(`https://host/mcp`),而且显式 URL 会关掉 SDK 的路径感知发现和根
  路径回退,导致所有发布路径后缀文档的服务器全部失败。
- `void code.catch(() => undefined)` —— 流程可能在任何人 await `code` 之前就失败,
  必须常挂一个 handler,否则迟到的 rejection 会以 unhandled rejection 崩掉 CLI。
- 回调响应:路径不对 404,state 不匹配 400,带 `error` 参数 400,缺 code 400,
  成功 200。

### 3.4 `src/core/extensions/`

新增批量注册 API:

```ts
registerTools(tools: readonly ToolDefinition[]): void
```

一次写入全部工具,只 `refreshTools()` 一次。

---

## 4. 实现过程遇到的问题与解决

### 4.1 MCP 加载导致 TUI 启动延迟(核心问题)

**现象**:用户反馈本分支启动后,TUI 顶部 logo 区与输入框比 `main` 晚 2~3 秒才
出现。

**定位**:三条独立的原因叠在一起。

**原因一:`session_start` 阻塞在 `Promise.all`。**
原实现在 `session_start` 里 `await Promise.all(servers.map(connect))`,整个会话
初始化被最慢的那台服务器拖住。真实 PTY 复现:一台本地 stdio MCP 把 `tools/list`
拖了 4 秒才返回 140 个工具,这 4 秒里 TUI 什么都画不出来。

**解决**:把启动过程从 `session_start` 的 await 链上摘下来,只有交互 TUI 走这条
分支;print / RPC 调用方仍然等待初始工具目录,因为它们提交任务前需要完整目录。

```ts
startup = (async () => {
    await yieldToEventLoop();                 // 先让会话挂载完
    const discovered = await discoverStepMcpServers(...);
    await Promise.all(discovered.map(async (item) => { ... }));
})().catch(...);
if (ctx.mode !== "tui") await startup;         // 仅 TUI 分离
```

**原因二:首帧在扩展绑定之后才画。**
`interactive-mode.ts` 原来是 `await this.rebindCurrentSession()` 再
`renderInitialMessages()`,即"先绑扩展、后渲染"。扩展启动(MCP 发现、连接、注册)
耗时无上界,首帧就被无限期推后。

**解决**:改用已有的 `rebindCurrentSession({ renderBeforeBind: true })`,并在该分支
里补一次 `this.ui.renderNow()` —— 不能指望某次 await 期间队列里的渲染被冲刷出去,
必须显式提交这一帧,才能保证 header 和编辑器先可见。

**原因三:逐个注册工具 → 每个工具重建一次系统提示词。**
`registerTool` 每次都会 `refreshTools()`,进而重建 Step 系统提示词。140 个工具就是
140 次重建。在本 worktree 单独 profile:**140 次 prompt 重建同步耗时 3972 ms**,
这段是纯同步的,直接把键盘回显冻住。

**解决**:
1. 新增 `registerTools([...])` 批量 API,每台服务器只刷新一次注册表;
2. 发布前 `await yieldToEventLoop()`,让刚好在循环忙碌时完成的服务器不会抢占输入
   和渲染;
3. 系统提示词里的 git 信息按 cwd 缓存(TTL 5 s)。原来每次重建都要两次同步
   `spawnSync("git", ...)`(约 29 ms),注册风暴期间被重复付费。

**效果**(真实 PTY 连续输入探针):等待服务器返回期间**最大回显延迟 6.6 ms**;
目录开始发布之后**最大 162 ms**。

**必须说清楚的一点**:做完上述三项后,我实测了本分支与 `main` 的 `pnpm step`
首帧时间:

| 分支 | 首帧时间 |
| --- | --- |
| main | 2867 / 3216 / 2327 / 2194 ms |
| 本分支 | 3094 / 2571 / 3668 / 2741 ms |

两者在同一区间,**本次改动没有引入启动回归**。剩下的 2~3 秒是
`pnpm step`(= `tsx --tsconfig tsconfig.json .../stepcode.ts`)开发态每次启动都要
转译整个 TS 源码图的固有成本,`main` 上同样存在,与 MCP 无关。若要消除,需要单独
做一个预打包的 `step:fast` 入口,不在本次范围内。

### 4.2 设置写入与 `mcp_servers` 互相覆盖

Pi 的 `SettingsStorage.withLock` 只认识"设置"这一层,它拿到的字符串里没有
`mcp_servers`。如果读、改、写不在同一个临界区,另一个会话在中间写入就会丢失;而且
写回时必须把**同一次读**里的 `mcp_servers` 合并回去,否则 `/theme` 一改就会把用户
所有 MCP 配置抹掉。

**解决**:`StepTomlSettingsStorage.withLock` 把读—变换—写整体锁在
`acquireSettingsLockSync` 内,并从同一次 `readStepConfig` 结果里取 `mcp_servers`
合并回去。

配套地把 `acquireLockSyncWithRetry` 从 `FileSettingsStorage` 的私有方法提升为导出的
`acquireSettingsLockSync`,让所有落盘的 settings storage 走同一把锁。

### 4.3 `STEP_CODING_AGENT_DIR` 相对路径

`resolveStepConfigRoot` 早期实现是给 agent 目录拼 `".."`。字符串拼接是文本操作:
相对路径的 `STEP_CODING_AGENT_DIR` 会把凭据写到进程当前工作目录旁边,而且进程一旦
`chdir` 位置还会再变。

**解决**:先 `resolve()` 成绝对路径再取 `dirname()`;若已经是文件系统根,则退回
agent 目录本身,而不是把凭据写到宿主指定的命名空间之外。

### 4.4 OAuth 借用了 Codex 的应用身份

早期实现硬编码了 Codex 的 client id,导致授权页面显示 "Figma MCP in Codex"。该硬编码
已移除,**不得恢复或借用 Claude / Codex 的应用身份**。

官方 Figma MCP 对 Step 返回 403,现在会给出明确指引:

> Step does not support figma mcp. You can use https://github.com/GLips/Figma-Context-MCP
> in StepCode as an alternative to the official Figma MCP.

### 4.5 构建产物污染测试

`dist/**/*.test.js` 被 vitest 收集到。`tsconfig.build.json` 增加
`"src/**/*.test.ts"` 到 `exclude`。

### 4.6 项目信任列表

`config.toml` 承载项目级设置(扩展路径、审批预设),所以只带这一个文件的项目也必须
过信任提示 —— 把它加入 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`。但当 cwd 就是
`$HOME` 时,项目路径会解析到用户自己的全局配置,提示等于让用户信任自己的设置,而且
一次"不信任"会被 `$HOME` 下所有项目继承 —— 因此用 `USER_GLOBAL_CONFIG_RESOURCES`
把 `config.toml` 从这种情况下排除。

同时把已退役的 `step-settings.json` 从信任列表移除。

---

## 5. `~/.stepcode` 目录说明

```
~/.stepcode/
├── config.toml                       # ★ 统一配置:Pi 原生设置 + Step 产品设置 + [mcp_servers]
├── auth.json                         # ★ Step provider 凭据(0600),由 step login 写入
├── models.json                       # ★ 模型目录/覆盖(从 agent/ 上提)
├── .credentials.json                 # ★ MCP OAuth 令牌(0600),key = "<name>|<url>"
├── device-id                         # 设备标识,遥测用
├── agent-compat.json                 # stepcode 兼容层状态
├── config.json                       # stepcode 兼容配置(端点/凭据来源)
├── models-store.json                 # 模型运行时缓存
├── workspace-trust.json              # 工作区信任决策
├── .legacy-step-cli-migration.json   # 旧目录迁移标记(避免重复迁移)
├── .legacy-step-harness-migration.json
├── bin/                              # 已安装的 step 可执行文件与版本
├── clients/                          # 客户端注册信息
├── logs/                             # 运行日志
├── marketplaces/                     # 插件市场索引
├── sessions/                         # 顶层会话记录
├── skills/                           # 用户级 skills
├── telemetry/                        # 遥测缓冲(spool)
└── agent/                            # Pi agent 命名空间
    ├── prompts/                      # 用户自定义 prompts
    ├── sessions/                     # agent 会话记录
    ├── trust.json                    # 项目信任存储(ProjectTrustStore)
    ├── bin/
    ├── models-store.json
    ├── auth.json                     # ▲ 旧位置,迁移后不再写入
    ├── models.json                   # ▲ 旧位置,迁移后不再写入
    ├── settings.json                 # ▲ 已退役:step 不再创建/读取,旧安装里的残留
    └── step-settings.json            # ▲ 已退役:不再读写,也不再纳入信任提示
```

带 ★ 的是本次改动后的主要落点;带 ▲ 的是历史文件,老安装里会残留,可以安全忽略,
其中的设置需要手工搬到 `config.toml`。

项目级配置在 `<项目>/.stepcode/config.toml`,可选,受项目信任门控。

### `config.toml` 示例

```toml
# StepCode configuration

theme = "step-dark"
defaultProvider = "step"
defaultModel = "step-2"
permissionPreset = "standard"
autoResume = true

[telemetry]
enabled = true

[mcp_servers.local-tools]
command = "node"
args = ["./mcp-server.js"]
env = { LOG_LEVEL = "info" }
startup_timeout_sec = 30
disabled_tools = ["dangerous_tool"]

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
tool_timeout_sec = 300

[mcp_servers.remote.oauth]
callback_port = 8976
```

---

## 6. 已知限制 / 后续项

- `oauth.scopes` 是中间字段,尚未接入授权请求。
- `enabled = false` 的服务器在发现阶段被跳过,不会出现在 `/mcp` 列表里。
- 工具名仍是旧的拼接方式,尚未改成 `mcp__<server>__<tool>`。
- `/mcp` 快照是模块级全局变量,不是按会话隔离。
- `step mcp list|get --json` 未做敏感值脱敏。
- `src/step/settings-manager.ts` 头部注释与 `docs/step-integration.md` 中"sidecar"
  的措辞已部分过时。

---

## 7. 验证情况

- `npm run check` 通过。
- 5 个测试文件 / 37 个用例通过(含新增的 `mcp-startup.test.ts`、
  `step-mcp-oauth.test.ts`)。
- 真实 PTY 启动对比:本分支与 `main` 首帧时间同区间,无回归(见 §4.1)。
- 真实 PTY 输入探针:等待期最大回显 6.6 ms,发布期最大 162 ms。
