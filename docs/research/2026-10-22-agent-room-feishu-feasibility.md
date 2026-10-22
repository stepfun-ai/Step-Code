# Agent 会议室 · 飞书载体可行性调研

> 研究日期：2026-10-22
> 调研对象：[飞书开放平台](https://open.feishu.cn/?lang=zh-CN) 消息与群组（IM）服务端 API、事件订阅
> 对应方案：[Agent 会议室产品方案](../agent-room-design.md)
> 性质：平台能力核验，不定义当前实现。§0–§11 为文档层面的判断；§12 是在真实租户里用 lark-cli 实测的结果，凡与前面冲突以 §12 为准。

## 0. 结论先行

| 方案假设 | 平台是否支持 | 依据 |
| --- | --- | --- |
| bot 能收到群里**所有**消息（不止 @ 自己的） | 支持，但需申请敏感权限 | `im:message.group_msg` |
| bot 能收到**另一个 bot** 的消息 | 支持，但要用单独的 `include_bot` 权限 | `im:message.group_msg.include_bot:read` |
| bot 能用文字消息 @ 另一个 bot 完成交棒 | **实测：语法成立**。`<at user_id>` 接受 bot 的 open_id，落成真 @ 并带 `mentions` | [发送消息内容](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)、§12.3 |
| 一个 bot 能建群并拉另一个 bot 入群 | 支持 | `POST /open-apis/im/v1/chats` 的 `bot_id_list` |
| 两个 bot 同群不触发相互回环 | 不自动规避，需自控 | 应用层规则 |
| 每个 bot 都能拿到完整 transcript | 支持，但有顺序与可见性坑 | 见 §6 |

**最重要的一条**：你原先假设的“都能看到”在平台文档里**不是默认行为**，而是要专门申请的权限；而且“看到用户的 @”和“看到别的 bot 的消息”是两组不同的权限。这直接决定第一件事该做什么。

## 1. 接收消息：权限决定看到什么

[接收消息 `im.message.receive_v1`](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive) 的推送范围由应用持有的权限决定，文档原文分四档：

| 场景 | 所需权限 |
| --- | --- |
| 单聊消息 | `im:message.p2p_msg:readonly` |
| 群里**用户** @ 本 bot | `im:message.group_at_msg` / `im:message.group_at_msg:readonly` |
| 群里**用户及其他 bot** @ 本 bot | `im:message.group_at_msg.include_bot:readonly` |
| 群里**所有用户及其他 bot** 的消息 | `im:message.group_msg.include_bot:read` |
| 群里所有**用户**消息（不含 bot） | `im:message.group_msg` |

三点直接影响方案：

1. **“都能看到”要申请 `im:message.group_msg`，官方标注为“敏感权限”。** 企业管理员审批、可用范围、发布流程都会卡在这里。“人参与越少越好”与“装一个能读全群消息的 bot”在审批侧是矛盾的。
2. **只开 `im:message.group_msg` 拿不到对方 bot 的消息。** 必须额外开 `im:message.group_msg.include_bot:read`。你期望的“A 不 @ B 说话，B 也看得见”依赖这条。
3. 文档明确 `sender_type` 区分 `user` / `bot`；`mentions[].mentioned_type` 也区分 `user` / `bot`。所以应用层区分“谁说的、@ 的是谁”是可行的，现有 [Lark 连接](../../docs/lark-connection.md) 里的 `not-mentioned` 过滤逻辑需要为群房间换一套判定。

### 事件体里可用的字段

对交棒协议直接有用的：`message.message_id`、`create_time`（毫秒）、`chat_id`、`chat_type`（`p2p` / `group`）、`mentions[]`（含 `key`、`id.open_id`、`mentioned_type`）、`sender.sender_type`、`root_id` / `parent_id` / `thread_id`。

文档还明确提示：**“特殊情况下可能会收到重复的推送，如有幂等需求请使用 `message_id` 去重，不要依赖 `event_id`”** —— 这正好对应方案 §5.4。

## 2. 发送与 @

[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) 与 [回复消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply) 都是 `receive_id_type=chat_id` 发到群里，发送方身份即调用方 bot。

@ 的文本语法在 [发送消息内容](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json) 里写作：

```text
<at user_id="ou_xxx">User</at>
```

文档对这一行的说明是“支持 @ 单个用户或所有人”，`user_id` 可传 user_id / open_id / union_id。**文档没有写明可以传 bot 的 open_id 来 @ 一个机器人**（官方示例用的是 `ou_` 前缀的用户身份）。

同理，卡片里的 @ 写法 `<at id="ou_cf986xxxx"></at>` 也只示例了用户。

**结论：bot 之间互 @ 是整条链路里最不确定的一环，必须先实测。** 实测办法：群里让 A bot 发一条文本消息，内容带 `<at user_id="{B的open_id}"></at> 你好`，观察两件事——群里是否显示成真正的 @ 蓝色标签；B 是否收到 `im.message.receive_v1` 且 `mentions` 里出现自己的 open_id。

如果文字 @ bot 不成立，退路是：

- **回复链交棒**：用 `im/v1/messages/:message_id/reply` 回复对方上一条消息。回复关系本身足够表达“接棒”，`root_id` / `parent_id` 能重建对话树。代价是群里看不到 @ 标签，人读起来略弱。
- **判断谁说的**：既然开了 `include_bot`，B 可以直接按 `sender.sender_type === "bot"` 且 `sender.sender_id.open_id` 是 A 来触发，不依赖 @ 语义。这时 @ 只是给人看的装饰。

## 3. 建群与拉人

[创建群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/create) `POST /open-apis/im/v1/chats`：

- `bot_id_list` 传的是**应用的 App ID**（`cli_xxx`），不是 open_id；调用方 bot 自动入群。
- 每次最多邀请 5 个 bot，且入群后群内 bot 总数不能超过 15 个。两个 bot 的房间完全够用。
- `user_id_list` 最多 50 个用户。
- `owner_id` 不填时群主是建群的 bot；建议填自然人。
- 查询参数 `uuid` 支持 10 小时内去重，适合“重复点创建不要建出两个群”。
- **API 只能建普通消息群**，不能直接建话题群。

[拉人入群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/create) 的 `member_id_type` 支持 `app_id`，同样用来拉 bot；文档提示同一群并发调用可能报 `232019`，建议串行。

[主动加入群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/me_join) 只支持**公开群**，私有群不能用。所以配对流程里更好的做法是：**A bot 直接建群时把 B bot 拉进来**，而不是让 B 自己找进来。

## 4. 跨租户：目前是硬墙

你最初提的“和同事面对面”如果在同一公司，以上全部成立。如果跨公司，[机器人支持外部群和外部用户单聊](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group) 的规则是：

- 仅企业自建应用可开对外共享，且需完成企业认证或个人实名认证。
- 共享机器人的 OpenAPI 权限是**白名单**：文档列出的支持项里包含 `im:message.group_msg`（获取群组中所有消息），但**不包含** `im:message.group_msg.include_bot:read`。
- 外部群的群主必须是自然人，bot 不能当群主。
- 邀请外部用户入群前需用户确认，且机器人无法查询外部用户通讯录。

也就是说，跨租户时“看到对方 bot 的消息”这条权限拿不到。跨租户房间在现有平台能力下**不成立**，除非两个租户之间建立关联组织关系（文档标注为内测、逐步开放）。

## 5. 并发与限频

[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) 的“使用限制”原文：

> 向同一用户发送消息的限频为 5 QPS、向同一群组发送消息的限频为**群内机器人共享** 5 QPS。

这条对双 bot 房间的含义：**两个 agent 的发言共享同一个 5 QPS 的群配额**，不是各 5 QPS。同时在群里说话会互相拖累。接口本身标注为 1000 次/分钟、50 次/秒，但群维度的 5 QPS 更紧，应以它为准。

方案本身的发言是串行的（棒子机制），正常不会撞上限；但流式输出如果按 token 改卡片频率过高，就会撞。现有 [Lark 连接](../../docs/lark-connection.md) 的卡片更新策略需要按群维度重新算预算。

对同一请求重试去重用 `uuid`（1 小时内相同 uuid 至多成功一条）。

## 6. 完整 transcript 的三个坑

即使两个 bot 都开了全量权限，也**不能假设事件流就是完整有序的 transcript**：

1. **重复**：文档明说可能重复推送，必须用 `message_id` 去重。
2. **乱序/缺口**：长连接重连期间可能丢事件，需要游标 + 补洞。[获取会话历史消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list) 支持 `start_time` / `end_time`（秒级）、`sort_type=ByCreateTimeAsc`、`page_size` 上限 50。
3. **补洞的权限代价**：文档写明，以应用身份取**群聊**历史消息，除了任一单聊场景权限外，**还必须开启 `im:message.group_msg`**。也就是说想补洞就必须拿敏感权限——与 §1 是同一个审批门槛。

另有两个边界：

- `230073`：群关闭了“新成员可查看历史消息”时，操作者入群前的话题对其不可见。
- `231203`：群若开了“保密模式”禁止复制消息，则**无法获取消息**。这类群不能当房间用，创建时应显式关掉 `restricted_mode_setting`。

## 7. 安全

- 对方的 bot 输出对我是 untrusted input。平台层面没有“bot 是不是同事”这种信任标记，只有 `sender_type=bot`。所以 §5.3 的约束只能落在我们自己的应用层：room 消息走普通用户消息通道，不携带任何权限提升语义。
- 卡片回调（`card.action.trigger`）需带 `chat_id` 与 token；多 agent 同群时，token 必须绑到 `(bot, chat, 具体那一次 UI request)`。现有实现是 chat 级 token，多 agent 化要改。
- 权限方面：`im:message.group_msg` 是敏感权限，会把“读全群”的能力交给一个跑在个人终端里的进程。这一点建议在方案层面明确接受，并只在房间群内使用。

## 8. 需要实测的清单

按代价从低到高排。前 5 条已有可直接运行的探针脚本（见 §8.1），不需要先动仓库代码：

1. **bot 之间互 @**：A 发文本带 `<at user_id="{B_open_id}">`，确认落成真 @ 且 B 收到事件。**这条决定交棒实现方式，优先做。**
2. **`include_bot` 是否真的推送**：开 `im.message.group_msg.include_bot:read` 后，A 发一条不 @ 任何人的消息，确认 B 是否有事件。
3. **敏感权限审批**：申请 `im:message.group_msg` 在企业租户里要多久、是否被卡。
4. **群维度 5 QPS 的实际表现**：两个 bot 同时发消息时的报错码与退避行为。
5. **建群 + 拉另一 bot**：`bot_id_list` 里传对方 App ID，确认对方 bot 真进群且能看到历史。
6. **卡片回调在多 bot 同群时的投递**：确认回调只投给卡片所属应用。

### 8.1 探针脚本

仓库之外的三个小脚本，用来在真实租户里把上面几条钉死。放临时目录即可，不进入本仓库：

| 脚本 | 作用 |
| --- | --- |
| `probe.mjs` | 零依赖 REST 客户端：`whoami`（取 bot open_id）、`chat`（建群并拉 bot/用户）、`send`（发消息，可带 `<at>`）、`history`、`message` |
| `listen.mjs` | 长连接事件监听，每个 bot 一个进程，把 `sender_type` / `mentioned_type` / `mentions` 逐条落盘成 JSON 行 |
| `diff-views.mjs` | 对比两个 bot 各自收到的 `message_id` 集合与次序，直接回答“两边看到的是不是同一份 transcript” |

事件订阅用长连接模式，不需要公网地址和回调配置，这也是后续嵌入 stepcode 时成本最低的形态。

一个 SDK 行为值得记下来：`WSClient.start()` 在握手失败（例如 app_id/secret 错误）时**仍然 resolve**，不抛错；判断连上与否要看 `onReady` 是否触发，不能看 Promise 的结果。

脚本只验证平台行为，不涉及 session、权限或 transcript 语义。

### 8.2 飞书官方 CLI（lark-cli）能承担到什么程度

官方已开源 [飞书 CLI](https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu)（`@larksuite/cli`，实际可执行文件名 `lark-cli`），定位是“给 Agent 操作飞书的手”。它的能力边界对本方案很关键：

| 方案要素 | lark-cli 是否覆盖 |
| --- | --- |
| 建群并一次拉齐用户与 bot | 覆盖：`im +chat-create --bots cli_xxx --users ou_xxx --as bot` |
| 群内发消息（含 `<at>`） | 覆盖：`im +messages-send --content '<JSON>'` |
| 实时接收群消息事件 | 覆盖：`event consume im.message.receive_v1`（本地事件总线守护进程，长连接） |
| 拉历史消息做补洞 | 覆盖：`im +chat-messages-list` |
| 卡片交互回调 | 覆盖：`event consume card.action.trigger` |
| 8 位房间码的会合 | **不覆盖**：CLI 无“按码发现对端”的语义 |
| 两个 agent 的交棒与上下文投影 | **不覆盖**：属于 agent 侧语义 |

结论：lark-cli 能替掉 `lark-adapter` 里相当一部分协议封装（建群、收发、事件订阅、资源下载），把验证成本从“写脚本”降到“敲命令”。它替不掉的两件事正是方案的核心：**码的会合** 与 **session 侧的棒子语义**。

嵌入 stepcode 时的取向应当是：**协议调用可以借 CLI 的形态但不能依赖其进程模型**——CLI 是给 agent 直接调用的工具，而 room 需要在同一进程内持有 session 生命周期、中断与权限决策。可行的折中是复用其命令词汇与参数形状（`--bots` / `--users` / `--as bot`），实现仍走 SDK。

两个前置条件：CLI 的操作依赖**绑定的应用已发布版本**（实测中未发布版本会提示 “app has no published version”），以及事件订阅需要在应用后台开启长连接投递。这两点与直接调 API 的限制相同，CLI 并没有绕过应用发布流程。

## 9. 对方案的修正建议

结合以上，建议把方案 §4 的配对流程改成**由建群方一次性完成**：

1. A 的终端 `/room create` → 生成本地码。
2. B 终端 `/room join <code>` → 通过某个 rendezvous（待定）把 B 的 App ID 与用户 open_id 告诉 A。
3. **A 的 bot 调 `POST /open-apis/im/v1/chats`**，`bot_id_list=[B的AppID]`、`user_id_list=[两人open_id]`、`owner_id=其中一人`、`restricted_mode_setting.status=false`、`uuid=房间ID`。
4. 双方终端各自确认后开始收发。

这样避免了“B 自己找群”依赖公开群的问题（§3），也把建群放在唯一一支已确认在群里的 bot 手上。

### 9.1 码的交换：飞书本身不给现成的路

方案里 8 位码的问题是“乙方输入码之后，怎么把这个码和自己的身份送到甲方那里”。核对下来，飞书**没有**按码查人 / 查群的接口：

- [搜索群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/search) 只搜“当前身份可见的群”，需要群已存在，不能用来发现尚未建群的房间。
- [主动加入群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/me_join) 只支持公开群。
- 机器人既不能主动发起单聊，也不能给“不在可用范围内”的用户发消息（`230013`），所以“甲方 bot 直接私聊乙方”这条路不通。
- 机器人**能**收到单聊消息，所以“乙方 bot 收到乙方发来的码、再想办法把码转给甲方 bot”在理论上可行，但需要一次由人触发的中转，且甲方 bot 无法接受来自未知用户的私聊。

结论：**码必须由一个中立的会合点保管**，飞书只能承载“建群和对话”，承载不了“发现”。这是一处新增的基础设施需求，量级很小（一个带 TTL 和限次的 KV），但必须承认它存在。方案 §11 列了三个选项。

## 10. 参考资料

- [接收消息（im.message.receive_v1）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)
- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [回复消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply)
- [获取会话历史消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)
- [发送消息内容（@ 语法）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)
- [消息概述](https://open.feishu.cn/document/server-docs/im-v1/introduction)
- [创建群](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/create)
- [将用户或机器人拉入群聊](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/create)
- [用户或机器人主动加入群聊](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-members/me_join)
- [机器人支持外部群和外部用户单聊](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/develop-robots/add-bot-to-external-group)
- [如何启用机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)

## 12. 实测记录（lark-cli 1.0.96，真实租户）

用一个已配置的 lark-cli 应用（个人 agent 类型，`--as bot` 与 `--as user` 双身份可用）在真实租户里跑了一遍。本节所有结论都来自实际返回，不是文档推断。

### 12.1 建群与拉 bot

```bash
lark-cli im +chat-create --as user --name room-probe-A --bots cli_xxx --users ou_xxx
```

- 返回 `ok: true`，并给出 `chat_id`、`owner_id`（自然人）、`share_link`。
- 随后 `im +chat-members-list` 显示 `user_total: 1, bot_total: 1`，bot 以 `member_id: ou_3bd2...` 的身份在群里，`app_id` 与建群应用一致。
- **注意**：`+chat-create` 输出的 JSON 里**没有** bot 列表，拉 bot 是否成功必须再查一次成员列表。

结论：用户身份建群 + 一次带 `--bots` 拉入机器人在真实租户里成立，方案 §4 第 4 步可直接照做。

### 12.2 bot 身份与身份隔离

- 同一个机器人加入多个群时，`member_id`（即 open_id）**保持稳定**，跨群一致。分发与 @ 判定可以放心用单一 open_id。
- 以 bot 身份向**它不在的群**发消息，返回 `230002 Bot/User can NOT be out of the chat.`；向它在的群发送成功，响应里的 `chat_id` 与请求一致，可直接用于路由核对。
- 以 bot 身份读群历史消息，返回 `230027 access denied for this bot operation`。**这印证了 §6 第 1 点：bot 读群历史需要单独的权限，默认不可用。**
- 已授权用户身份的 scope 集合里**没有** bot 侧的 `im:message.group_msg`、`im:message.group_at_msg*`、`im:message.send_as_bot`。个人 agent 类型应用拿到的是一套偏 `*:get_as_user` 的用户侧权限。

结论：多群分发里“bot 主动发言”的权限要单独确认；个人 agent 应用的 bot 侧权限面比用户侧窄得多。

### 12.3 @ 语义

| 实验 | 结果 |
| --- | --- |
| bot 发文本 `<at user_id="ou_<人类>">` | 成功，`mentions[0].id` = 该用户，`name` 解析正确 |
| bot 发文本 `<at user_id="ou_<自己>">` | 成功，`mentions[0].id` = 自己，**说明 `user_id` 属性确实接受 bot 的 open_id** |
| bot 发纯文本不 @ | `mentions` 为空 |

结论：`<at user_id>` 的校验是按 open_id 解析参与者，**不区分用户与机器人**。bot @ bot 的语法基础成立。（“另一个 bot 能否收到该事件”仍需双 bot 实测，见 12.5。）

### 12.4 事件订阅链路

```bash
lark-cli event consume im.message.receive_v1 --as bot --timeout 180s --output-dir /tmp/evt
```

- 自动拉起本地事件总线守护进程，`feishu-websocket: connected`，`ready event_key=im.message.receive_v1`。
- 期间在群里发了 2 条 bot 消息、1 条带 @ bot 的用户消息，**收到 0 条事件**。
- 日志提示 `skipped console precheck: app has no published version`。

结论：**长连接通道是通的，但事件是否推送取决于应用是否已发布版本、是否在后台开启了该事件的订阅与长连接投递。** 这一步在测试应用上没通过，不能据此判断平台行为；必须在已发布且配置好事件订阅的正式应用上重跑。

### 12.5 对方案的影响

| 项 | 之前 | 实测后 |
| --- | --- | --- |
| bot @ bot 交棒 | 待实测 | 语法成立，事件投递待双 bot 验证 |
| bot 读群历史补洞 | 认为需敏感权限 | 确认被拒（`230027`），权限确为硬门槛 |
| 建群拉 bot | 文档推断 | 真实租户成立，但需二次查成员确认 |
| 事件接收 | 文档推断 | 通道通；**未发布应用收不到事件** |
| bot 侧权限 | 未区分 | 个人 agent 应用的用户 scope 不含 bot 侧消息权限 |

剩余唯一未闭环的问题：**两个真实 bot 同群时，A @ B 后 B 是否收到事件并看到 `mentioned_type: "bot"`。** 这需要在两个已发布、已配置事件订阅的 bot 应用上重跑 12.4。

测试中创建的群（`room-probe-A`、`room-probe-B`、`room-probe-C-nobot` 及一个临时群）留在测试租户里，可自行删除。

### 12.6 最小权限清单

lark-cli 绑定的那个应用有 194 个用户侧 scope，是因为它是“给 agent 操作整个飞书”的通用工具，不是产品应用。**产品应用不应继承这套授权面**：它既超出最小必要，也全是用户侧身份，解决不了机器人侧的问题。

按方案动作逐个反查（`lark-cli schema im` 的 `_meta.scopes` 与官方文档），Phase 1 需要的是：

| 动作 | 必需 scope | 身份 |
| --- | --- | --- |
| 群内被 @ 时收到事件 | `im:message.group_at_msg`（或 `:readonly` 版本） | 事件订阅 |
| 以机器人身份发言 | `im:message:send_as_bot` | `tenant_access_token` |
| 建群（并一次拉齐 bot 与用户） | `im:chat:create` | 机器人 |
| 建群时以自然人作为群主 | `im:message.send_as_user` | **`user_access_token`** |
| 拉人入群 / 校验成员 | `im:chat.members:write_only` / `im:chat.members:read` | 机器人 |
| 消息加表情（进度与取消） | `im:message.reactions:write_only` | 机器人 |
| 撤回消息 | `im:message:recall` | 机器人 |

共约 7 个，全部集中在 IM 域。三个补充判断：

- **`im:message:send_as_bot` 与 `im:message` 是二选一的关系**，前者范围更窄，应选前者。
- **纯机器人应用建不了“自然人为群主”的群**：`owner_id` 校验需要用户身份，因此“建群”这一步实际要用 `user_access_token`（`im:chat:create_by_user` 或建群接口的用户身份分支）。这意味着即使主链路是 bot，**一次性用户授权仍然省不掉**，只授权一次即可。
- **`im:message.group_msg`（读全群）不在上表**：它是敏感权限，Phase 1 用不到；Phase 2 若要做全量 transcript 再单独申请审批。

用户侧其余 190 余个 scope（妙记、OKR、邮箱、日程、任务、多维表格等）与本方案无关，应全部不申请。授权页上每多一条用不到的条目，都在增加“用户愿不愿意点这个按钮”的成本。
