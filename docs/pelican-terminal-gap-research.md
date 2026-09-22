# 终端像素 Logo：保持 20×9 去横缝

调研日期：2026-09-16。范围：公开官方规范、文档与源码，通过 `curl` 获取；本次未做本地渲染实验、未修改应用。固定 **20 列×9 行，20×18 源像素**，不要求用户更改终端设置。

## 结论

**优先 B：仅将上下同色、非透明格的 `fg(color) + █` 改成 `bg(color) + 空格`。** 双色格保留 `fg(上色) + bg(下色) + ▀`，透明半格保留原编码。无需放大，也无需增加行列。

理由：同色格没有半格分界，使用背景色即可表达整格颜色，绕开 `█` 字形是否覆盖整格的问题。SGR 定义颜色，不规定字形必须覆盖到相邻行边缘；终端确实存在自行绘制 block glyph、绕过字体的不同实现。[1–6]

主 agent 提供的 Apple Terminal 同窗口实验也支持 B：身体中间黑横缝显著消除；C/D 引入轮廓、轮子细线，拒绝。**这是指定环境的实验结果，不是所有终端绝对无缝的保证。** 本次未独立查看截图，也不能据此把 Apple Terminal 的内部成因确定为某一种字体度量或抗锯齿缺陷。

## 1. SGR 的保证与边界

xterm 官方控制序列表定义：[1]

- `SGR 30–37 / 40–47`：前景色 / 背景色；`39 / 49`：恢复默认前景 / 默认背景。
- `38;2;r;g;b / 48;2;r;g;b`：RGB 前景 / 背景扩展；不要把它们说成 ECMA-48 第五版已经定义的 RGB 参数格式。[1][2]
- `7`：inverse；`27`：取消 inverse。Microsoft 官方文档明确描述为交换前景、背景颜色。[3]
- 这些是字符呈现属性，**不是调整字形几何、行距或半格裁剪的命令**。

设上色为 U、下色为 L；在上下半格恰好互补覆盖整格、没有额外样式影响的理想条件下：

| 编码 | 理想颜色布局 | 实际保证 / 局限 |
| --- | --- | --- |
| `fg=U, bg=L, ▀` | 上 U、下 L | 原双色编码；半格的实际覆盖由渲染器决定 |
| `fg=L, bg=U, ▄` | 上 U、下 L | 交换颜色并换字形；不能保证上下半格在字体中精确互补 |
| `fg=U, bg=L, SGR7, ▄` | 上 U、下 L | reverse 只交换颜色；仍依赖 `▄` 的覆盖范围 |
| `bg=U, 空格`，U=L | 整格 U | 不再依赖 `█` 字形；不会解决其他异色格、透明半格的字形问题 |

**不要同时“交换 fg/bg”和“加 SGR7”而不重新核对结果**：两次颜色交换会相互抵消。反色还要注意默认前景与默认背景不是同一个颜色；终端默认背景也不能直接等同于一个固定 RGB 值。

推论：若 `▀` 和 `▄` 的实际覆盖区域不是严格互补，把颜色和半格反过来可能只是把漏色位置移到另一边，而不是消除漏色。因此 C/D 没有比 B 更强的规范保证。上述是从颜色交换语义得出的分析，不是 Apple Terminal 源码结论。

B 的边界：它能消除**这类格子对 full-block 字形覆盖的依赖**，不能从 SGR 规范推出“所有终端背景在所有行距、合成条件下都绝对无缝”。实现时需确保 inverse、下划线等样式不会污染空格，并恢复相邻内容所需的样式；全透明格仍走透明分支。

## 2. 为什么不同终端表现不同

| 终端 / 版本范围 | 一手证据 | 对当前方案的意义 |
| --- | --- | --- |
| xterm.js **5.5.0** | `customGlyphs` 默认 true，用自绘 block/box glyph 代替字体；注释称即使存在 line height / letter spacing 也通常能得到连续线条；明确 **DOM renderer 不适用**。[4] `CustomGlyphs.ts` 把 `▀` 定义为 8×8 网格的上 4 行、`▄` 为下 4 行、`█` 为全部，再按 `deviceCellWidth/Height` 调用 `fillRect`。[5] | 自绘路径有明确的整格几何依据，但不能外推到 DOM renderer、所有版本或所有基于 xterm.js 的宿主。`customGlyphs` 是宿主 JS API 选项，不是 CLI 可通用发送的 SGR 命令。 |
| WezTerm | 官方 `custom_block_glyphs` 默认 true，覆盖 U2580 Block Elements，使用自行计算的字形而非字体字形；文档明确提到绕过 FreeType hinting 问题。[6] | 默认实现已经针对这类问题处理；不需要建议用户改设置，也不能据此推断 Apple Terminal 行为。 |
| Kitty | 官方源码 `kitty/fonts.c`：`allow_use_of_box_fonts = true`；`font_for_cell` 将 `0x2574…0x259f` 等范围导向 `BOX_FONT`；`render_box_cell` 调用 `render_box_char`。普通空格另有 `BLANK_FONT` 路径。[7] | `▀▄█` 位于内建 block 绘制范围，不只是依赖用户字体；仍不是跨终端的协议保证。 |

本次没有取得能解释 Apple Terminal 此处绘制细节的一手实现证据，因此不声称其具体字体回退、字形边界或行距算法已被证实。也不把其他终端的设置项列作用户操作步骤。

## 3. 半行定位、半行背景与 DECDLD

### 不能简单说“标准完全没有部分行移动”

ECMA-48 第五版 §8.3.92 / §8.3.93 确实有 **PLD / PLU**，7-bit 形式分别是 `ESC K` / `ESC L`。它们用于上下标：把呈现位置移到部分偏移的假想行，偏移只要求足以显示下标 / 上标，**没有规定等于半个字符格高度**；与彼此之外的格式控制交互也未定义。[2]

因此它们不是可移植的“光标移动 0.5 行”方案。常用 CUP / HVP 是行列位置；ECMA-48 §8.3.21 和 xterm 的 CUP 定义均不是小数像素坐标接口。[1][2] 本次查到的 xterm 控制序列与 xterm.js 支持表也未提供可依赖的 PLD / PLU 半格绘图路径；这里只说明文档证据边界，不用“未列出”证明所有实现均不支持。[1][8]

### 背景属性不提供“只填半格”的参数

ECMA-48 §8.3.117 与 xterm SGR 中，背景颜色没有上半格 / 下半格选择或裁剪参数。[1][2] `bg + 空格` 能表达同色整格，却不能在一个格里单靠两次设置背景保留上下两种颜色。双色格仍需半格字形或另一套图形能力。xterm 的 `ESC # 3 / ESC # 4` 是双高字符行的上下部分，不是半行定位，也不适合作为保持当前网格的替代方案。[1]

### DECDLD 是真实能力，但不是通用修复

DECDLD 下载动态可重定义字符集（DRCS）。Microsoft Terminal 官方 `AdaptDispatch::DownloadDRCS` 实现接收 sixel 格式的字形像素，处理 cell matrix / cell height / full-cell font 等属性，注册字符集并更新 soft font；该实现只支持一个字体缓冲区，参数不合法会忽略下载。[9]

这不是 SGR 半格填色，而是**替换字符集字形的另一套协议和状态管理**。不能因一个实现支持，就要求 Apple Terminal 或其他终端也支持：xterm 官方 FAQ 仍将 soft/downloadable fonts 列在 ongoing/future work 中。[10] 本次未获得 Apple Terminal 支持 DECDLD 的官方证据。为统一 20×9 logo 引入下载字体、能力判断与恢复流程，没有建立跨终端可用性的依据，不推荐。

## 4. 本地实验记录（主 agent 提供，证据待补）

本节与前述公开资料调研分开；不是调研者自行执行或验证。

| 版本 | 改动 | 主 agent 报告 |
| --- | --- | --- |
| A | 原版，同色使用 `fg + █` | 身体有黑横缝 |
| **B** | 仅 `upper == lower` 的有色格改为 `bg(color) + 空格` | **身体中间黑横缝显著消除，优先采用** |
| C | 透明半格改为 SGR7 + 反向 `▀/▄` | 轮廓、轮子出现额外细线，拒绝 |
| D | C，且双色半格改用 `▄` | 同样出现额外细线，拒绝 |

环境：Apple Terminal，同一窗口四版本对照；维持 20×9，终端设置不变。主 agent 提供的截图位置：`/tmp/pelican-gap-comparison.png`；待补持久证据链接及终端版本。当前结论是**最小改动改善已观察问题**，不是跨终端像素完全一致。

## 一手来源

以下 URL 均为官方站点或项目官方仓库。固定版本处已标注；`main/master` 为调研日读取的可变分支。

1. xterm Control Sequences，SGR、CUP、HVP、DECDHL：<https://invisible-island.net/xterm/ctlseqs/ctlseqs.html>；纯文本：<https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt>。
2. ECMA-48，第五版（1991-06），§8.3.21（印刷页 36）、§8.3.92–93（52–53）、§8.3.117（61–62）：<https://ecma-international.org/wp-content/uploads/ECMA-48_5th_edition_june_1991.pdf>。
3. Microsoft Console Virtual Terminal Sequences，Text Formatting，SGR 7/27：<https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences#text-formatting>。
4. xterm.js 5.5.0，`ITerminalOptions.customGlyphs`（行 78–85）：<https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/typings/xterm.d.ts>。
5. xterm.js 5.5.0，`blockElementDefinitions`、`drawBlockElementChar`：<https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/src/browser/renderer/shared/CustomGlyphs.ts>。
6. WezTerm 官方文档：<https://wezterm.org/config/lua/config/custom_block_glyphs.html>；源码：<https://raw.githubusercontent.com/wezterm/wezterm/main/docs/config/lua/config/custom_block_glyphs.md>。
7. Kitty 官方源码，`font_for_cell`、`render_box_cell`：<https://raw.githubusercontent.com/kovidgoyal/kitty/master/kitty/fonts.c>。
8. xterm.js 官方 VT Features 支持表：<https://xtermjs.org/docs/api/vtfeatures/>。
9. Microsoft Terminal 官方源码，`AdaptDispatch::DownloadDRCS`：<https://raw.githubusercontent.com/microsoft/terminal/main/src/terminal/adapter/adaptDispatch.cpp>。
10. xterm 官方 FAQ，Ongoing/future work：<https://invisible-island.net/xterm/xterm.faq.html#future_work>。

## 5. 后续本地验证与落地（同日，主 agent 补记）

上文 B 是第一轮结论；用户要求继续消除细缝后，第二轮选择 **F：B + 半格同色补边**。
在 Apple Terminal 同窗口比较 B、E（相邻颜色选择方向）、F（上下划线）、G（粗体）：

- E 仍出现额外轮廓细线，G 无明显改善。
- F 下半格用 SGR4/24 下划线，上半格用 SGR53/55 上划线；其余格保持 B。
- 实测头顶、额头和嘴上的暗缝消失；文字属性均局部关闭，不扩大 20×9 布局、不改源图。
- 这只是指定环境实测。线条位置/支持依赖终端；不支持上划线时可能忽略，不能保证全终端物理像素一致。
- 原图编码 3240 个像素（8 帧+静态）无损验证；ANSI 解码测试验证补边仅出现在相应的半格，且属性不外泄。

持久截图：
- [第一轮 A/B/C/D](../pixel-art/pelican-terminal-gap-research/comparison.png)
- [第二轮 B/E/F/G](../pixel-art/pelican-terminal-gap-research/refinements.png)
- [B/F 裁剪对照](../pixel-art/pelican-terminal-gap-research/edge-rules-comparison.png)
- [实际欢迎组件](../pixel-art/pelican-terminal-gap-research/welcome-refined.png)

SGR4/24、53/55 属性定义亦见来源 [1]；其规范含义是 underline / overline，不是可移植的“像素补缝”接口。
