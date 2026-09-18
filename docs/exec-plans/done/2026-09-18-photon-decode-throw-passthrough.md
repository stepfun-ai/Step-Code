# 2026-09-18 Photon 解码失败时预算内原图透传

## 背景

MR !81 修了 Photon **模块整体缺失**时预算内原图全灭的问题,但其"边界"里留了一条:
`image-resize-core.ts` 的 Photon 可用路径整段 `try/catch → null`,当
`PhotonImage.new_from_byteslice`(或 EXIF 处理)对**特定图**抛异常时——Photon
解码器不认的容器变体、损坏 EXIF 等——即使原图在预算内(≤2000×2000 且 base64
<4.5MB)也返回 null,`processImage` 报 "Image omitted: could not be resized"。
倒挂:同一张图在 Photon 完全缺失时反而能经 header 解析透传。判据不变:只救
预算内的图,不放宽任何字节/像素上限。

## Step / Tool / Expectation / Rollback

1. **Step** `resizeImageInProcess` 的 catch 分支从 `return null` 改为
   `return passthroughIfWithinLimits(inputBytes, mimeType, inputBase64Size, opts)`;
   同步更新函数与 `passthroughIfWithinLimits` 的 doc comment(两条 fallback
   触发条件:模块缺失、对本图解码/处理抛异常)。
   **Tool** Edit `packages/coding-agent/src/utils/image-resize-core.ts`。
   **Expectation** 预算内图在 decode-throw 下透传 `wasResized:false`;
   超像素/超字节/不认识的 header 仍 null(同错误)。in-budget 分支(:87)在
   decode 成功时先行早退,catch 路径不会误放超预算图(passthrough 自带三查)。
   **Rollback** `git checkout -- <file>`。

2. **Step** 测试:在 `test/image-resize-photon-unavailable.test.ts` 增加
   "Photon decode throws" describe,mock `loadPhoton` 返回
   `new_from_byteslice` 抛异常的假 photon;用例:预算内 PNG 透传、4000×4000
   header 仍拒、maxBytes=1 仍拒。
   **Tool** Edit 测试文件,`node .../vitest/dist/cli.js --run test/<file>`。
   **Expectation** 新旧用例全绿(原 5 例 + 新 3 例)。
   **Rollback** 还原测试文件。

3. **Step** 收尾:CHANGELOG `[Unreleased] → Fixed` 追加一条(紧跟 !81 那条);
   `npm run check`;不提交不推送,汇报后按用户指令路由 MR。
   **Tool** Edit + Bash。
   **Expectation** check exit 0。
   **Rollback** 还原 CHANGELOG。

## 边界

- catch 路径透传用 header 原始尺寸(无法做 EXIF 旋转,与模块缺失路径同语义);
  默认上限 2000×2000 对称,不会因旋转漏放。
- 不动 worker 链路与 `processImage` 上游;不动 BMP→PNG 转换(`image-convert.ts`
  无 Photon 仍不可转,属另一故障类)。

## 追加(用户指令:预算对齐 Claude Code)

用户追问"能不能不要预算,claude 怎么做的,对齐"。对本机 Claude Code 2.1.220
二进制(`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
Bun ELF,minified JS 可 grep)做了逐函数还原,ground truth:

- 常量 `XY={maxWidth:2000,maxHeight:2000,maxBase64Size:5242880,targetRawSize:3932160}`;
  read 图片走 `tBs`→`Olt(buffer,len,fmt,limits)`。
- `Olt`:预算内(raw≤3932160 且 ≤2000×2000)原样透传;超字节不超尺寸=原尺寸重
  编码(png palette→jpeg 80/60/40/20);超尺寸=fit-2000 resize+同阶梯;**最后
  无条件 `min(width,1000)` q20 JPEG,永不失败**;sharp 解码失败→header 兜底
  (b64≤5242880 且 ≤2000×2000 透传,否则 throw)。
- `tBs` 在 `Olt` 之后还有两道我们**未引入**的额外压缩:`>512000` raw 二分
  质量 JPEG 重压(Nor=512000),以及 token 预算(`ceil(w/28)*ceil(h/28)`)超限
  的重压。引入会把预算内原图也转 JPEG,与"原图保真"诉求相反,留待用户定夺。

对齐改动(同分支):DEFAULT_MAX_BYTES 4.5MB→5242880、比较 `<`→`<=`;主体重写
为四段(透传/原尺寸重编码/fit-resize/无条件 q20 兜底);`return null` 仅剩
"解码失败且 header 无法证明预算内"。测试:`maxBytes:1` 用例翻转为永不丢图、
字节超限用例锚死尺寸不变;全部 image 测试 48/48。

