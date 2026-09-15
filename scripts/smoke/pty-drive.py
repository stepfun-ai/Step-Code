#!/usr/bin/env python3
# PTY 驱动器:在伪终端里起 step TUI,发按键,抓屏断言,killpg 杀整个进程组退出。
# 用法:
#   pty-drive.py --wait 6 --cols 120 --rows 40 \
#     --expect "Ask Step to do anything" --expect "step-3.7-flash" --reject "Error" \
#     --keys 'hello|SLEEP:0.4|ESC|SLEEP:0.3|C-c|C-c' \
#     -- node_modules/.bin/tsx --tsconfig tsconfig.json apps/cli/src/main.ts
# 按键 token: 普通串=原样输入; ENTER=\r; ESC=\x1b; TAB=\t; C-c=\x03; C-p=\x10; C-d=\x04; BS=\x7f; SLEEP:x=停 x 秒; RESIZE:CxR=改窗口尺寸并发 SIGWINCH
import os, pty, select, time, signal, re, sys, argparse, fcntl, termios, struct

ap = argparse.ArgumentParser()
ap.add_argument("--wait", type=float, default=6.0)        # 首屏渲染等待
ap.add_argument("--cols", type=int, default=120)
ap.add_argument("--rows", type=int, default=40)
ap.add_argument("--keys", default="")
ap.add_argument("--expect", action="append", default=[])  # 去 ANSI 后必须出现的子串
ap.add_argument("--reject", action="append", default=[])  # 不允许出现的子串
ap.add_argument("--capture", default="/tmp/step-pty-capture.txt")
ap.add_argument("--budget", type=float, default=0.0)       # 硬看门狗上限秒;0=自动 wait+12
ap.add_argument("cmd", nargs=argparse.REMAINDER)
a = ap.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
budget = a.budget or (a.wait + 12)

pid, fd = pty.fork()
if pid == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.environ.setdefault("STEP_PROVIDER", "step")
    os.environ.setdefault("STEP_MODEL", "step-3.7-flash")
    os.execvpe(cmd[0], cmd, os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))  # 固定窗口尺寸

buf = b""; start = time.time()
def drain(t):
    global buf
    try:
        r, _, _ = select.select([fd], [], [], t)
        if fd in r:
            d = os.read(fd, 65536); buf += d; return len(d)
    except OSError:
        return -1
    return 0

TOK = {"ENTER": b"\r", "ESC": b"\x1b", "TAB": b"\t", "C-c": b"\x03",
       "C-p": b"\x10", "C-d": b"\x04", "BS": b"\x7f"}
def send(tok):
    if tok.startswith("SLEEP:"):
        time.sleep(float(tok.split(":", 1)[1])); drain(0.1); return
    if tok.startswith("RESIZE:"):                          # 改窗口尺寸压重绘/缓存
        cols, rows = (int(x) for x in tok.split(":", 1)[1].lower().split("x"))
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try: os.killpg(os.getpgid(pid), signal.SIGWINCH)   # 内核也会自动发,这里显式补一发
        except Exception: pass
        drain(0.2); return
    os.write(fd, TOK.get(tok, tok.encode()))

try:
    while time.time() - start < a.wait:                    # 首屏
        if drain(0.4) == -1: break
    for tok in filter(None, a.keys.split("|")):            # 发按键
        if time.time() - start > budget: break
        send(tok); drain(0.3)
    end = time.time() + 1.5                                 # 收尾
    while time.time() < end and time.time() - start < budget:
        if drain(0.3) == -1: break
finally:
    try: os.killpg(os.getpgid(pid), signal.SIGKILL)        # 杀整个进程组(关键)
    except Exception:
        try: os.kill(pid, signal.SIGKILL)
        except Exception: pass
    try: os.waitpid(pid, os.WNOHANG)
    except Exception: pass

txt = re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', buf)      # 去 CSI
txt = re.sub(rb'\x1b[\]P][^\x07]*\x07', b'', txt)           # 去 OSC/DCS
s = txt.decode("utf-8", "replace")
open(a.capture, "w").write(s)
ok = True; msg = []
for e in a.expect:
    if e not in s: ok = False; msg.append("MISSING: " + e)
for rj in a.reject:
    if rj in s: ok = False; msg.append("FORBIDDEN: " + rj)
print(("PASS" if ok else "FAIL") + f"  bytes={len(buf)}  capture={a.capture}")
for m in msg: print("  " + m)
sys.exit(0 if ok else 1)
