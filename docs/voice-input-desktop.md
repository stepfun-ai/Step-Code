# 桌面端语音输入（Voice Input）· 验收文档

- 状态：已实施，待验收（2026-10-25）
- 范围：StepCode Desktop（`apps/desktop` + `apps/web`）输入框语音听写
- 本文档用途：产品验收 + PR 说明；技术实现只作索引，细节由前后端同学 review 时把关

---

## 1. 一句话

对着输入框说话，转写文字落进输入框光标处，改一改再发——和手打完全同一链路。

## 2. 背景与目标

终端已有语音插件 StepFun-Voice（服务终端用户，不动它）。桌面端缺「边说边改」的输入方式：本功能把语音听写做进 composer，目标是——

1. 输入框旁一个麦克风按钮，一键开始/结束；
2. 转写文字插入光标处，复用既有发送链路（Enter / Cmd+Enter / turn 运行中排队）；
3. 凭证自动配置：优先复用用户已有的 Step 凭证，不额外填 Key；
4. 不新增运行时依赖（Node 自带 WebSocket，已验证支持自定义鉴权头）。

非目标：不做「说完自动提交」（保持人工确认）；不做客户端 VAD（停顿判定用服务端 VAD）。

## 3. 产品交互（验收重点）

### 3.1 入口与外显规则

- 位置：输入框右侧控制区，模型选择器与发送按钮之间。
- **外显规则**：仅当检测到可用凭证（环境变量 Key / 登录态 / MP 自定义通道三级解析，host 侧 `/api/v1/voice` 一次性判定）时按钮才渲染；**不可用时按钮不外显**（承修的建议——不留灰色禁用态，避免无谓困惑）。凭证查询未返回前同样不渲染，无闪烁。
- 按钮态：空闲（麦克风图标）→ 点击后连接中（转圈）→ 录音中（红色、放大、轻脉冲）。

### 3.2 录音条（录音中）

点麦克风后按钮上方浮出录音条（不挤压 composer 布局）：

- **波形条 ×5**：随真实说话音量实时起伏（采集端每 100ms 算一次音量推上来，非假动画）；
- **计时**：mm:ss；
- **✕ 取消**：丢弃本次录音，不转写、不插入，立即 idle；
- **✓ 完成**：停止收音并转写插入。

### 3.3 转写等待态

点「完成」后录音条变为「识别中…」直到文字落进输入框——整段音频上传识别需要一两秒，这期间有明确反馈，不会误以为卡死。

### 3.4 文字落点与发送

- 文字插入光标处，与前文自动隔一个空格；发送按钮状态同步（和手打一致）。
- turn 运行中听写：文字照常进输入框，走排队，与手打语义相同。
- 麦克风先打开、再开 host 会话：授权被拒（最常见失败）不会在 host 留下一个没人会停止的会话，否则之后每次点击都会 409。
- 转写为**整段识别、一次性返回全文**（开平 ASR `stepaudio-2.5-asr`），没有逐字流式；与手机听写「说完出整段」的习惯一致。

### 3.5 快捷键与边界

- **Esc**：取消并丢弃本次录音（不插入）。连接中与「识别中」同样生效——这两个阶段录音条只有转圈，没有可点的取消按钮。
- 错误场景（断网 / 识别服务失败 / 麦克风被拒 / 采集失败 / 未识别到语音）：toast 明确提示原因，按钮回空闲可重试。

## 4. 验收清单

- [ ] 有凭证（已登录 Step / 配了开平 Key）：按钮外显；点麦克风 → 系统授权弹窗（首次）→ 录音条（波形/计时/取消/完成）→ 说话 → 点完成 → 一两秒后文字进输入框 → Enter 发送成功
- [ ] 只配了外部模型（司内 MP）未登录：按钮不外显，composer 无残留占位
- [ ] 录音中点 ✕：立即丢弃，无文字、无 toast，可立即重录
- [ ] 录音中按 Esc：同上
- [ ] turn 运行中听写：文字进输入框并排队，不抢占、不报错
- [ ] 断网点麦克风：清晰错误 toast，按钮回空闲
- [ ] 转写等待态可见（「识别中…」），最终文字落框

## 5. 已知边界

- **只认两种凭证**：环境变量里的开平 Key（`STEP_API_KEY`/`STEPFUN_API_KEY`）或 `auth.json` 里的 Step 登录态。司内 MP 等自定义模型代理（`models.json`）不接入——其 ASR 可用性无法预判，按钮不外显而非点击后报错。
- 仅桌面端目标环境（Electron/Chromium 内核）；Safari 非目标宿主。
- 采集为单声道 PCM16，host 打包 WAV 上传；单次录音上限 10 分钟 / 64 MB。
- 采样率以浏览器实际建成的 `AudioContext.sampleRate` 为准（首选 24kHz），随 `/start` 上报给 host 写进 WAV 头。浏览器若拒绝请求的采样率，按实际值标注，否则识别会变调而不是报错。

## 6. 实现概览（技术索引，供 review 把关）

| 层 | 位置 | 内容 |
|---|---|---|
| host | `apps/web/src/voice.ts`（新） | 语音中继：单会话分片缓冲、stop 时打包 WAV 调开平 ASR（`stepaudio-2.5-asr`）返回全文；凭证两级解析（env Key / auth.json 登录态，不含 MP 自定义通道）；分片/时长/大小上限 |
| host | `apps/web/src/voice-routes.ts`（新） | 5 端点：status / start / audio / stop（返回文本）/ cancel；`server.ts` 接线 + 关机清理 |
| host | `apps/web/test/voice.test.ts`（新） | 21 单测：凭证收窄（MP 不解析）、会话生命周期、限额、WAV 打包、ASR 转发与错误分类、取消 |
| 客户端 | `apps/web/client/src/features/voice/`（新） | MicButton + 录音条 UI；VoiceRecorder（getUserMedia→AudioWorklet 100ms 分片→POST、EventSource、取消/完成语义）；`client/public/voice-capture-worklet.js` 采集 + 音量 |
| 客户端 | composer / ShellEffects / i18n / IconSprite / types | 挂载按钮、Escape 取消链、双语文案、麦克风图标、wire 类型 |
| 桌面端 | `apps/desktop/src/window.ts` | 放行麦克风权限（media） |
| 协议 | `apps/web/openapi.yaml` | 5 端点 + VoiceStatus schema |
| e2e | `apps/web/test/e2e/web.e2e.mjs` | 新增 1 用例：按钮在 composer 内、可用态、status 不泄漏 Key |

**ASR 接入事实**（2026-10-25 实测）：`POST https://api.stepfun.com/v1/audio/transcriptions`，multipart（model=`stepaudio-2.5-asr`、response_format=json、file=WAV），Bearer 鉴权，一次性返回 `{text}`；Step Plan 登录 token 可直接调用，~470ms/3.5s 音频。注意 Step Plan 专属 base（`/step_plan/v1`）**没有** ASR 端点（404），统一走开平标准 base。

## 7. 验证记录

- host 单测 21/21；web 全量单测无回归；三端 typecheck + biome 通过。
- 真实 ASR 服务（真实登录凭证 + 合成/人声语音）：转写正确返回；host 端到端（页面内 API 驱动）start → 35 分片 → stop → 正确文字；空录音返回空文本不调服务。
- 真实浏览器（CDP 驱动 Electron + 真实麦克风）：录音条全要素、波形实时跳动、计时、转写态均实测通过；无凭证时按钮不渲染实测通过。
- 已知环境备忘：AudioWorklet 全局无 `btoa`（采集用手写 base64 + 异常上报，防静默死亡）；麦克风回声消除开启时外放测试音采不到（真人说话正常）。

## 8. 关联

- 终端语音插件 StepFun-Voice（`github.com/Zgh332358/StepFun-Voice`）继续服务终端用户，本功能不改动它。
