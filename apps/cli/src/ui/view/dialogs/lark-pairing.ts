import type { LarkPairingCode } from "@step-harness/lark-adapter";
import { type Component, Text, truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import QRCode from "qrcode";

/** Keep the QR intact; wrapping or clipping its rows makes it unscannable. */
export async function createLarkPairingView(code: LarkPairingCode, getRows: () => number): Promise<Component> {
	let qr: string[] = [];
	try {
		qr = (await QRCode.toString(code.verificationUrl, { type: "terminal", small: true, errorCorrectionLevel: "L" }))
			.trimEnd()
			.split("\n")
			.filter((line) => visibleWidth(line) > 0);
	} catch {
		// Pairing remains usable through the complete link if encoding fails.
	}
	const userCode = new URL(code.verificationUrl).searchParams.get("user_code");
	const lifetime =
		code.expiresInSeconds >= 60 ? `${Math.floor(code.expiresInSeconds / 60)} 分钟` : `${code.expiresInSeconds} 秒`;
	const heading = new Text("connect · 扫码或打开下面的链接，选择要绑定的机器人（可复用已有的）：", 1, 0);
	const details = new Text(
		[
			code.verificationUrl,
			"",
			`${userCode ? `验证码 ${userCode}，` : "链接"}${lifetime}内有效。`,
			"凭据只保存在当前进程内存中，断开后本 CLI 不再使用。",
			"使用 /connect off 取消。",
		].join("\n"),
		1,
		0,
	);
	return {
		invalidate() {
			heading.invalidate();
			details.invalidate();
		},
		render(width) {
			const top = heading.render(width).map((line) => truncateToWidth(line, width, ""));
			const bottom = details.render(width).map((line) => truncateToWidth(line, width, ""));
			const fits =
				qr.length > 0 &&
				qr.every((line) => visibleWidth(line) + 2 <= width) &&
				top.length + qr.length + bottom.length + 8 <= getRows();
			return [...top, ...(fits ? ["", ...qr.map((line) => ` ${line} `), ""] : []), ...bottom];
		},
	};
}
