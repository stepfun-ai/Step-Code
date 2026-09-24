# Step Code Readme

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

![test.jpg](https://static-openapi.stepfun.com/resource/test.jpg)

<h3><strong>迅捷执行，长程可靠，token 更省。</strong></h3>

---

Step Code 运行于终端，单轮任务即可完成代码阅读、修改与测试验证的完整闭环。它与 Step（StepFun）provider 深度协同，登录后从 Step 服务发现可用模型。MCP 工具、Agent Skills、插件与多代理编排开箱即用；长任务可通过 /goal 托管，由 Step Code 持续自主推进。

Step Code 内置 [StepPage](https://platform.stepfun.com/docs/zh/step-code/reference/steppage) 发布能力：本地页面构建完成后，只需一条命令即可发布为可访问的静态网站，让开发、调试与交付在同一个终端中完成。

![StepPage 发布能力演示](https://github.com/user-attachments/assets/66843695-3c77-4b26-bd2c-4cd2397a98bf)

## Why Step Code

- **token 效率**——与阶跃模型深度协同，同等任务消耗更少 token；长任务拆分为子代理并行执行，子代理持有独立上下文，冗余内容不进入主对话。

- **静态网站发布**——内置 steppage 插件，一条指令将本地目录发布为可分享的静态网址，并支持版本管理与回滚。

- **长任务托管**——`/goal` 将目标交由 Step Code 持续自主推进，`/cron` 按计划定时执行；状态行实时显示活跃任务计时。

- **Step provider 接入**——支持 Step Plan 订阅和 Step Platform API Key；登录后可在 `/model` 中切换 Step 返回的模型。

- **生态兼容**——MCP 服务器与 Agent Skills 开箱即用，Claude Code 插件多数直接兼容。

## 安装

按操作系统选择官方安装器。安装器会下载最新版本、校验 checksum，把 step 安装到 `~/.stepcode/bin` 并写入 PATH；重开终端即可使用。

**macOS / Linux / WSL**

```bash
curl -fsSL https://static-openapi.stepfun.com/stepcode/install.sh | bash
```

**Windows（PowerShell）**

```powershell
irm https://static-openapi.stepfun.com/stepcode/install.ps1 | iex
```

- Windows PowerShell 支持目前为 beta，Windows 上推荐在 WSL 中安装使用

- 安装器参数：`--version <vX.Y.Z|latest>` 装指定版本，`--install-dir <路径>` 自定义安装目录

- 重新打开终端后验证安装：

```bash
step --version
step --help
```

之后用 `step update` 升级到最新版本。

## 登录 Step provider

当前版本的默认产品入口只内置一个模型 provider：**Step（StepFun）**。下面四种入口只是同一 provider 的不同区域和计费方式，不是四个不同 provider。

| 入口                                                                                    | 鉴权方式                                                                                         | 计费                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Step Plan（国内，[platform.stepfun.com](https://platform.stepfun.com/step-plan)）       | 浏览器 OAuth，凭据自动刷新                                                                       | Mini / Plus / Pro / Max 订阅内含用量 |
| Step Plan Oversea（海外，[platform.stepfun.ai](https://platform.stepfun.ai/step-plan)） | 浏览器 OAuth，凭据自动刷新                                                                       | Mini / Plus / Pro / Max 订阅内含用量 |
| Step Platform（国内）                                                                   | 从 [platform.stepfun.com/interface-key](https://platform.stepfun.com/interface-key) 获取 API Key | 按请求计费                           |
| Step Platform Oversea（海外）                                                           | 从 [platform.stepfun.ai/interface-key](https://platform.stepfun.ai/interface-key) 获取 API Key   | 按请求计费                           |

在 TUI 中输入 `/login` 会打开 Step 登录流程；在 shell 中运行 `step login` 也可以启动登录。使用 API Key 时，设置 `STEP_API_KEY=<your_step_api_key>`，或在 `/login` 中输入；无交互运行也可以传入 `--api-key <your_step_api_key>`。

`/status` 查看当前会话和模型状态。使用 `step login status`（或 `step login status --json`）检查 Step 凭据及其有效性。凭据保存在 `~/.stepcode/auth.json`（权限 `0600`）；`/logout` 清除 Step 凭据。登录后，`/model` 会列出当前 Step endpoint 返回的可用模型。

## 上手

进入要处理的项目目录：

```bash
cd /path/to/your/project
step
```

在 TUI 中描述任务，也可以在启动时直接提交：

```bash
step -p "What is the tech stack of this project? What is each directory responsible for? How do I run it locally?"
```

用 `/init` 生成 `AGENTS.md` 项目指引；已有的 CLAUDE\.md 直接生效，无需重写。

| 入口       | 命令            | 适用场景                     |
| ---------- | --------------- | ---------------------------- |
| 交互式 TUI | `step`          | 探索代码、持续对话、审阅修改 |
| Headless   | `step -p "..."` | 脚本、CI、批处理             |

### 示例

在任意项目里启动 TUI，输入：

```text
What is the tech stack of this project? What is each directory responsible for? How do I run it locally? Don't modify any files yet.
```

再试一个包含修改的示例：

```text
Create a reference table for the error codes in src/api/errors.ts (code, meaning, trigger scenario) and save it to docs/errors.md
```

### 恢复会话

```bash
step -c   # Continue the most recent session
step -r   # Browse session history and pick one to resume
```

TUI 内输入 `/resume` 查找历史会话，`/hotkeys` 查看完整快捷键。

### 常用快捷键

| 快捷键                                 | 操作                                             |
| -------------------------------------- | ------------------------------------------------ |
| `Enter`                                | 发送消息                                         |
| `Shift+Enter` / `Ctrl+J` / `Alt+Enter` | 换行                                             |
| `Enter`                                | 流式输出期间排队插话（当前轮工具执行完自动送达） |
| `@`                                    | 引用项目文件                                     |
| `!命令`                                | 直接执行 Shell 命令并把输出交给模型              |
| `Shift+Tab`                            | 循环权限模式                                     |
| `Ctrl+O`                               | 折叠 / 展开工具输出                              |
| `Esc`                                  | 中断正在运行的任务                               |

## 从其他 Agent 迁移

- **MCP 配置**：首次启动检测到 Claude Code / Codex 的 MCP 配置时自动导入；源文件只读、可重复执行、密钥不落明文。

- **插件**：Claude Code 插件多数直接可用，`/plugin` 里统一管理。

- **项目指引**：已有的 CLAUDE\.md 直接生效，`/init` 可生成等价的 AGENTS\.md。

## 从源码构建

开发 Step Code 或运行本仓库源码需要 Git、Node\.js 与 pnpm：

```bash
git clone https://github.com/stepfun-ai/Step-Code.git
cd Step-Code
pnpm install --ignore-scripts
pnpm run build
pnpm step
```

从源码目录运行时，把示例中的 `step` 替换为 `pnpm step`。

## 安全

- 权限四档（Ask / Read Only / Bypass / Autopilot），`Shift+Tab` 循环切换；危险命令在任何模式下都会单独弹窗确认。

## 卸载

确认没有正在运行的 step 会话，再执行卸载。

**移除程序**：删除安装目录中的 step 可执行文件（默认 `~/.stepcode/bin`）。安装器写入 PATH 时会在 shell 配置里追加带 `# stepcode` 标记的 PATH 块，卸载时把该标记块整段删除即可（zsh 用 `~/.zshrc`，bash 用 `~/.bashrc` 等，fish 用 `fish_add_path` 对应配置）。

**可选：删除用户数据**：本地数据统一在 `~/.stepcode`（配置、凭据、会话、日志），确认不再需要后删除整个目录即可回到全新状态：

```bash
rm -rf ~/.stepcode
```

## 文档与社区

- 快速开始 · 交互与输入 · 平台与模型 · 全部文档（链接发布日对齐 docs 目录）

- 贡献指南 · \[报告 Bug / 提出建议\]\(issues 链接发布日填\) · 报告安全问题

- 提 Issue 请附上 `step --version`、复现步骤与运行入口；凭据和私人项目内容请先抹掉。

## 许可

本项目以 MIT 许可发布，详见 LICENSE。
