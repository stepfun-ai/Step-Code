#!/usr/bin/env bash
# TUI 冒烟矩阵:用 pty-drive.py 起 step TUI,逐用例发按键、抓屏断言。
# 稳健用例做硬断言;探索性用例(斜杠//@/Ctrl+P/config)只验「不崩 + UI 有响应」。
set -u
ROOT="${STEP_HARNESS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"; cd "$ROOT" || exit 2
export STEP_PROVIDER="${STEP_PROVIDER:-step}" STEP_MODEL="${STEP_MODEL:-step-3.7-flash}"
PY=(python3 scripts/smoke/pty-drive.py)
ENTRY=(node_modules/.bin/tsx --tsconfig tsconfig.json apps/cli/src/main.ts)
pass=0; fail=0
tc() { # tc <名称> <pty-drive 参数...> -- <step 命令...>
  local name="$1"; shift
  if "${PY[@]}" "$@" >/tmp/tui-$name.log 2>&1; then echo "PASS $name"; pass=$((pass+1))
  else echo "FAIL $name"; sed 's/^/    /' /tmp/tui-$name.log | head -4; fail=$((fail+1)); fi; }

# 1) 启动渲染
tc startup     --wait 7 --expect "Ask Step to do anything" --expect "step-3.7-flash" --expect "Step CLI" \
               --keys 'C-c|C-c' -- "${ENTRY[@]}"
# 2) 输入回显
tc input-echo  --wait 7 --expect "hello world" --reject "Error" \
               --keys 'hello world|SLEEP:0.4|C-c|C-c' -- "${ENTRY[@]}"
# 3) 斜杠命令面板(不崩 + 出现命令项)
tc slash       --wait 7 --reject "Cannot" --reject "TypeError" \
               --keys '/|SLEEP:0.5|C-c|C-c' -- "${ENTRY[@]}"
# 4) @ 文件补全(不崩)
tc at-file     --wait 7 --reject "Cannot" --reject "TypeError" \
               --keys '@|SLEEP:0.5|C-c|C-c' -- "${ENTRY[@]}"
# 5) Ctrl+P 模型切换(不崩)
tc ctrl-p      --wait 7 --reject "Cannot" --reject "TypeError" \
               --keys 'C-p|SLEEP:0.5|ESC|C-c|C-c' -- "${ENTRY[@]}"
# 6) 行内 shell !ls(不崩)
tc bang-shell  --wait 7 --reject "Cannot" --reject "TypeError" \
               --keys '!ls|SLEEP:0.5|C-c|C-c' -- "${ENTRY[@]}"
# 7) 窄窗口渲染(80x24)不崩
tc resize-80   --wait 7 --cols 80 --rows 24 --expect "Ask Step to do anything" --reject "Error" \
               --keys 'C-c|C-c' -- "${ENTRY[@]}"
# 8) config TUI(不崩 + 有 UI)
tc config-tui  --wait 8 --reject "Cannot" --reject "TypeError" \
               --keys 'SLEEP:0.5|C-c|C-c' -- "${ENTRY[@]}" config
# 9) /feedback 对话框:开→输入→ESC 关,不崩且关闭后编辑器输入区仍在(回归「/feedback 界面混乱/编辑器不在底行」)
tc feedback    --wait 7 --reject "Cannot" --reject "TypeError" --expect "Ask Step to do anything" \
               --keys '/feedback|ENTER|SLEEP:0.8|some feedback here|SLEEP:0.4|ESC|SLEEP:0.6|editorlives|SLEEP:0.4|C-c|C-c' -- "${ENTRY[@]}"
# 10) resize 往返(100x40→80x24→100x40):压重绘/缓存,不崩且编辑器仍在
tc resize-cycle --wait 7 --cols 100 --rows 40 --reject "Cannot" --reject "TypeError" --expect "Ask Step to do anything" \
               --keys 'RESIZE:80x24|SLEEP:0.6|RESIZE:100x40|SLEEP:0.6|C-c|C-c' -- "${ENTRY[@]}"
# 11) 一轮对话(打模型,长看门狗)
tc one-round   --wait 6 --budget 60 --expect "PONG" \
               --keys 'Reply with exactly the word PONG and nothing else.|ENTER|SLEEP:20' -- "${ENTRY[@]}"

echo "---- TUI matrix: PASS=$pass FAIL=$fail ----"
pkill -f apps/cli/src/main.ts 2>/dev/null
[ "$fail" -eq 0 ]
