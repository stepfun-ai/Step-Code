# TUI 渲染管线

`packages/tui`（`@step-harness/pi-tui`）是零 AI 依赖的纯终端渲染库。本文梳理从终端字节进来到像素落地的完整管线：终端协商 → 输入拆分与分发 → 组件树渲染 → 差分写回。文档基于源码逐段核对，所有断言标注文件与行号。

## 总览

```
终端字节 ──► ProcessTerminal ──► StdinBuffer ──► TuiBase.handleTerminalInput
 (raw)       (Kitty 协商/粘贴)    (拆序列/粘帖)    (查询响应消费 → inputListeners
                                                    → 焦点组件 handleInput)
                                                          │
                                             requestImmediateRender()
                                                          ▼
                        ┌─────────────────── TuiBase 调度（16ms 节流）───────────────────┐
                        │  doRender()                                                  │
                        │   regular: Container.render → overlays → 行归一化 → 差分写盘   │
                        │   fullscreen: renderLayoutFrame → 搜索/选择/闪烁合成 → 行级差分 │
                        └──────────────────────────────────────────────────────────────┘
```

两种屏幕模式（`TuiMode`，`tui.ts:387`）：

- `regular`（`TuiMainScreen`，`tui-main-screen.ts:140`）：内容写进主屏与 scrollback，滚动由终端自己管。
- `fullscreen`（`TuiAltScreen`，`tui-alt-screen.ts:169`）：进入 alt screen（`\x1b[?1049h`），应用自持视口：滚动、鼠标选择、搜索、滚动条都由 TUI 管。

两者共用 `TuiBase`（`tui.ts:434`）：输入分发、渲染调度、overlay 栈、焦点管理、终端查询（OSC 11 背景色、颜色方案、cell 尺寸）。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| `terminal.ts` | `Terminal` 接口与 `ProcessTerminal`：raw mode、bracketed paste、Kitty 键盘协议协商、尺寸/光标/清屏/进度（OSC 9;4）原语 |
| `stdin-buffer.ts` | 把成批 stdin 数据拆成单条按键序列；识别 bracketed paste 并发出 `paste` 事件 |
| `keys.ts` | 按键序列解析与匹配（`matchesKey`、`isKeyRelease`、Kitty printable 解码） |
| `keybindings.ts` | 键位表（`TUI_KEYBINDINGS`）与 `KeybindingsManager`：用户覆盖、冲突检测、解析结果 |
| `tui.ts` | `Component` 契约、`Container`（带脏前缀缓存）、`TuiBase`（输入分发、渲染调度、overlay 栈、焦点）、`compositeTuiLine` |
| `tui-main-screen.ts` | `regular` 模式差分渲染器与 `BoundedTerminalWriter` |
| `tui-alt-screen.ts` | `fullscreen` 模式：alt screen 生命周期、鼠标/选择/搜索/滚动、Kitty 图像放置 |
| `layout.ts` / `layout-node.ts` | 全屏布局：`LayoutBox` 树（rect/clip）、scroll view 状态、stack 尺寸分配、滚动条绘制与合成 |
| `components/editor.ts` | 编辑器组件：`handleInput` 的键位分发、粘贴组装、撤销、自动补全 |
| `utils.ts` | 宽度计算（`visibleWidth`）、列切片、ANSI 归一化（`normalizeTerminalOutput`） |
| `terminal-image.ts` | 终端图像能力探测、Kitty/iTerm2 编码、图像行识别与裁剪 |

产品侧接线在 `apps/cli/src/ui/`：`interactive-mode.ts`（组合根）、`runtime/input-dispatch.ts`（键位动作注册与提交路由）、`runtime/session-events.ts`（会话事件 → 组件树）、`runtime/redraw.ts`（渲染门面）。

## 1. 终端协商与输出原语

`ProcessTerminal.start`（`terminal.ts:161`）按顺序做：

1. 保存并进入 raw mode，stdin 切 utf8 编码（`terminal.ts:166-171`）。
2. 开启 bracketed paste：`\x1b[?2004h`（`terminal.ts:174`），粘贴内容由终端包成 `\x1b[200~ … \x1b[201~`。
3. 挂 stdout `resize` 监听（`terminal.ts:177`）；非 Windows 上补发 `SIGWINCH` 刷新可能过期的尺寸（挂起/恢复期间信号会丢，`terminal.ts:181-183`）。
4. Windows 上给 stdin 句柄加 `ENABLE_VIRTUAL_TERMINAL_INPUT`，否则 Shift+Tab 会退化成 Tab（`terminal.ts:366-388`）。
5. 发起 Kitty 键盘协议探测：请求 flags `7`（1 消歧 + 2 事件类型 + 4 备用键名）并跟一条 DA 哨兵（`terminal.ts:15-17`）。响应 `\x1b[?<flags>u` 且非 0 → 启用 Kitty；先收到 DA → 回退 modifyOtherKeys `\x1b[>4;2m`（`terminal.ts:255-277`）。跨事件拆分的响应由 150ms 片段超时拼回（`terminal.ts:16`、`322-328`）。

退出时反向恢复：关进度、关 bracketed paste、`\x1b[<u` 关 Kitty、关 modifyOtherKeys、销毁 StdinBuffer、暂停 stdin（防退出后残留 Ctrl+D 打到父 shell）、恢复 raw（`terminal.ts:428-474`）。`drainInput` 在退出前排空残留按键，避免 Kitty release 事件泄漏到 SSH 父 shell（`terminal.ts:390-426`）。

`write()` 只是 `process.stdout.write`，可选把字节流追加到 `PI_TUI_WRITE_LOG` 指定文件便于回放（`terminal.ts:476-485`）。尺寸回落链是 `stdout.columns → env.COLUMNS → 80`（`terminal.ts:487-493`）。

## 2. 输入拆分与分发

### 2.1 StdinBuffer：批数据 → 单条序列

`StdinBuffer.process`（`stdin-buffer.ts:296`）维护一个字符串缓冲：

- 遇到 `\x1b[200~` 进入 paste 模式，直到 `\x1b[201~` 发出 `paste` 事件（`stdin-buffer.ts:324-377`）。
- 否则用 `extractCompleteSequences` 切出完整序列，剩余部分挂超时：裸 `ESC` 用 escape 超时，其余用序列超时（`stdin-buffer.ts:380-396`）。
- escape 超时默认 10ms，`SSH_CONNECTION`/`SSH_TTY` 下 100ms，可用 `PI_TUI_ESC_TIMEOUT` 覆盖（`terminal.ts:104-121`）——高延迟链路上 ESC 前缀的 Alt 组合需要更长的重组窗口。
- Kitty 协议下"重复上报的可打印字符"会被抑制：已消费的码点再次单独到达时丢弃（`stdin-buffer.ts:399-408`）。

`ProcessTerminal.setupStdinBuffer` 把序列流接成：协商响应优先消费 → 其余通过 `forwardInputSequence` 送到 `onInput`（即 `TuiBase.handleTerminalInput`）；`paste` 事件重新包上 bracketed paste 标记再送入，编辑器侧无需区分两条路径（`terminal.ts:204-232`）。

### 2.2 TuiBase.handleTerminalInput：固定的处理顺序

`tui.ts:929-1005`，顺序即优先级：

1. OSC 11 背景色响应 → 结算 `queryTerminalBackgroundColor` 的等待（`tui.ts:1007-1029`）。
2. 终端颜色方案报告（`\x1b[?997;1n` / `\x1b[?997;2n`，`terminal-colors.ts:29`）→ 广播给 `onTerminalColorSchemeChange` 监听者（`tui.ts:1031-1041`）。通知需显式开启：`\x1b[?2031h/l`（`tui.ts:810-812`、`835-843`）。
3. `inputListeners` 链：全屏模式的视口输入拦截（滚动、搜索、鼠标、滚动条）就注册在这里，可 `consume` 整条输入或改写后继续（`tui.ts:937-952`）。
4. cell 尺寸响应（`CSI 16 t` 查询 → `CSI 6;h;w t`）→ `setCellDimensions` + 全树 `invalidate` + `requestRender`（`tui.ts:1043-1061`）。
5. 全局调试键 `shift+ctrl+d` → `onDebug`（`tui.ts:960-963`）。
6. overlay 焦点有效性修正：聚焦的 overlay 因尺寸变化或 `visible()` 变为不可见时，改指最上层可见 overlay 或回退到进入前的焦点（`tui.ts:965-991`）。
7. 交给焦点组件 `handleInput(data)`；Kitty release 事件默认过滤，组件声明 `wantsKeyRelease` 才放行（`tui.ts:993-1000`）。
8. 输入处理后立刻 `requestImmediateRender()`——按键是延迟敏感路径，节流定时器在 Windows 上会吃掉整帧（`tui.ts:1001-1004`）。

### 2.3 键位解析：序列 → 动作

组件内部不做裸字节比较，全部走键位表：

- `matchesKey(data, keyId)`（`keys.ts`）把 CSI/SS3/Kitty 序列与 `"ctrl+x"`、`"shift+enter"` 这类 KeyId 匹配。
- `KeybindingsManager`（`keybindings.ts:236`）合并 `TUI_KEYBINDINGS` 默认表（`keybindings.ts:72-215`）与用户覆盖，重建出 `keysById` 并检测同一按键被多个动作声明的冲突（`keybindings.ts:248-273`）；`matches(data, id)` 查表匹配（`keybindings.ts:275-281`）。`getKeybindings()` 是进程级单例（`keybindings.ts:314-324`）。
- 编辑器 `Editor.handleInput`（`components/editor.ts:619`）：jump 模式（等待跳转目标字符）→ bracketed paste 组装（`\x1b[200~` 分片跨事件累积，`editor.ts:643-667`）→ `ctrl+c` 交回上层（`editor.ts:669-672`）→ 键位分发到撤销、自动补全、编辑动作。
- 应用级动作（`app.*`）由产品层定义：`packages/coding-agent/src/core/keybindings.ts` 声明动作，`apps/cli/src/ui/runtime/input-dispatch.ts` 的 `wireKeyHandlers` 用 `ctx.defaultEditor.onAction("app.xxx", …)` 注册处理器，例如 `app.redraw`（手动重绘，`input-dispatch.ts:200`）。键位可通过配置覆盖，`app.redraw` 与 `app.model.select` 的默认值在 `interactive-mode.ts:230-231` 兜底。

## 3. 渲染调度

`TuiBase` 只暴露三个入口，语义完全不同：

- `requestRender()`（`tui.ts:875`）：`process.nextTick` 里 `scheduleRender`，按 `MIN_RENDER_INTERVAL_MS = 16`（`tui.ts:446`）节流，合并同帧内的多次请求。流式输出、事件驱动的组件树变更都走这条。
- `requestImmediateRender()`（`tui.ts:886`）：输入路径专用，nextTick 里立即 `doRender()` 并取消已排队的节流帧——用户按键必须抢占待发的定时器帧。
- `renderNow(force)`（`tui.ts:867`）：同步刷新。`force=true` 先 `resetRenderState()` 丢弃上一帧缓存，即 `app.redraw`（Ctrl+L）的"差分渲染器复位 + 全量重绘"恢复路径。

`doRender()` 在 `start()`/`stop()` 生命周期钩子之间运行（`beforeTerminalStart`/`afterTerminalStart`/`beforeTerminalStop`/`afterTerminalStop`，`tui.ts:479-485`），全屏模式的 alt screen 进出就挂在这些钩子上。

## 4. 组件契约与脏前缀缓存

组件接口只有四个方法（`tui.ts:23-58`）：`render(width) → string[]`、可选 `renderDirtyStart`（上次输出中"可能变化"的起始行）、可选 `handleInput(data)`、`invalidate()`。

`Container.render`（`tui.ts:274-346`）是差分渲染的第一级优化，目标是"长 transcript 的稳定前缀不进入每帧工作"：

- 缓存 `{ lines, width, childRefs, childStarts }`；宽度相同且子组件数量不变时进入增量路径。
- 逐个调用子组件 `render`，谁返回的数组实例和上次不同，谁就是第一个脏子组件。
- 脏子组件自己声明的 `renderDirtyStart` 决定前缀复用深度；不声明则视为从第 0 行起全脏（`tui.ts:302`）。该索引会被夹到"子组件上一帧行数"之内，防止子组件变长后前缀伸进后续组件的缓存行（`tui.ts:295-302`）。
- 全部子组件返回同一实例 → 整帧复用，`renderDirtyStart = lines.length`（`tui.ts:306-309`）。

容器层之上没有脏标记：组件靠"返回同一个数组实例"表达"我没变"，靠 `invalidate()` 丢弃自己的缓存。产品侧大量使用后者（主题切换、语法高亮加载完成时全树 `invalidate`）。

## 5. 主屏差分渲染（regular）

`TuiMainScreen.doRender`（`tui-main-screen.ts:329-750`）每帧的完整顺序：

1. 读取 `terminal.columns/rows`，判定宽/高变化与 overlay 开合（`tui-main-screen.ts:331-340`）。overlay 状态变化意味着上一帧镜像的是合成后的画面，前缀不可跨过这次转换复用（`resetFrom = 0`）。
2. `Container.render(width)` 得到新行（`tui-main-screen.ts:353`）；`renderDirtyStart` 经 `PI_TUI_DISABLE_INCREMENTAL` 开关可强制为 0（`tui.ts:224-229`）。
3. 有 overlay 时先 `compositeOverlays`（`tui.ts:1202-1261`）：按 anchor/margin/百分比解析位置，把各 overlay 的行按列合成进基线，必要时补空行使 overlay 有屏幕相对坐标。
4. 定位光标标记 `CURSOR_MARKER`（`\x1b_pi:c\x07`，`tui.ts:90`）：焦点组件在光标处发出这个 APC 序列，渲染器找到后把它从行里剥掉，再用它定位硬件光标（IME 候选窗定位），`findCursorPosition`（`tui-main-screen.ts:250-260`）。
5. 行归一化 `applyLineResetsFrom`（`tui-main-screen.ts:224-247`）：从 `resetFrom` 起的行做 ANSI 归一化并追加 `SEGMENT_RESET`（`\x1b[0m\x1b]8;;\x07`，`tui.ts:353`），防止样式跨行泄漏；`resetFrom` 之前的行直接引用上一帧。首帧、宽高变化、overlay 切换都会把 `resetFrom` 压到 0。
6. 全量重绘判定（`fullRender(clear)`，`tui-main-screen.ts:386-428`）：首帧不擦屏直接写；宽度变化必擦（换行位置全变）；高度变化必擦（Termux 软键盘场景例外，否则每次键盘弹出都重放整段历史，`tui-main-screen.ts:456-460`）；内容收缩超过历史最高水位且无 overlay 时擦除空行（`clearOnShrink`，`tui.ts:513-515`、`tui-main-screen.ts:465-469`）。擦屏序列是 `\x1b[2J\x1b[H\x1b[3J`（含 scrollback）。
7. 差分区间扫描（`tui-main-screen.ts:473-498`）：从 `resetFrom` 扫到两帧最大行数，记 `firstChanged/lastChanged`；纯追加时区间锁在旧长度处（`appendStart` 快速路径）。区间经过 Kitty 图像块时向外扩展，避免从图像块中间重画（`tui-main-screen.ts:284-305`）。
8. 视口夹取（`tui-main-screen.ts:568-589`）：`firstChanged` 落在上一帧视口之上且文档长度没变——只有 scrollback 副本过期，屏幕上行没动——只重绘可见部分；任何长度变化都可能让行在视口下位移，仍走全量重绘。
9. 写入（`tui-main-screen.ts:593-680`）：`\x1b[?2026h` 开同步输出 → 视口滚动对齐（必要时 `\r\n` 推进滚动）→ CUU/CUD 移到首变行 → `\r` → 逐行 `\x1b[2K` + 行内容 → 尾部清理旧多出的行 → `\x1b[?2026l`。只写首变行到末变行，单行变化（spinner）不会闪烁全屏。
10. 硬保险（`tui-main-screen.ts:651-678`）：任何渲染行 `visibleWidth > width` 直接把全部行写进 `pi-crash.log`，清理终端状态后抛错——指向"组件没截断"这个根因。
11. 更新镜像：`previousLines`、`hardwareCursorRow`、`previousViewportTop`、`previousKittyImageIds`、宽高（`tui-main-screen.ts:737-749`），并按需移动硬件光标（`positionHardwareCursor`，`tui-main-screen.ts:757-788`）。

输出统一经过 `BoundedTerminalWriter`（`tui-main-screen.ts:24-80`）：按 1MiB 分块刷盘，超长串按代理对边界切开，避免整帧拼成一个超过 V8 字符串上限的大串。

`stop()` 的收尾（`tui-main-screen.ts:194-202`）：把光标推到内容末尾再换行，退出后主屏 scrollback 不残留半行。

## 6. 全屏渲染（fullscreen）

`TuiAltScreen` 的渲染分两层：先算布局，再行级差分。

### 6.1 布局：LayoutBox 树

`renderLayoutFrame(root, width, height, requestRender)`（`layout.ts:353-382`）产出一棵 `LayoutBox` 树：每个盒子带 `rect`（x/y/宽/高）、`clip`（与父裁剪区的交集）、可选 `lines`/`scrollView`/`scrollContentLines`（`layout.ts:17-28`）。`layoutComponent`（`layout.ts:100-241`）按节点类型展开：

- 叶子组件：按宽度渲染，行数即高度；超出的部分可带 `lineOffset`（光标行优先留在视口内，`layout.ts:113-118`）。
- scroll view：内容按 `scrollTop` 偏移布置，`updateLayout` 维护滚动状态并可能回调 `requestRender`（`layout.ts:130-162`）；`primary` 或首个 scroll view 成为主视口。
- VStack/HStack：按 `basis`/`grow`/`shrink`/`minSize`/`gap` 分配尺寸（`layout.ts:166-240`，`components/stack.ts` 的 `allocateStackSizes`），HStack 支持 stretch/center/end 对齐。

`paintBox`（`layout.ts:304-351`）把树画进 `height` 行 × `width` 列的屏幕缓冲：剥离 OSC133 区段标记、图像按可见行数裁剪、部分覆盖用 `compositeTuiLine`（`tui.ts:356-385`）按列合成、满宽未触行直接引用加速；滚动条几何由 `getScrollbarGeometry`（`layout.ts:266-291`）算出 thumb 位置后逐格上色。全屏布局根由产品层提供（`interactive-mode.ts:1109-1126`）：transcript 滚动视图（grow）+ 底部 dock（待发消息、状态行、控件、编辑器、footer 的 VStack）。

### 6.2 合成与差分

`doRender`（`tui-alt-screen.ts:1310-1377`）：

1. `renderLayoutFrame` 得到屏幕行（未设 `layoutRoot` 时回退到隐式的主滚动视图，`tui-alt-screen.ts:1314`）。
2. 依次合成：搜索高亮（`applySearchHighlights`）→ overlay（`compositeOverlays`）→ 文本选择（`applySelection`）→ 瞬时消息闪烁（`compositeFlashes`）。
3. 行归一化 + 超宽行按列截断（`tui-alt-screen.ts:1327-1330`）。
4. 差分：首帧、宽高变化、或变化行涉及图像时全量重写（`\x1b[2J`，`tui-alt-screen.ts:1332-1356`）；否则逐行比较，只写变化行 `\x1b[{row+1};1H\x1b[2K<line>`（`tui-alt-screen.ts:1359-1362`）。
5. 光标：找到标记就绝对定位并显示/隐藏，否则隐藏（`tui-alt-screen.ts:1364-1369`）。

整帧包在 `\x1b[?2026h/l` 同步输出里，终端一次性呈现，避免半帧撕裂。Kitty 图像通过 `uploadedKittyImages` 缓存去重，iTerm2 路径在进入前临时屏蔽图像能力再重渲染（`tui-alt-screen.ts:281-299`、`364` 起）。

### 6.3 视口输入拦截

构造函数里注册 `handleViewportInput` 到 `inputListeners`（`tui-alt-screen.ts:231`、`566-670`），处理顺序：焦点进出事件（`\x1b[I/O`，清选择）→ 滚轮 → SGR 鼠标（右键粘贴、滚动条拖拽与悬停、文本选择与双击/三击、自动滚动）→ 键位：搜索（`ctrl+shift+f` 等）与翻页（pageUp/Down、半页、单行、上/下 prompt、home/end）。overlay 聚焦时让位（`shouldDeferViewportInputToOverlay`，`tui-alt-screen.ts:562-564`）。

alt screen 进入时（`tui-alt-screen.ts:316-318`）：`\x1b[?1049h` + 关 autowrap + 开鼠标追踪（tmux/screen 降级为 button-motion，`tui-alt-screen.ts:308-315`）+ 清屏回 home。退出时（`afterTerminalStop`，`tui-alt-screen.ts:335-358`）：默认把整份文档重放回主屏继续用 scrollback；`preserveScreen` 只退 alt screen 不动内容。

## 7. 产品侧接线（apps/cli）

渲染库只提供机制；"什么事件、什么数据、变成什么组件"由产品层决定，边界遵守 AGENTS.md 的所有权规则（组件编排属 `coding-agent`/宿主，差分渲染原语属 `pi-tui`，产品层不重写渲染循环）。

### 7.1 组合根

`createInteractiveTui`（`interactive-mode.ts:429-450`）按 `tuiMode` 选 `TuiMainScreen` 或 `TuiAltScreen`，全屏模式注入主题化的搜索样式、浏览器打开、剪贴板复制等回调。`init()`（`interactive-mode.ts:1076-1155`）组装组件树并挂载：

- `documentContainer` = header +（条件）welcome + loadedResources + chat（`interactive-mode.ts:721-744`）。
- regular 模式把 7 个顶层容器（document、待发消息、状态行、上/下控件、编辑器、footer）直接挂到 TUI（`interactive-mode.ts:1127-1135`）。
- fullscreen 模式改用布局根：transcript 滚动视图（grow）+ dock（`interactive-mode.ts:1102-1126`）。
- 挂载后 `setFocus(editor)`，`ui.start()`，再 `applyFromSettings()` 上主题（`interactive-mode.ts:1138-1157`）。

焦点与 overlay：对话框统一 `ui.showOverlay(component, options)` + `ui.setFocus(component)`，关闭时回焦编辑器（`interactive-mode.ts:3113-3131`、`3350-3360`）。overlay 的焦点恢复（被 overlay 内部组件抢走再还回）由 `TuiBase` 的状态机保证（`tui.ts:525-588`）。

### 7.2 事件 → 组件树 → 重绘

`session-events.ts` 订阅 agent 会话事件（约 24 个 case），每个 case 做三件事：改组件树（新建/更新/移除视图组件）、改状态（footer、状态行、进度），最后 `ctx.redraw.requestRender()`（`session-events.ts:56` 起；`footer.invalidate()` 是每个事件的第一条动作，保证 footer 数据缓存最先失效）。流式输出时 `message_update` 高频触发 `updateContent` + `requestRender`，靠 16ms 节流与差分渲染吸收。

`runtime/redraw.ts` 是唯一的重绘门面：`requestRender`（节流）、`forceRender`（`requestRender(true)`，SIGCONT/外编返回/热重载框）、`renderNow`（同步刷新，启动时用），外加 spinner 动画时钟（回调同样走这个门面）。它不实现第二套脏区模型，也不复刻节流逻辑。

### 7.3 键位动作

`runtime/input-dispatch.ts` 的 `wireKeyHandlers` 在编辑器交换之前注册（交换会复制 onEscape/onCtrlD/onPasteImage/canDequeue 等回调，晚注册会漏，`input-dispatch.ts:17-20`）。应用级动作（提交路由、slash 命令门、bash `!`/`!!`、队列 steer/follow-up）都在这里；`app.redraw` 绑定 Ctrl+L 的 `ui.renderNow(true)` 是终端花屏后的用户侧恢复手段。

### 7.4 模式切换

`switchTuiMode`（`interactive-mode.ts:1018-1074`）：`stop({ preserveScreen: true })` 停旧渲染器 → 捕获主屏渲染镜像（`captureRenderState`/`restoreRenderState`，`tui-main-screen.ts:155-182`，差分前缀状态随 TUI 实例迁移）→ 新建目标 TUI 复用同一个 `terminal` → 重挂同一批组件 → 还原焦点/clearOnShrink/onDebug → `invalidate`（iTerm2 图像能力下让 start 钩子自己失效）→ 重启并 rebind 主题与扩展输入监听。有 overlay 时拒绝切换（`interactive-mode.ts:1021`）。

### 7.5 主题与外部状态

主题文件变化（`interactive-mode.ts:1248-1253`）：`ui.invalidate()` + `requestRender()`——`invalidate` 丢弃容器与组件的渲染缓存，主题色在下一帧的归一化行里生效。语法高亮全部加载完成后同样失效重绘（`interactive-mode.ts:1265-1269`）。git 分支变化只触发 `requestRender`（footer 数据提供者推送，`interactive-mode.ts:1256-1258`）。

## 8. 环境变量与调试开关

| 变量 | 作用 |
| --- | --- |
| `PI_TUI_DISABLE_INCREMENTAL=1` | 关掉增量渲染，每帧全量走，用于渲染等价测试（`tui.ts:224-229`） |
| `PI_HARDWARE_CURSOR=1` | 显示硬件光标（默认隐藏，`tui.ts:447`） |
| `PI_CLEAR_ON_SHRINK=0` | 内容收缩时不清空多余行，减少慢终端重绘（`tui.ts:448`、`513-515`） |
| `PI_TUI_ESC_TIMEOUT=<ms>` | 覆盖裸 ESC 判定超时（默认 10ms，SSH 100ms，`terminal.ts:104-121`） |
| `PI_TUI_WRITE_LOG=<dir\|file>` | 把渲染字节流落盘，回放诊断（`terminal.ts:138-151`） |
| `PI_DEBUG_REDRAW=1` | 全量重绘原因写入 `pi-debug.log`（`tui-main-screen.ts:430-437`） |
| `PI_TUI_DEBUG=1` | 每帧差分细节（区间、光标、前后帧）写入 `/tmp/tui`（`tui-main-screen.ts:703-730`） |
| `PI_CODING_AGENT_DIR` | 日志目录（缺省 `~/.pi/agent`，`tui.ts:469`） |

## 9. 测试与验证

- `packages/tui/test` 用 `node:test`：差分行为（`container-render-cache.test.ts`、`main-screen-offscreen-change.test.ts`）、overlay 定位（`overlay-*.test.ts`）、布局（`layout.test.ts`）、输入（`stdin-buffer.test.ts`、`keys.test.ts`、`keybindings.test.ts`、`input.test.ts`）、宽度回归（`bug-regression-isimageline-startswith-bug.test.ts`、`tab-width.test.ts` 等）。
- 渲染等价性：`PI_TUI_DISABLE_INCREMENTAL=1` 强制全量路径，与增量路径逐字节对比——增量复用一旦算错前缀就会在这里现形。
- 产品侧：`apps/cli/test` 的 TUI 快照测试（如 `tui-acceptance-snapshot.test.ts`）锁住视图渲染输出。

## 10. 归属与约束

- 差分渲染、输入分发、布局合成只存在于 `packages/tui`；`apps/cli` 不 fork、不重写。
- `packages/tui` 保持零 AI 依赖（`docs/step-harness-architecture-redesign.md` 的 `check-tui-no-ai` 检查）。
- 组件不得输出超过传入宽度的行——主屏渲染器会抛错并把现场写进 `pi-crash.log`；测量用 `visibleWidth()`，截断用 `truncateToWidth()`。
- 跨进程渲染契约（远端会话）在 `packages/protocol`；本文只覆盖本地进程内的 TUI 渲染。
