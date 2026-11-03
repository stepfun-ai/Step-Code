# scripts/smoke —— step 冒烟测试

「每完成一段就跑」的冒烟脚本,分直接命令(非 TTY)与进 TUI(伪终端)两类。
基线:`step-harness@1cfed08`,已本机实测(direct 5/5、TUI 9/9 PASS)。

## 前置

```bash
npm install                 # node_modules/dist 随 HEAD 漂移;跑前先装(实测缺 @modelcontextprotocol/sdk 等)
export STEP_PROVIDER=step STEP_MODEL=step-3.7-flash   # 固定走 Step,避开默认 anthropic 404
```

认证:已 `step login`(OAuth,凭据在 `~/.stepcode/agent/auth.json`)即可;或走 key 链路 `export STEP_API_KEY=<key>`。
`step auth check --provider step --json` 因内置静态凭据恒报 `authType:"oauth"`,但真实打模型仍需 OAuth 或 `STEP_API_KEY`。

## 脚本

| 脚本 | 作用 |
| --- | --- |
| `pty-drive.py` | 通用 PTY 驱动器:起 TUI、发按键、去 ANSI 抓屏断言、`killpg` 杀整个进程组退出。`--wait/--cols/--rows/--keys/--expect/--reject/--budget` |
| `smoke-direct.sh` | 直接命令冒烟:`--version`/`--help`/`auth check`/`-p`(text/json)。模型类命令套墙钟 `cap` 杀 + 断言输出(因 `step -p` 在 dev/tsx 下不自退) |
| `tui-matrix.sh` | TUI 冒烟矩阵:启动渲染/输入回显/斜杠//@/Ctrl+P/`!`shell/窄窗口/config/一轮对话 |

## 跑

```bash
bash scripts/smoke/smoke-direct.sh
bash scripts/smoke/tui-matrix.sh
# 单个 TUI 用例:
python3 scripts/smoke/pty-drive.py --wait 7 \
  --expect "Ask Step to do anything" --expect "step-3.7-flash" --reject "Error" \
  --keys 'hello|SLEEP:0.4|C-c|C-c' \
  -- node_modules/.bin/tsx --tsconfig tsconfig.json apps/cli/src/main.ts
```

## 踩过的坑(已写进脚本)

- PTY 入口用 `node_modules/.bin/tsx …`,**不要** `node --import tsx`(会立刻 EIO 退出)。
- 退出**必须 `killpg` 杀整个进程组**(step 会 fork 子进程,naive kill 会挂 >60s)。
- 抓屏**写文件再读**(管道 + kill 会丢缓冲输出)。
- `step -p` 在 dev/tsx 下打印后**不自退** → 模型命令套墙钟 `cap`、断言输出而非退出码。
- 默认 provider(anthropic/claude-opus-5)当前 **404**(代理不稳)→ 固定 `--provider step`。

每步(0–7)跑哪些见《step-harness-重构-实施精要.md》§验收冒烟测试、《step-harness-技术方案-详细设计.md》第 11 章。
