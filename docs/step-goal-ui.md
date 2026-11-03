# Goal 与输入框展示

- `/goal status` 将活动用时显示为 `45s`、`58m 25s`、`1h 02m`；暂停期间计时保持原有冻结语义。
- footer 只在暂停时显示 `Goal: paused`，active、完成、清空及其他停止状态不占该栏；状态详情通过流内消息和 `/goal status` 查看。
- 暂停提示和暂停后普通输入的 warning 指向 `/goal resume`；普通输入不会隐式恢复目标，同一暂停阶段只提醒一次。
- 未完成目标拒绝被覆盖时，按状态提示 status/resume/edit/clear；预算耗尽不提示无法使用的 resume。
- 工作行 tip 每轮一条，无计时轮播：active 80% 为 status/pause/edit/clear 引导，paused 优先 resume，无目标时加入长程任务发现入口。
- tip 的目标状态从当前会话分支中最新有效 `step-goal` 快照投影，遵循清空记录并忽略无效或其他会话数据。界面不持有第二套 Goal runtime。
- Step footer 右侧显示 `xx% context left`，保留告警色；未知上下文时隐藏读数，不再扫描历史累计 token。
- 没人主动要的 warning（启动诊断、MCP 导入、后台失败、回合进行中的提醒）不进 transcript，只在 footer 最右侧累计为 `⚠ N`；宽度 ≥100 列时附上打开键（默认 `alt+i`；macOS 的 Option+字母常被终端当作死键，因此 macOS 上只有非 `alt+字母` 的绑定才会显示，否则与未绑定时一样显示 `/warnings`），窄屏时先让出 context 读数、保留徽标。`alt+i` 或 `/warnings` 打开本会话的警告列表（新的在前，`c` 清空，Esc 关闭），列表按会话隔离，只存于内存。
- 回应用户自己输入的 warning 仍直接写在 transcript：内核接受该输入之前（命令 handler 执行期间、普通消息的 input hook，例如暂停目标的 `/goal resume` 提醒）发出的 warning 都算回复；接受之后的回合内 warning 归入徽标。Pi 样式不使用徽标，所有 warning 保持原来的 transcript 行。
- 输入框首个 `/command` token 使用主题 accent，不给路径或正文中的斜杠着色；光标覆盖 token 时整词跳过。
- 独立 `ultracode` 关键词（不区分大小写）使用 accent，完整输入时一次高光从左扫向右，约 600ms 后保持静态；追加参数不重播，删除后重输可再次触发。光标覆盖整词时不着色或显示高光。
- 扫光使用当前主题 `accent`、`text` 和 bold，沿用 truecolor/256 色管线；最多 10 次刷新，失焦、清空、提交或退出时停止。没有常驻动画计时器。
- thinking 的行内代码用 muted；正文行内代码仍沿用 Markdown 主题。

实现边界：Goal 状态校验位于能力层；tips、关键词与扫光位于 CLI UI；基础编辑器只提供无业务语义的文本样式钩子，保持原生换行、滚动、粘贴、补全、撤销和光标路径。
