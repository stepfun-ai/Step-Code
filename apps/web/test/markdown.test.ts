import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../client/src/lib/markdown.ts";

const labels = { code: "Code", copy: "Copy", table: "Table" };

test("renders named sources with escaped URLs and safe new-tab attributes", () => {
	const html = renderMarkdown("- [今日金价](https://example.com/price?a=1&b=2)", labels);
	assert.equal(
		html,
		'<span class="md-li"><a href="https://example.com/price?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">今日金价</a></span>',
	);
});

test("supports parentheses in destinations and bare URLs beside punctuation", () => {
	const html = renderMarkdown(
		"[Source](https://example.com/wiki/Gold_(metal)) (https://example.com/price). https://example.com/报价。",
		labels,
	);
	assert.match(html, /href="https:\/\/example.com\/wiki\/Gold_\(metal\)"/);
	assert.match(html, /href="https:\/\/example.com\/price"[^>]*>https:\/\/example.com\/price<\/a>\)\./);
	assert.match(html, /href="https:\/\/example.com\/报价"[^>]*>https:\/\/example.com\/报价<\/a>。/);
});

test("preserves inline and fenced code without links or emphasis", () => {
	const html = renderMarkdown(
		"`[**Source**](https://example.com)`\n\n```md\n[Source](https://example.com)\n```",
		labels,
	);
	assert.doesNotMatch(html, /<a |<strong>/);
	assert.match(html, /<code>\[\*\*Source\*\*\]\(https:\/\/example.com\)<\/code>/);
	assert.match(html, /<pre><code>\[Source\]\(https:\/\/example.com\)<\/code><\/pre>/);
});

test("rejects executable and local destinations while escaping HTML and attributes", () => {
	for (const url of ["javascript:alert(1)", "data:text/html,evil", "file:///tmp/example", "//example.com"]) {
		assert.doesNotMatch(renderMarkdown(`[Source](${url})`, labels), /<a /);
	}
	const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com/"onclick="evil)', labels);
	assert.doesNotMatch(html, /<img|"onclick=/);
	assert.match(html, /&lt;img/);
	assert.match(html, /&quot;onclick=&quot;/);
});

test("handles incomplete streaming Markdown and keeps surrounding formatting", () => {
	assert.equal(renderMarkdown("[Source](https://", labels), "[Source](https://");
	assert.equal(
		renderMarkdown("## Sources\n**Read [source](https://example.com)**", labels),
		'<h3>Sources</h3><strong>Read <a href="https://example.com" target="_blank" rel="noopener noreferrer">source</a></strong>',
	);
});

test("renders the tool-state table as semantic rows with inline formatting", () => {
	const html = renderMarkdown(
		"## 已演示的状态\n\n| # | 状态 | 触发工具 | 说明 |\n|---|---|---|---|\n| 1 | **读取文件** | `read` | 读取目录与文件 |\n| 2 | 执行命令 | `bash` | pending → completed |\n\n后续说明",
		labels,
	);
	assert.match(html, /<h3>已演示的状态<\/h3><div class="md-table-scroll md-table-wrap"/);
	assert.match(html, /role="region" tabindex="0" aria-label="Table"/);
	assert.equal((html.match(/<th scope="col"/g) ?? []).length, 4);
	assert.equal((html.match(/<td /g) ?? []).length, 8);
	assert.match(html, /<strong>读取文件<\/strong>/);
	assert.match(html, /<code>read<\/code>/);
	assert.match(html, /<\/table><\/div>后续说明$/);
});

test("supports alignment and optional edge pipes with Windows line endings", () => {
	const html = renderMarkdown(
		"Name | State | Count\r\n:--- | :---: | ---:\r\nread | done | 3\r\n",
		labels,
	);
	assert.match(html, /<th scope="col" class="md-align-left">Name<\/th>/);
	assert.match(html, /<th scope="col" class="md-align-center">State<\/th>/);
	assert.match(html, /<td class="md-align-right">3<\/td>/);
});

test("escaped pipes, inline code and links stay in their cells", () => {
	const html = renderMarkdown(
		"| Value | Source |\n| --- | --- |\n| a\\|b and `x | y` | [Docs](https://example.com/a?x=1&y=2) |\n",
		labels,
	);
	assert.equal((html.match(/<td /g) ?? []).length, 2);
	assert.match(html, /a\|b and <code>x \| y<\/code>/);
	assert.match(html, /href="https:\/\/example.com\/a\?x=1&amp;y=2"/);
	assert.doesNotMatch(html, /\u0000|\u0001/);
});

test("pads short rows, ignores surplus cells and preserves empty cells", () => {
	const html = renderMarkdown(
		"| A | B |\n| --- | --- |\n| one |\n| | two |\n| three | four | ignored |\n",
		labels,
	);
	assert.equal((html.match(/<td /g) ?? []).length, 6);
	assert.match(html, /<td class="md-align-left">one<\/td><td class="md-align-left"><\/td>/);
	assert.doesNotMatch(html, /ignored/);
});

test("incomplete or mismatched delimiters and ordinary prose do not become tables", () => {
	for (const text of ["a | b\n--- |", "| A | B |\n| --- |", "a | b\n--- | not-a-rule", "a | b"]) {
		assert.doesNotMatch(renderMarkdown(text, labels), /<table\b/);
	}
	const html = renderMarkdown("| A | B |\n| --- | --- |\n\n- List | text\n## Next | heading", labels);
	assert.match(html, /<span class="md-li">List \| text<\/span>/);
	assert.match(html, /<h3>Next \| heading<\/h3>/);
});

test("table examples in closed or unfinished fenced code stay literal", () => {
	const table = "| A | B |\n| --- | --- |\n| a | b |";
	for (const text of [`\`\`\`md\n${table}\n\`\`\``, `\`\`\`md\n${table}`, `~~~md\n${table}\n~~~`]) {
		assert.doesNotMatch(renderMarkdown(text, labels), /<table\b/);
	}
});

test("table cells and accessible labels cannot inject markup or executable links", () => {
	const html = renderMarkdown(
		"| <img src=x onerror=alert(1)> | **Header** |\n| --- | --- |\n| [Bad](javascript:alert(1)) | <script>alert(1)</script> |",
		{ ...labels, table: '" onfocus="alert(1)' },
	);
	assert.doesNotMatch(html, /<img|<script|<a |" onfocus="/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /aria-label="&quot; onfocus=&quot;alert\(1\)"/);
});

test("streaming prefixes never leak table or inline protection tokens", () => {
	const text = "| Action | Detail |\n| --- | --- |\n| **Read** | `src/main.ts` |\n| Link | [Docs](https://example.com) |";
	for (let end = 0; end <= text.length; end += 1) {
		const html = renderMarkdown(text.slice(0, end), labels);
		assert.doesNotMatch(html, /\u0000|\u0001/);
		if (html.includes('<table class="md-table">')) {
			assert.match(html, /<\/table><\/div>/);
			assert.equal((html.match(/<tr>/g) ?? []).length, (html.match(/<\/tr>/g) ?? []).length);
		}
	}
});

test("renders GFM pipe tables with alignment, inline formatting and escaped cells", () => {
	const html = renderMarkdown(
		"我用加载器实验复现了：\n\n| 场景 | 结果 |\n|---|--:|\n| 父目录 + `a|b` | **成功** |\n| <b>x</b> \\| y | 退出码 1 |\n\n后文",
		labels,
	);
	assert.match(html, /<table class="md-table"><thead><tr><th scope="col" class="md-align-left">场景<\/th><th scope="col" class="md-align-right">结果<\/th><\/tr><\/thead>/);
	assert.match(html, /<td class="md-align-left">父目录 \+ <code>a\|b<\/code><\/td><td class="md-align-right"><strong>成功<\/strong><\/td>/);
	assert.match(html, /<td class="md-align-left">&lt;b&gt;x&lt;\/b&gt; \| y<\/td>/);
	assert.match(html, /^我用加载器实验复现了：<div class="md-table-scroll md-table-wrap"/);
	assert.match(html, /<\/table><\/div>后文$/);
});

test("leaves pipes without a delimiter row as text", () => {
	assert.equal(renderMarkdown("| a | b |", labels), "| a | b |");
	assert.equal(renderMarkdown("| a | b |\n|---|", labels), "| a | b |<br>|---|");
});

test("renders quotes and rules as blocks instead of their source characters", () => {
	// A side answer that talks *about* Markdown used to show a literal ">" and "---".
	const html = renderMarkdown("前文\n\n> 引用块 **加粗** 与 `code`\n> 第二行\n\n---\n\n后文", labels);
	assert.match(html, /<blockquote>引用块 <strong>加粗<\/strong> 与 <code>code<\/code><br>第二行<\/blockquote>/);
	assert.match(html, /<hr>/);
	assert.equal(html.includes("&gt; 引用块"), false);
	assert.equal(html.includes("<br>---"), false);
});

test("numbered and nested list items keep their structure", () => {
	const html = renderMarkdown("1. 第一步\n2. 第二步\n\n- 并列\n  - 嵌套两级", labels);
	assert.match(html, /<span class="md-li md-oli" data-n="1">第一步<\/span><span class="md-li md-oli" data-n="2">第二步<\/span>/);
	assert.match(html, /<span class="md-li md-li-nested">嵌套两级<\/span>/);
	// Item blocks do not gain a line break between them.
	assert.equal(/data-n="1">第一步<\/span><br>/u.test(html), false);
});

test("a rule inside a fenced block stays code", () => {
	const html = renderMarkdown("```\n---\n> quote\n```", labels);
	assert.match(html, /<code>---\n&gt; quote<\/code>/);
	assert.equal(html.includes("<hr>"), false);
	assert.equal(html.includes("<blockquote>"), false);
});

test("passes a fence's language to the code highlighter and keeps unhighlighted fences escaped", () => {
	const seen: string[] = [];
	const html = renderMarkdown("```TypeScript extra\nconst a = 1;\n```", labels, {
		highlightCode: (code, language) => {
			seen.push(`${language}:${code}`);
			return `<span class="tok-keyword">const</span>${code.slice(5)}`;
		},
	});
	assert.deepEqual(seen, ["typescript:const a = 1;"]);
	assert.match(html, /<code><span class="tok-keyword">const<\/span> a = 1;<\/code>/);
	assert.match(renderMarkdown("```\n<b>\n```", labels), /<code>&lt;b&gt;<\/code>/);
});

test("ends a bare URL where the sentence resumes after its query", () => {
	const html = renderMarkdown("看 https://git.example.com/a/tree/x?ref_type=heads这个分支上，然后加一个流水线", labels);
	assert.match(html, /href="https:\/\/git.example.com\/a\/tree\/x\?ref_type=heads"[^>]*>[^<]*<\/a>这个分支上，然后/);
});
