import { describe, expect, test } from "vitest";
import { stepErrorHint } from "../src/ui/view/transcript/step-error-hints.ts";

describe("stepErrorHint 错误恢复建议", () => {
	test("命令不存在 → 检查拼写或安装依赖", () => {
		expect(stepErrorHint("bash: fd: command not found")).toBe("命令不存在：检查拼写，或先安装对应依赖");
		expect(stepErrorHint("Error: spawn rg ENOENT")).toBe("命令不存在：检查拼写，或先安装对应依赖");
	});

	test("权限不足 → 审批模式与文件权限", () => {
		expect(stepErrorHint("EACCES: permission denied, open '/root/secret'")).toBe(
			"权限不足：确认审批模式与文件权限后重试",
		);
	});

	test("路径不存在 → 先列目录", () => {
		expect(stepErrorHint("ENOENT: no such file or directory, open 'src/missing.ts'")).toBe(
			"路径不存在：让模型先列目录确认结构",
		);
	});

	test("网络/超时 → 重试或代理", () => {
		expect(stepErrorHint("fetch failed: ETIMEDOUT")).toBe("网络或超时：稍后重试，或检查代理配置");
	});

	test("语法错误 → 拆小步", () => {
		expect(stepErrorHint("/bin/sh: -c: line 1: syntax error near unexpected token `|'")).toBe(
			"命令语法有误：可让模型拆小步重试",
		);
	});

	test("未知错误 → 通用建议（不臆测原因）", () => {
		expect(stepErrorHint("something totally unexpected happened")).toBe(
			"可回复「重试」让模型换一种方式，或补充说明预期结果",
		);
	});

	test("空文本 → 通用建议", () => {
		expect(stepErrorHint("   ")).toBe("可回复「重试」让模型换一种方式，或补充说明预期结果");
	});
});
