#!/usr/bin/env bash
# 直接命令(非 TTY)冒烟。默认走 Step provider,避开默认 anthropic 404。
# 打模型的命令套墙钟 cap 杀、断言抓到的输出(因 `step -p` 在 dev/tsx 下不自退)。
set -u
ROOT="${STEP_HARNESS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"; cd "$ROOT" || exit 2
export STEP_PROVIDER="${STEP_PROVIDER:-step}" STEP_MODEL="${STEP_MODEL:-step-3.7-flash}"
SD="$(mktemp -d)"; STEP=(node_modules/.bin/tsx --tsconfig tsconfig.json apps/cli/src/main.ts)
pass=0; fail=0
cap() { local secs="$1" out="$2"; shift 2                          # 墙钟上限杀(macOS 无 timeout)
  ( "$@" >"$out" 2>&1 ) & local p=$!
  ( sleep "$secs"; kill -9 "$p" 2>/dev/null; pkill -f apps/cli/src/main.ts 2>/dev/null ) & local w=$!
  wait "$p" 2>/dev/null; kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; }
runq() { local name="$1" want="$2"; shift 2; [ "$1" = "--" ] && shift   # 非模型:自退快
  local o; o="$("${STEP[@]}" "$@" 2>&1)"
  if grep -qF "$want" <<<"$o"; then echo "PASS $name"; pass=$((pass+1))
  else echo "FAIL $name (want: $want)"; tail -3 <<<"$o" | sed 's/^/    /'; fail=$((fail+1)); fi; }
runm() { local name="$1" want="$2" secs="$3"; shift 3; [ "$1" = "--" ] && shift  # 模型:cap+断言输出
  local f="$SD/$name.out"; cap "$secs" "$f" "${STEP[@]}" "$@" --session-dir "$SD" --no-session --non-interactive-approval deny
  if grep -qF "$want" "$f"; then echo "PASS $name"; pass=$((pass+1))
  else echo "FAIL $name (want: $want)"; tail -3 "$f" | sed 's/^/    /'; fail=$((fail+1)); fi; }
runq "version"    "0."               -- --version
runq "help-usage" "Usage:"           -- --help
runq "auth-check" '"status":"ready"' -- auth check --provider step --json
runm "print-text" "PONG"        60   -- --provider step --model "$STEP_MODEL" -p "Reply with exactly the word PONG and nothing else."
runm "print-json" '"agent_end"' 60   -- --provider step --model "$STEP_MODEL" -p "hi" --mode json
echo "---- direct smoke: PASS=$pass FAIL=$fail ----"; rm -rf "$SD"; pkill -f apps/cli/src/main.ts 2>/dev/null; [ "$fail" -eq 0 ]
