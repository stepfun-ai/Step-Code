# Step CLI 统一配置、MCP 管理与 OAuth 执行计划

创建：2026-09-09。更新：2026-09-10。
状态：实施中，不能视为整体完成。本文替代原始方案及对话中的中间设计；
“已实现”以当前工作区代码为依据，“已验证”只指下文记录的实际验证。

## 1. Step — 最终目标与已确认的决定

### 配置布局

```text
~/.step-cli/
├── config.toml           # 全局普通设置、Step 权限设置和用户 MCP 声明
├── models.json           # 模型/provider 定义，从 agent 目录提升至根目录
├── auth.json             # 模型/provider 登录凭据，从 agent 目录提升至根目录
├── .credentials.json     # MCP OAuth 凭据，成功认证时创建
├── plugins/              # 保留已有声明式插件
└── agent/                # 会话及既有资源目录，不整体迁移

<project>/.step-cli/
├── config.toml           # 可选的项目普通设置和权限覆盖
└── plugins/              # 保留受信项目插件及其 MCP 行为
```

- 不采用独立 `mcp.json`；普通设置、权限设置和 MCP 共用 TOML。
- 全局和项目 `settings.json`、`step-settings.json` 停止作为 Step 配置来源及写入目标。
  用户明确选择不导入旧设置、不做双格式回退；旧文件不主动删除。
- 普通设置保留现有 camelCase 键名，放在 TOML 顶层；嵌套对象对应 TOML 表。
- 全局 TOML 首次启动自动创建，内容可以为空；当前实现创建一行注释。
  已有文件不覆盖，创建使用排他写入以处理并发首次启动。
- 项目 TOML 由开发者按需创建，或显式保存项目设置时创建。
  普通启动、读取、reload 不创建项目文件；缺失文件不报警。
- 受信项目普通设置覆盖全局，嵌套表递归合并、数组替换；保留现有 CLI/env 优先级。
- 新的 `[mcp_servers]` 仅从全局 TOML 加载。项目 TOML 中的 MCP 声明不启动，
  应给出不支持该配置来源的提示；这不取消原有受信项目插件 MCP。
- 模型/provider 的 JSON 格式保留，只调整默认位置。未授权自动移动或删除用户现有文件；
  旧路径迁移不属于本次自动启动行为。
- 普通 Pi 布局不变；StepCode 托管配置的模型和权限权威不变。
- 缺失可选项目文件与损坏文件必须区分；生效配置损坏不得静默覆盖或降级权限。

### MCP 接口与命令

使用 Codex 风格 `[mcp_servers.<name>]`；`command` 为 stdio，`url` 为 Streamable HTTP。
不需要 Claude 的 `type` 字段，也不自动读取 Claude/Codex 用户文件。
本机从 Codex 提取 MCP 表是用户授权的一次性验证操作，不是运行时发现机制。

```toml
permissionPreset = "ask"

[mcp_servers.chrome-devtools]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest"]

[mcp_servers.company]
url = "https://example.com/mcp"
bearer_token_env_var = "COMPANY_MCP_TOKEN"
```

| 配置组 | 目标支持字段 |
| --- | --- |
| stdio | `command`, `args`, `cwd`, `env`, `env_vars` |
| HTTP | `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers` |
| 通用 | `enabled`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools` |
| OAuth | Codex 风格顶层 `scopes`, `oauth_resource`，以及 `oauth.client_id`, `oauth.callback_port`；后续讨论增加可选 `oauth.client_secret` |

目前代码的 `oauth.scopes` 是中间实现字段，且未实际传入授权请求；不能标为已支持。
后续应按原定 Codex 字段接通 scopes/resource，不再引入新的配置别名。
不把“字段已声明”当作“字段行为已实现”。

```text
step mcp list [--json]
step mcp get <name> [--json]
step mcp add <name> -- <command> [args...]
step mcp add <name> --env KEY=VALUE -- <command> [args...]
step mcp add <name> --url <url>
step mcp add <name> --url <url> --bearer-token-env-var TOKEN_ENV
step mcp remove <name>
step mcp login <name>
step mcp logout <name>
/mcp                       # TUI 内查看当前连接状态与工具数
```

- add/remove 只改全局配置；同名 add 不覆盖。`--` 后全部属于子进程 argv。
- `env` 为字面值；`env_vars` 是环境变量名列表，不展开 `${VAR}`。
  `--env` 只用于 stdio，不把它自动解释成 HTTP header。
- list/get 不启动服务器，输出配置来源、启用/本地认证状态；所有输出必须脱敏。
- stdio login 应明确提示不支持 OAuth；当前提示沿用用户要求的
  `"name" doesn't support OAuth login — it's only available for HTTP and SSE servers.`
  文案提及 SSE 不代表已实现独立旧版 SSE transport。
- HTTP 登录错误显示具体阶段与原因，保留可用 HTTP 状态和网络错误，剔除敏感内容。
- remove 只删除配置；logout 清理对应本地 OAuth 凭据，不承诺远端撤销。
- 配置变化和外部终端登录后，重启会话生效；首版不实现热重载。

### OAuth 产品身份

OAuth 是通用 HTTP MCP 能力，不是 Figma 专用实现。支持动态客户端注册，或显式配置
预注册 client ID。授权链接展示并通过系统浏览器打开，凭据按 server 名称和 URL 隔离。

Figma 官方远程 MCP 存在客户端准入限制，当前 Step 动态注册实测返回 403。
曾错误复用 Codex 的 client ID，导致授权页显示 “Figma MCP in Codex”；该硬编码已移除，
不得恢复或借用 Claude/Codex 的应用身份。client ID 可公开不意味着是所有产品的通用身份。
为 Step 接入 Figma 官方 MCP，需要取得 Figma 批准的 Step client；不能将生成授权 URL
等同于完成身份注册或登录。第三方 Figma stdio 服务可作为单独配置的替代方案。

参考：[Figma 官方远程 MCP 文档](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)。

## 2. Tool — 实现边界与当前状态

### A. 统一设置与路径：部分完成

已接入产品层 `config-toml.ts`、`StepTomlSettingsStorage` 及 Step 权限装饰器；
默认全局/项目设置读取和主要写入路径使用 TOML。已停止 CLI 启动时的旧设置迁移调用。
Step 主会话的模型路径、主认证解析及 config 命令中部分路径已提升到根目录。

已修复项目 TOML 缺失警告：读取文件在 TOML 解析错误包装之外进行，保留 ENOENT；
上层按可选文件处理。首次显式写入使用空 TOML，不写无效的 JSON `{}`。

尚需完成：

- 统一所有路径解析：auth 子命令、模型列表、搜索认证回退、config init/show/migrate、
  SDK/会话创建等旁路，不能只验证主 CLI 路径。
- `StepTomlSettingsStorage` 与权限装饰器对显式 agentDir/configDir 的解释目前不同，
  应共享产品路径上下文，避免读取测试环境或另一个目录中的真实用户配置。
- `stepPersistedDefaults` 目前是空对象占位；恢复从 TOML 读取早期模型选择和 telemetry。
- 真正实现 TOML 编辑与文件锁：`smol-toml` 已用于读写，`toml-eslint-parser` 已添加依赖，
  但尚未用于保留注释。`withLock` 当前没有实际锁；权限写回还需验证删除字段不被旧文档合并恢复。
- 设置存储共享同一份文档，锁内读改写、唯一临时文件和原子替换；保留注释、未知键和 MCP 表。
- 项目 MCP 不支持提示、生效配置失败策略、StepCode 权威回归补齐。
- TOML 依赖应归属实际使用的 coding-agent 包；目前装在根 package.json，需核对独立发布依赖闭包。

### B. MCP 生命周期与 TUI：主体已实现，配置细节未完成

保留两个入口，不直接合并：`mcp.ts` 管理会话连接/注册，`mcp-client.ts` 服务
`search_web` 的一次性 HTTP 调用。公共连接、分页和结果处理可复用；StepPage 结果提示留在产品层。

当前 TUI 时序：

```text
session_start → 创建 startup Promise → TUI 不 await，继续初始化及处理输入
                 ↓
              discovery → 并发连接各 server
                 ↓
              单个 server 就绪 → 逐工具注册 → connected
                 ↓                 ↑
              失败独立报告        await setImmediate() 让出事件循环

session_shutdown → abort pending → 等待任务收尾 → 关闭连接
```

- 本机 JS 主线程内的异步 I/O 调度，不是 Worker；并发连接不等于后台、不阻塞。
- `startup` 有错误收尾；TUI 不等待，print/RPC 仍等待初始工具目录。
- 每台服务器独立发布，不在全部连接结束后集中注册。
- 使用 `node:timers/promises` 的 `setImmediate` 在注册间让出执行权，不用微任务循环替代。
- `/mcp` 已接入快照，显示 connecting/connected/failed 与工具数，查看时不重启 MCP。
- 关闭时传递 AbortSignal 并清理 pending/已连接客户端，防止晚到结果进入新会话。
- 工具到达前发出的模型请求不包含那些工具；后续请求可用。

尚需完成：

- 通用发现仍是宽松字段转换；补严格 schema、transport 互斥和未知字段错误。
- enabled=false 当前提前跳过，disabled 不在 /mcp 快照中，且不能覆盖禁用同名插件；需修复。
- 通用 bridge 尚未分页 tools/list、应用工具 allow/deny 或 tool_timeout_sec；
  目标启动默认 30 秒、调用默认 300 秒，当前调用仍固定 30 秒。
- 新配置工具目标使用 `mcp__<server>__<tool>`，当前仍用旧名字拼接；补冲突/长度处理，保留插件既有名字。
- 新 stdio 配置仍继承完整环境，env_vars 未接通；需与已有插件环境行为明确分开。
- 显式 HTTP Authorization/bearer 应优先且不附加 OAuth provider；当前 provider 仅按存储是否有 token 决定。
- /mcp 快照目前是模块全局变量，不是真正多会话隔离；未实现截图中的分色自定义渲染。
- 同步 Git 查询仍在每次工具注册中发生；本次已用 yield 消除连续长阻塞。
  批量注册 API 或异步 Git 快照列为后续性能优化，不扩大到 agent-loop 重写。

### C. CLI 管理与 OAuth：基础接入，尚未闭环

已实现命令分支、stdio 拒绝提示、HTTP SDK OAuth discovery/auth、loopback listener、
内存 PKCE verifier、授权 URL 展示/浏览器打开、token/client information 保存和 logout。
HTTP 长连接找到保存的 access token 时会传入 SDK 的 `authProvider`，
无凭据启动时不主动打开浏览器。authProvider 是本地 SDK API，远端收到 Bearer header。

当前凭据使用 `<name>|<url>` 索引，文件 mode 0600，临时文件后 rename；没有锁、
严格 schema、issuer 或绝对过期时间。不能视为完整可靠的凭据管理。

必须补齐并验证：

- OAuth provider 明确采用 SDK `OAuthClientProvider` 契约；消除交互登录和运行时保存逻辑重复。
- 当前运行时 `redirectUrl: undefined` 会使 SDK auth 进入非交互取 token 分支，
  不保证执行 refresh_token 流程。需验证/修复“重启复用 → 401/临近过期刷新 → 保存”。
- 到期时间及提前 30 秒刷新、issuer 绑定、刷新串行化、跨进程文件锁、
  refresh token 轮换及无新 refresh token 时保留原值；网络故障不误删凭据。
- callback 路径、随机 state、issuer 校验；默认 300 秒超时、用户取消和端口错误清理。
- callback_port、scopes、oauth_resource 真正接入；重登录时 client/redirect 与旧 token 不能混用。
- 移除无证据的统一 root discovery 强制覆盖，支持 SDK 标准路径和服务端 metadata challenge。
  之前把 Figma 403 归因于 path-aware discovery 是误判，已定位到注册端点。
- 自定义 MCP 认证头不转发到其他授权域名；配置和异常中的 token/client secret 不进入日志。
- CLI list/get 当前 JSON 会直接输出原声明，尚未脱敏；add 的 --env 扫描会越过 `--`，
  也会在 HTTP 分支被误解释为 header。需修复解析并补命令级验收。
- Figma 当前特殊错误会覆盖底层 403 详情；应兼顾产品提示与具体失败阶段，不能宣称所有 HTTP 错误均完整保留。

## 3. Expectation — 验证证据与剩余验收

### 已有证据及其限制

| 验证 | 真实结果 | 不能据此声称 |
| --- | --- | --- |
| 设置回归 | 17/17，包括缺失文件、reload/trust、首次写入、损坏/读取错误 | 全部配置入口或 TOML 无损写入已完成 |
| MCP/TUI 回归 | 5 文件 37/37，包括 4 个新 startup 测试、原 MCP、Step 扩展、动态工具和启动输入 | OAuth 登录/刷新已通过 |
| 完整检查 | 最近代码阶段 `npm run check` 通过 | 全量测试/二进制构建通过 |
| 真实服务器发现 | Feishu 48、Chrome DevTools 29、Lark 15、node_repl 4 个工具 | 每个工具都可成功执行 |
| 真实工具调用 | 曾用空参数调用 get_chart_detail/get_console_message 并收到 content | 业务调用成功；当时未核验 isError 或有效参数 |
| 命令 smoke | 隔离配置下 list/get/add/remove、URL/bearer 写入和 stdio login 拒绝 | 所有参数边界、脱敏及 OAuth 成功分支通过 |
| Figma OAuth | discovery 可达，Step 动态注册 403；错误借用 Codex client 后生成链接，现已移除 | Step 身份登录成功、callback/state/refresh 验证完成 |
| 输入延迟 | 真实源码 CLI PTY，延迟 4 秒后返回 140 工具；最大回显等待期 6.6ms、发布期 162ms | 所有机器和大型仓库有相同延迟上界 |
| 同步提示词 profile | 本仓库 140 次重建约 3972ms | MCP 网络本身阻塞 JS 主线程 |

本机曾按用户授权将 `~/.codex/config.toml` 的六条 MCP 声明复制到 Step 全局配置，
其中 computer-use 禁用；不是七条。敏感值不写入此计划。前面有关“已脱敏输出”、
“已验证 OAuth 刷新”和“收到 content 就调用成功”的总结不能作为验收证据。

### 剩余实施顺序

1. **配置与命令收尾**：先统一路径/读写权威、原子锁与注释保留、严格配置/argv 校验、脱敏；
   补全局/项目/StepCode/独立包路径测试，旧 settings JSON 不参与启动或写回。
2. **OAuth 闭环**：使用本地受控授权服务验证动态注册/预注册、浏览器 callback、持久化、
   重启复用、401/到期刷新、轮换、多进程、注销、错误路径和隐私边界；不能只测失败 URL。
3. **MCP 与 /mcp 完整性**：工具分页/过滤/timeout/命名、disabled override、快照隔离、
   TUI 主题状态展示；继续保留后台启动和取消保护。
4. **真实验收**：用公开 stdio 与 HTTP MCP，在隔离配置中执行全部命令；
   选取 schema 允许的只读工具，检查 `isError` 及预期结果；不写业务数据。
   Figma 官方服务需 Step 合法 client，不能用别人的身份完成 smoke。
5. **交付**：运行修改测试与 `npm run check`，更新运行文档、执行记录及记忆；
   记录未测试范围。不要擅自 commit/push/build；遵守分支上的 changelog 规则。

## 4. Rollback — 回退与执行纪律

- 这是滚动执行计划，保留原日期文件名；本轮更新计划不代表实施所有待办。
- 开发保持产品层边界，不向 agent/tui 引入 MCP SDK，不复制 agent loop。
- 现有暂存和未暂存改动混合，回退只针对本任务改动；禁止全仓 reset/checkout/stash，
  不取消用户或其他会话的暂存。
- 不删除或重写真实用户的 settings/auth/models/credentials 文件；真实配置修复必须
  明确目标并保护已有内容。已经授权的测试与实现不反复请求确认。
- 配置、OAuth、MCP 生命周期分阶段审查；失败时回退该阶段改动而非整个工作区。
- 输入延迟专项计划保留为可复核的测试记录，主范围以本文为准：
  [MCP startup responsiveness](2026-09-10-mcp-startup-responsiveness.md)。
- 用户说明位于 [Step configuration](../../step-configuration.md)，不能只更新执行计划而漏掉运行文档。
