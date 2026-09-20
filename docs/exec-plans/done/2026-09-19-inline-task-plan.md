# 任务改为流内 Updated Plan

用户明确取消常驻任务面板和逐条 task_create 回执。保留四个 task 工具、任务存储、依赖验证及 /todos；普通视图隐藏创建和单项读取，task_update/task_list 显示完整清单，完成打勾、进行中使用 accent 加粗和标记，不附加 `(in progress)`。标题显示 `Updated Plan (已完成/总数)`，与清单取自同一份结果快照。错误和展开详情仍可见。

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 移除任务 widget 更新 | apply_patch | 创建、更新、恢复不再占据输入框上方面板，任务状态正常保存 | 仅反向撤销本轮 tasks 增量 |
| 结果携带完整快照并自绘 | apply_patch | 每次更新仅渲染自身不可变快照；原模型可见 JSON 不变；无需修改通用 TUI | 撤销新详情字段及 renderer 接线 |
| 增加状态与真实组件回归 | 指定 Vitest 文件 | 创建成功无空白行、错误可见、清单不截为五项、历史不漂移、窄屏不溢出 | 修正本轮实现 |
| 同步文档并检查 | npm run check、结构复核 | 无新增依赖/入口/会话存储；Tips 对齐测试同时通过 | 只撤销本轮增量，不碰其他工作区改动 |

不新增 update_plan 工具别名，不改变模型执行协议，不提交、不构建、不调用真实模型。

## 同步核对补充

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 核对任务写入、结果事件和历史恢复 | 源码阅读 | task Map 为唯一当前状态；按 toolCallId 投递结果；历史不读取 live Map | 不修改运行时 |
| 标题与清单统一由结果渲染 | apply_patch | 成功结果才显示完成计数；旧单项结果不伪造全量计数 | 仅撤销本次 renderer 增量 |
| 补充同步回归 | 指定 Vitest 文件、npm run check | 并发更新、失败、重开、删除、恢复、乱序结果事件不串状态 | 修正本次实现与测试 |

任务状态为显式记录，不与 bash/subagent 的执行结果自动绑定；完成工具调用不代表对应任务完成。隐藏创建回执意味着新任务在下一次 task_update/task_list 才出现在流内快照，/todos 可读取即时状态。

## 完成记录

- 产品 task 测试 37 项、实际 TUI 组件测试 8 项通过；覆盖并发写入、计数与持久化快照一致、验证失败不改状态、重开/删除、会话恢复、乱序结果事件、历史不漂移和窄屏。
- `npm run check` 与结构机械检查通过；npm 提示已有两项 workspace 配置警告，未改动项目配置。
- 标题和列表都由成功结果快照生成；不在参数流或部分结果阶段提前显示计数。旧单项历史无全量数据时不显示伪造的分母。
- 不修改 task 执行语义、agent loop、会话状态来源或通用 TUI。

| 结构规则 | 判定 | 本轮范围 |
| --- | --- | --- |
| R1 | PASS | 未新增反向依赖 |
| R2 | PASS | 未新增非界面到界面内部引用 |
| R3 | PASS | 未修改 tui 包 |
| R4 | PASS | 未修改跨进程契约 |
| R5 | PASS | 未新增可执行命令 |
| R6 | PASS | task 能力仍在产品 features |
| R7 | PASS | 未修改 provider 接入 |
| R8 | PASS | 未修改启动顺序 |
| R9 | PASS | 未新增 workspace |
| R10 | PASS | 未新增顶层工具目录 |
| R11 | PASS | 保留工具名及导出 |
| R12 | PASS | 显示在 renderer，状态由 task extension 持有 |
