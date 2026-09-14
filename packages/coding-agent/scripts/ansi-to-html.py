#!/usr/bin/env python3
"""ANSI（truecolor/256/粗体/斜体/下划线）→ 独立 HTML，供浏览器截图做验收对比图。

用法：ansi-to-html.py <输入.ansi> <输出.html> [标题]
"""
import html
import re
import sys

RESET = "\x1b[0m"
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def color_span_stack():
    return {"fg": None, "bg": None, "bold": False, "italic": False, "underline": False}


def style_attr(state):
    parts = []
    if state["fg"]:
        parts.append(f"color:{state['fg']}")
    if state["bg"]:
        parts.append(f"background:{state['bg']}")
    if state["bold"]:
        parts.append("font-weight:700")
    if state["italic"]:
        parts.append("font-style:italic")
    if state["underline"]:
        parts.append("text-decoration:underline")
    return ";".join(parts)


def cube(level):
    return [0, 95, 135, 175, 215, 255][level]


def ansi256_to_rgb(n):
    if n < 16:
        table = [
            "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
            "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
        ]
        return table[n]
    if n < 232:
        n -= 16
        r, rest = divmod(n, 36)
        g, b = divmod(rest, 6)
        return f"rgb({cube(r)},{cube(g)},{cube(b)})"
    gray = 8 + (n - 232) * 10
    return f"rgb({gray},{gray},{gray})"


def apply_sgr(state, params):
    i = 0
    while i < len(params):
        p = params[i]
        if p == 0:
            state.update(fg=None, bg=None, bold=False, italic=False, underline=False)
        elif p == 1:
            state["bold"] = True
        elif p == 3:
            state["italic"] = True
        elif p == 4:
            state["underline"] = True
        elif p in (22,):
            state["bold"] = False
        elif p in (23,):
            state["italic"] = False
        elif p in (24,):
            state["underline"] = False
        elif p in (39,):
            state["fg"] = None
        elif p in (49,):
            state["bg"] = None
        elif p in (38, 48) and i + 1 < len(params):
            mode = params[i + 1]
            key = "fg" if p == 38 else "bg"
            if mode == 2 and i + 4 < len(params):
                r, g, b = params[i + 2 : i + 5]
                state[key] = f"rgb({r},{g},{b})"
                i += 4
            elif mode == 5 and i + 2 < len(params):
                state[key] = ansi256_to_rgb(params[i + 2])
                i += 2
        i += 1


def convert(text, title="TUI"):
    out = []
    state = color_span_stack()
    open_span = False

    def close():
        nonlocal open_span
        if open_span:
            out.append("</span>")
            open_span = False

    def open_():
        nonlocal open_span
        attr = style_attr(state)
        out.append(f'<span style="{attr}">' if attr else "<span>")
        open_span = True

    # 逐 token 处理，SGR 状态跨行保持（终端行为）
    tokens = re.split(r"(\x1b\[[0-9;]*m)", text)
    for tok in tokens:
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", tok)
        if m:
            params = [int(x) if x else 0 for x in (m.group(1).split(";") if m.group(1) else ["0"])]
            close()
            apply_sgr(state, params)
        else:
            if not open_span:
                open_()
            out.append(html.escape(tok).replace(" ", "&nbsp;"))
    close()
    body = "".join(out).replace("\n", "<br>\n")
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>
body {{ background:#15161a; margin:0; padding:14px 18px; }}
.pre {{ font-family:'Menlo','SF Mono',monospace; font-size:13px; line-height:1.45;
       color:#e8e8ea; display:inline-block; white-space:pre; }}
</style></head><body><div class="pre">{body}</div></body></html>"""


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    raw = open(sys.argv[1], encoding="utf-8").read()
    title = sys.argv[3] if len(sys.argv) > 3 else sys.argv[1]
    open(sys.argv[2], "w", encoding="utf-8").write(convert(raw, title))
    print(f"{sys.argv[2]} written")
