#!/usr/bin/env python3
"""Generate a real large session, run the real StepCode CLI against it, and report timings.

Usage (from anywhere):
  python3 real-run.py <target_tokens> [cli flags...]
Env:
  SCALE=1.06      scale recorded usage to match the gateway's real token count
  TAIL_CJK=220000 append a final tool result of N Chinese characters after the last usage
  UNIQUE=<hex>    make the content unique so the gateway cache is cold
Output: /tmp/real-compaction/session-*.jsonl and /tmp/real-compaction/last-report.json
Requires a built CLI (apps/cli/dist/main.js) and a configured provider; it sends real requests.
"""
import json
import os
import subprocess
import sys
import time
import uuid

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../.."))
OUT_DIR = "/tmp/real-compaction"
CLI = os.path.join(REPO, "apps/cli/dist/main.js")


def generate(path: str, target_tokens: int, scale: float = 1.0) -> dict:
    sid = str(uuid.uuid4())
    now = int(time.time() * 1000)
    entries = [
        {"type": "session", "version": 3, "id": sid, "timestamp": "2026-11-10T04:00:00.000Z", "cwd": REPO},
        {
            "type": "model_change",
            "id": uuid.uuid4().hex[:8],
            "parentId": None,
            "timestamp": "2026-11-10T04:00:00.100Z",
            "provider": "stepcode-anthropic",
            "modelId": "deepseek-v4.1-flash-api",
        },
    ]
    entries.append(
        {
            "type": "thinking_level_change",
            "id": uuid.uuid4().hex[:8],
            "parentId": entries[1]["id"],
            "timestamp": "2026-11-10T04:00:00.100Z",
            "thinkingLevel": "high",
        }
    )
    parent = entries[-1]["id"]
    tag = (os.environ.get("UNIQUE") or "")[:8]
    chunk = (f"[{tag}] " if tag else "") + "observed build output: src/parser.ts:42 exit code 1, assertion failed\n" * 200
    tokens = 0
    i = 0
    ts = now
    while tokens < target_tokens:
        ts += 1000
        u = {
            "type": "message",
            "id": uuid.uuid4().hex[:8],
            "parentId": parent,
            "timestamp": "2026-11-10T04:10:00.000Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": f"STEP {i}: inspect the failing parser build and report the exact errors"}],
                "timestamp": ts,
            },
        }
        entries.append(u)
        parent = u["id"]
        ts += 1000
        call_id = f"call_{i:04d}"
        a = {
            "type": "message",
            "id": uuid.uuid4().hex[:8],
            "parentId": parent,
            "timestamp": "2026-11-10T04:10:00.000Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "id": call_id, "name": "run_command", "arguments": {"command": "pnpm test"}}],
                "api": "anthropic-messages",
                "provider": "stepcode-anthropic",
                "model": "deepseek-v4.1-flash-api",
                "usage": {
                    "input": 2,
                    "output": 20,
                    "cacheRead": int(tokens * scale),
                    "cacheWrite": 0,
                    "totalTokens": int(tokens * scale) + 22,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
                },
                "stopReason": "toolUse",
                "timestamp": ts,
            },
        }
        entries.append(a)
        parent = a["id"]
        ts += 1000
        r = {
            "type": "message",
            "id": uuid.uuid4().hex[:8],
            "parentId": parent,
            "timestamp": "2026-11-10T04:10:00.000Z",
            "message": {
                "role": "toolResult",
                "toolCallId": call_id,
                "toolName": "run_command",
                "content": [{"type": "text", "text": chunk}],
                "isError": False,
                "timestamp": ts,
            },
        }
        entries.append(r)
        parent = r["id"]
        tokens += len(chunk) // 4 + 20
        i += 1
    tail_cjk = int(os.environ.get("TAIL_CJK", "0") or 0)
    if tail_cjk > 0:
        ts += 1000
        u = {"type": "message", "id": uuid.uuid4().hex[:8], "parentId": parent, "timestamp": "2026-11-10T04:10:00.000Z",
             "message": {"role": "user", "content": [{"type": "text", "text": "读取构建日志的中文说明"}], "timestamp": ts}}
        entries.append(u); parent = u["id"]
        ts += 1000
        a = {"type": "message", "id": uuid.uuid4().hex[:8], "parentId": parent, "timestamp": "2026-11-10T04:10:00.000Z",
             "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "call_cjk", "name": "run_command", "arguments": {"command": "cat 说明.md"}}],
                         "api": "anthropic-messages", "provider": "stepcode-anthropic", "model": "deepseek-v4.1-flash-api",
                         "usage": {"input": 2, "output": 20, "cacheRead": int(tokens * scale), "cacheWrite": 0, "totalTokens": int(tokens * scale) + 22,
                                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                         "stopReason": "toolUse", "timestamp": ts}}
        entries.append(a); parent = a["id"]
        ts += 1000
        sentence = "构建失败：解析器在第四十二行抛出断言错误，退出码为一，需要检查输入格式与边界条件。"
        text = (sentence * (tail_cjk // len(sentence) + 1))[:tail_cjk]
        r = {"type": "message", "id": uuid.uuid4().hex[:8], "parentId": parent, "timestamp": "2026-11-10T04:10:00.000Z",
             "message": {"role": "toolResult", "toolCallId": "call_cjk", "toolName": "run_command",
                         "content": [{"type": "text", "text": text}], "isError": False, "timestamp": ts}}
        entries.append(r); parent = r["id"]
    with open(path, "w") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"messages": len(entries), "approxTokens": tokens, "bytes": os.path.getsize(path)}


def summarize(path: str, since: float) -> dict:
    rows = [json.loads(line) for line in open(path) if line.strip()]
    out = {"autoClm": [], "provenance": [], "compaction": [], "errors": []}
    for entry in rows:
        if entry.get("type") == "custom" and entry.get("customType", "").startswith("step-auto-clm"):
            data = entry.get("data", {})
            if entry["customType"] == "step-auto-clm":
                out["autoClm"].append(
                    {
                        "at": entry["timestamp"],
                        "reason": data.get("reason"),
                        "accepted": data.get("accepted"),
                        "requests": data.get("requests"),
                        "transport": data.get("transport"),
                        "contextTokens": data.get("contextTokens"),
                        "before": (data.get("outcome") or {}).get("beforeTokens"),
                        "after": (data.get("outcome") or {}).get("afterTokens"),
                        "usage": {k: (data.get("usage") or {}).get(k) for k in ("input", "cacheRead", "output")},
                    }
                )
        if entry.get("type") == "custom" and entry.get("customType") == "step.usage_provenance":
            data = entry.get("data", {})
            out["provenance"].append(
                {
                    "at": entry["timestamp"],
                    "durationMs": data.get("durationMs"),
                    "ttftMs": data.get("ttftMs"),
                    "outcome": data.get("outcome"),
                    "status": data.get("statusCode"),
                }
            )
        if entry.get("type") == "compaction":
            data = entry.get("data", {})
            out["compaction"].append({"at": entry["timestamp"], "tokensBefore": data.get("tokensBefore")})
        if entry.get("type") == "message" and entry["message"].get("role") == "assistant":
            if entry["message"].get("stopReason") == "error":
                out["errors"].append(
                    {"at": entry["timestamp"], "error": str(entry["message"].get("errorMessage"))[:200]}
                )
    return out


def main() -> None:
    target = int(sys.argv[1])
    extra = sys.argv[2:]
    stamp = time.strftime("%H%M%S")
    os.makedirs(OUT_DIR, exist_ok=True)
    path = f"{OUT_DIR}/session-{target}-{stamp}.jsonl"
    import os as _os
    info = generate(path, target, float(_os.environ.get("SCALE", "1") or 1))
    started = time.time()
    started_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(started))
    proc = subprocess.run(
        ["node", CLI, "--session", path, "-p", "Reply with exactly: OK", *extra],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=1500,
    )
    elapsed = time.time() - started
    report = {
        "target": target,
        "flags": extra,
        "generated": info,
        "elapsedSeconds": round(elapsed, 1),
        "startedIso": started_iso,
        "stdout": proc.stdout.strip()[-300:],
        "stderr": proc.stderr.strip()[-500:],
        "exit": proc.returncode,
        "session": path,
        "details": summarize(path, started),
    }
    print(json.dumps(report, ensure_ascii=False, indent=1))
    with open(f"{OUT_DIR}/last-report.json", "w") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)


main()
