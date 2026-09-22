/**
 * Step 工具失败时的「怎么办」建议——错误呈现三要素的第三段。
 *
 * 三要素：`✗ 工具名`（发生了什么）→ 错误文本（为什么）→ `↳ 建议`（怎么办）。
 * 分类只做关键词匹配；宁可落到通用建议，也不对原因做臆测。
 */

const STEP_ERROR_HINTS: ReadonlyArray<{ match: RegExp; hint: string }> = [
	{
		match: /command not found|spawn.*ENOENT|is not recognized as/iu,
		hint: "命令不存在：检查拼写，或先安装对应依赖",
	},
	{ match: /permission denied|EACCES|EPERM/iu, hint: "权限不足：确认审批模式与文件权限后重试" },
	{ match: /no such file or directory|ENOENT/iu, hint: "路径不存在：让模型先列目录确认结构" },
	{ match: /EISDIR/iu, hint: "把目录当成了文件：检查目标路径类型" },
	{
		match: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|network error|timed? ?out/iu,
		hint: "网络或超时：稍后重试，或检查代理配置",
	},
	{ match: /syntax error|unexpected token|unexpected end of/iu, hint: "命令语法有误：可让模型拆小步重试" },
];

const GENERIC_HINT = "可回复「重试」让模型换一种方式，或补充说明预期结果";

/** Pick a recovery hint for a failed tool result's raw error text. */
export function stepErrorHint(errorText: string): string {
	const text = errorText.trim();
	if (!text) return GENERIC_HINT;
	for (const { match, hint } of STEP_ERROR_HINTS) {
		if (match.test(text)) return hint;
	}
	return GENERIC_HINT;
}
