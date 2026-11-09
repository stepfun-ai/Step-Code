# StepCode 拓展市场开发交接

本目录说明 `feat/extension-market` 分支的拓展市场现状、运行方式和后续开发要求。交接包含当前代码、规范及安装资源；这不是全部第三方服务已完成授权或业务验收的发布声明。

交接日期：2026-11-09。目标仓库：https://github.com/stepfun-ai/Step-Code/tree/feat/extension-market。

## 1. 交付范围

| 内容 | 项目内位置 |
| --- | --- |
| 拓展包及展示规范 | [extension-package-standard.md](../extension-package-standard.md) |
| 批量分类、改造、注册和跨会话续办流程 | [extension-onboarding-standard.md](../extension-onboarding-standard.md) |
| 市场页面、详情及样式 | [市场功能目录](../../apps/web/client/src/features/market/) |
| 当前商品目录 | [catalog.json](../../apps/web/client/src/features/market/catalog/catalog.json) |
| 当前插件安装资源 | [plugin-market.json](../../apps/web/resources/plugin-market.json) |
| 当前技能安装资源 | [skill-market.json](../../apps/web/resources/skill-market.json) |
| 插件资源打包脚本 | [package-plugin-market.mjs](../../apps/web/scripts/package-plugin-market.mjs) |
| 技能资源打包脚本 | [package-skill-market.mjs](../../apps/web/scripts/package-skill-market.mjs) |
| 连接器配置模板生成脚本 | [package-connector-templates.mjs](../../apps/web/scripts/package-connector-templates.mjs) |
| 插件安装行为与边界 | [plugin-market.md](../plugin-market.md) |

本批次按项目负责人的明确要求，将两个当前安装资源文件直接纳入分支。项目负责人已确认本批次资源有权在目标仓库分发；每项实际许可和附带声明仍以各资源包为准，不统一改成项目的 MIT 许可。以后新增或更新第三方内容仍需重新核查许可、来源与凭据风险。

不将个人登录配置、API 密钥、`node_modules`、编译产物、本机 `.git` 目录或已拒绝拓展的旧安装资源备份作为文件提交。最初约 1.4 GB 的采集目录不纳入本次提交，不能假定接手机器存在旧开发者路径。

## 2. 当前市场

| 类型 | 数量 |
| --- | ---: |
| 插件 | 15 |
| 独立技能 | 36 |
| 连接器 | 11 |
| 合计 | 62 |

按项目负责人提供的飞书决策表 revision 224，移除了明确“拒绝”的14个插件和4个连接器；独立技能表不在该次移除范围内，36个技能保留。拒绝插件同时从精选安装资源移除，避免只隐藏列表但仍可调用精选安装API。

决策表：

- 插件：https://wvixbzgc0u7.feishu.cn/wiki/E5fwwd00uia4yWkb7kOcRqnsnsf?sheet=ffjbsL
- 连接器：https://wvixbzgc0u7.feishu.cn/wiki/E5fwwd00uia4yWkb7kOcRqnsnsf?sheet=LtGobW

后续以重新读取的最新决策为准，不将本日期的状态作为永久名单，也不自动恢复已拒绝条目。

## 3. StepFun 官方技能

“官方”仅指 StepFun，不指第三方原厂。以下6项由项目负责人明确确认：

| 提供的名称或目录 | 市场运行名称 |
| --- | --- |
| experience-design | experience-design |
| motion-interaction-skill | motion-interaction-skill |
| new_brandskills | stepfun-brand-uiux |
| style-fidelity | style-fidelity |
| svg优化skills | svg-optimize |
| web-icon-system | web-icon-system |

这些条目使用 `selfMade: true`，列表与详情显示“StepFun 官方”，市场介绍仅增加“StepFun 官方技能：”前缀，原正文及 SKILL.md 不改。官方标注不授予额外工具权限，也不等于已完成全部功能或安全验收。

## 4. 启动

环境要求见项目 `package.json`：Node.js ≥ 22.19.0，pnpm 9.15.9；Electron 依赖由桌面包声明。

取得分支后，在项目根目录安装依赖：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

该安装方式不会自动运行依赖生命周期脚本。全新机器需要单独准备 Electron 二进制；确认并允许下载后，可从项目根目录执行：

```bash
pnpm --filter @step-harness/desktop exec node node_modules/electron/install.js
```

之后启动：

```bash
pnpm desktop
```

在 macOS/Linux 上，如果宿主环境设置了 `ELECTRON_RUN_AS_NODE=1`，用以下命令仅对本次启动移除该变量：

```bash
env -u ELECTRON_RUN_AS_NODE pnpm desktop
```

桌面启动命令会检查并重建缺失或过期的 Web 和工作区输出。系统原生终端依赖、模型账号、外部CLI与MCP服务仍需按实际机器和项目文档准备；不要因此跳过权限检查或复制他人的登录文件。该交接没有在每种全新系统上重新安装测试。

## 5. 修改、打包与验证

先阅读项目与模块的 AGENTS.md，再按两份规范执行。已有介绍默认保留；翻译、改写或补充先给出对照并取得用户确认。Logo 可选，缺省图标为插件调节器、技能魔法棒，以及连接器终端或地球。

项目根目录的完整检查：

```bash
pnpm run check
```

该命令含自动格式化，执行后检查差异；不能把自动格式化产生的无关修改直接一起提交。

市场单元和资源回归测试，从 `apps/web` 执行：

```bash
pnpm exec tsx --tsconfig ../../tsconfig.json --test test/market-catalog.test.ts test/plugin-market.test.ts test/skill-market.test.ts
node --test test/e2e/extension-market.e2e.mjs
```

本次已执行完整项目检查、市场浏览器回归及目录、资源测试；缺 Logo 默认图标、6项官方徽标及介绍前缀均在浏览器中验证。测试通过不等于所有连接器已完成真实服务调用。

当前安装资源可以直接供 Host 使用。只有在取得规范化源目录并完成审核后，才重新生成资源；从项目根目录执行以下脚本时，最后一个参数必须是实际源目录，不能沿用原机器路径：

```bash
node apps/web/scripts/package-plugin-market.mjs "<规范化插件目录>"
node apps/web/scripts/package-skill-market.mjs "<规范化技能目录>"
node apps/web/scripts/package-connector-templates.mjs "<连接器资料目录>"
node apps/web/scripts/copy-market-payload.mjs
```

插件打包器仅收录当前 catalog 中存在的插件；包含商品详情的包内文档路径，必要时提供内容不变的根级 README 副本。技能与连接器生成脚本保留非空的已确认介绍。生成后仍须复核版本、作者、许可、组件清单、内容哈希和已拒绝条目未回流。

运行中的 Host 会缓存安装资源，更新 payload 后需要重新启动 Host 才能可靠生效，不擅自关闭他人的会话。`apps/web/resources/` 原有忽略规则可能继续影响新文件；两个已跟踪的资源更新正常提交，新资源入库必须明确确认，不能直接将整个目录强制加入。

## 6. 后续待办

- 对当前62个条目重新计算剩余元数据缺项；早期80项的统计属于历史快照。
- 补齐仍缺的接入说明、上游来源、适配维护者、版本与许可信息，不能编造。
- Unreal 的本地源码目录仍需固定并核实实际提交；其他固定包版本也没有替代真实运行验收。
- 继续做技能指令移植、全部间接引用、组件许可、Logo权利及跨平台验证。
- 实际服务授权与核心工具调用使用测试账户和测试工作区，不使用个人真实项目。
- 技能打包脚本当前仍检查36个技能；新增批次前需要按实际范围设计数量和目录一致性门禁，不只删除断言来掩盖漏包。

出包前解码安装资源中的常见文本进行 `secrun scan`，42个密码类候选经逐项脱敏复核，属于示例密码、测试数据、变量或参数名、环境变量引用及随机生成代码，未发现这些命中为实际账号凭据。此结论限该次扫描与命中复核，不等于完整安全认证；资源更新后应重新检查。

## 7. 在新会话中继续

把项目路径、上述两份规范和待处理范围提供给新会话，使用批量流程文档中的执行或续办模板。需要来源、授权或功能证据时明确记录阻塞，不用先前会话记忆替代磁盘与实际运行结果。

本分支交付当前工作树中的修改，不是仅交付最初的市场版本；提交与推送结果应以实际 Git 记录为准。
