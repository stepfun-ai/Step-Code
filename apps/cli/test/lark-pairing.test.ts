import { visibleWidth } from "@step-harness/pi-tui";
import QRCode from "qrcode";
import { describe, expect, it, vi } from "vitest";
import { createLarkPairingView } from "../src/ui/view/dialogs/lark-pairing.ts";

const code = {
	deviceCode: "never-display-device-code",
	verificationUrl: "https://open.feishu.cn/page/cli?user_code=TEST-CODE&lpv=0.1.0&ocv=0.1.0&from=cli",
	expiresInSeconds: 3600,
	pollIntervalSeconds: 5,
};

describe("Lark pairing view", () => {
	it("renders the complete encoder output and Step CLI pairing copy", async () => {
		const view = await createLarkPairingView(code, () => 60);
		const lines = view.render(120);
		const expected = (await QRCode.toString(code.verificationUrl, { type: "terminal", small: true, errorCorrectionLevel: "L" }))
			.trimEnd().split("\n").filter((line) => visibleWidth(line) > 0).map((line) => ` ${line} `);
		expect(expected.length).toBeGreaterThan(10);
		expect(lines.slice(2, 2 + expected.length)).toEqual(expected);
		expect(lines.join("\n")).toContain("选择要绑定的机器人（可复用已有的）");
		expect(lines.join("\n")).toContain(code.verificationUrl);
		expect(lines.join("\n")).toContain("验证码 TEST-CODE，60 分钟内有效。");
		expect(lines.join("\n")).not.toContain(code.deviceCode);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("hides rather than clips the QR on narrow or short terminals and restores it on resize", async () => {
		let rows = 60;
		const view = await createLarkPairingView(code, () => rows);
		const wide = view.render(120);
		for (const width of [1, 20, 40]) {
			const lines = view.render(width);
			expect(lines.join("\n")).not.toMatch(/[▀▄█]/u);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		rows = 24;
		expect(view.render(120).join("\n")).not.toMatch(/[▀▄█]/u);
		expect(view.render(120).join("\n")).toContain(code.verificationUrl);
		rows = 60;
		view.invalidate();
		expect(view.render(120)).toEqual(wide);
	});

	it("retains the complete link when encoding fails and uses the actual lifetime", async () => {
		const encoder = vi.spyOn(QRCode, "toString").mockRejectedValueOnce(new Error("encoder fixture"));
		try {
			const view = await createLarkPairingView({ ...code, expiresInSeconds: 30 }, () => 60);
			const rendered = view.render(120).join("\n");
			expect(rendered).toContain(code.verificationUrl);
			expect(rendered).toContain("验证码 TEST-CODE，30 秒内有效。");
			expect(rendered).not.toContain("encoder fixture");
		} finally {
			encoder.mockRestore();
		}
	});
});
