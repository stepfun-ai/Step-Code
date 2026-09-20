# 复查环境变量清理并验证 Step CLI 构建

用户要求仔细检查评审截图中的旧变量残留，并重新编译 Step CLI 验证运行。
本次授权本地编译和冒烟验证；不发布、不安装覆盖现有 step、不代发评审评论。

| Step | Tool | Expectation | Rollback |
|---|---|---|---|
| 复查源码、Shell 注入和旧变量测试 | rg、完整读取相关实现与测试、检查新增行 | 无旧变量读取/注入，测试及说明不新增旧名称 | 只读 |
| 清理测试和说明中的旧名称 | 验证完整环境键集合和调用方变量，运行定向测试 | 不新增旧名称或变相编码，保留行为覆盖 | 仅撤回本次测试改动 |
| 编译本机独立产物 | scripts/build-binaries.sh --product step --offline-model-data --platform darwin-arm64 --skip-install --skip-deps --out /tmp/step-cli-env-verify-20260920 | 包编译、Bun 编译及打包成功 | 构建目录为本次专用临时目录 |
| 在仓库外验证 | 新产物 --help / --version、受控终端、最小 Step prompt | 启动、TUI、模型请求正常；不输出凭证 | 关闭本次测试进程，保留验证日志 |
| 完成检查并记录 | npm run check、git diff --check、计划归档 | 检查通过，明确产物与测试边界 | 保留诊断，不掩盖失败 |

## 评审修正

用户明确不允许测试、注释、说明及检查脚本新增旧名称。撤掉名称匹配门禁，改为验证环境键集合、默认缓存、终端自动探测及正常渲染无日志；执行记录使用行为描述。

## 验证结果

- 对比本次分支基线，新增行及新增执行记录均没有旧名称；未使用字符串拼接或编码规避。
- 修改后的定向测试：coding-agent 14、providers 13、TUI 109、检查脚本 13，共 149 通过。服务端和工具提示词另有 21 项通过。
- npm run check 与 git diff --check 通过；包管理器仍有已有配置提示，打包工具有本机 locale 提示，均未影响退出码。
- 本机独立产物完成包编译、Bun 编译、资源复制、归档及解压验证。最终目录：/tmp/step-cli-env-verify-final-20260920/darwin-arm64/step，版本 0.3.1。
- 仓库外 --help、--version 和未登录引导正常。
- 本地模拟模型发现与流式接口：文本输出 PONG、JSON 完成事件、真实 Bash 工具执行及结果回传通过，3 次请求完成，程序正常退出。
- 隔离配置下 TUI 启动、Shell 操作和窗口缩放通过。首次模拟缺少模型目录、首次终端驱动未处理引导页；补齐模拟响应和页面操作后通过，未为此改动产品实现。
- 最终冒烟日志：/var/folders/g2/10q1h9n54bvccxr4w_njw67m0000gp/T/step-binary-env-smoke-xbee_66c。
- 真实 Step 服务未验证：新产物和已安装 0.3.7 均返回 credentials_not_configured，需要登录。没有覆盖已安装程序或写入真实凭据。

本轮按此前授权追加提交并更新原源分支；不代发评论、不合并、不发布版本。
