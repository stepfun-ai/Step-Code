import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent, type MarkdownContentProps } from "../client/src/ui/MarkdownView/markdown-content.ts";

const labels = { code: "Code", copy: "Copy", table: "Table", diagram: "Diagram" };

/** Rendered body without the Streamdown root wrapper. */
function render(source: string, props: Partial<MarkdownContentProps> = {}): string {
	const html = renderToStaticMarkup(createElement(MarkdownContent, { source, labels, ...props }));
	return html.replace(/^<div class="[^"]*md-root">/, "").replace(/<\/div>$/, "");
}

test("renders named sources with escaped URLs and safe new-tab attributes", () => {
	assert.equal(
		render("- [今日金价](https://example.com/price?a=1&b=2)"),
		'<ul>\n<li><a href="https://example.com/price?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">今日金价</a></li>\n</ul>',
	);
});

test("supports parentheses in destinations and bare URLs beside punctuation", () => {
	const html = render(
		"[Source](https://example.com/wiki/Gold_(metal)) (https://example.com/price). https://example.com/报价。",
	);
	assert.match(html, /href="https:\/\/example.com\/wiki\/Gold_\(metal\)"/);
	assert.match(html, /href="https:\/\/example.com\/price"[^>]*>https:\/\/example.com\/price<\/a>\)\./);
	assert.match(html, /href="https:\/\/example.com\/%E6%8A%A5%E4%BB%B7"[^>]*>https:\/\/example.com\/报价<\/a>。/);
});

test("emphasis around a bare URL never becomes part of the link", () => {
	const url = "https://github.com/stepfun-ai/Step-Code/pull/320";
	const link = `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
	for (const [source, expected] of [
		[`**${url}** done`, `<strong>${link}</strong> done`],
		[`已创建：**${url}**。仓库在`, `已创建：<strong>${link}</strong>。仓库在`],
		[`_${url}_ end`, `<em>${link}</em> end`],
		[`~~${url}~~ end`, `<del>${link}</del> end`],
	]) {
		assert.equal(render(source), `<p>${expected}</p>`, source);
	}
	// A marker with no opening partner stays text after the link.
	assert.equal(render(`看 ${url}**。`), `<p>看 ${link}**。</p>`);
});

test("preserves inline and fenced code without links or emphasis", () => {
	const html = render("`[**Source**](https://example.com)`\n\n```md\n[Source](https://example.com)\n```");
	assert.doesNotMatch(html, /<a |<strong>/);
	assert.match(html, /<code>\[\*\*Source\*\*\]\(https:\/\/example.com\)<\/code>/);
	assert.match(html, /<pre><code>\[Source\]\(https:\/\/example.com\)<\/code><\/pre>/);
});

test("rejects executable and local destinations while showing raw HTML as text", () => {
	for (const url of ["javascript:alert(1)", "data:text/html,evil", "file:///tmp/example", "//example.com"]) {
		assert.doesNotMatch(render(`[Source](${url})`), /<a |<button/, url);
	}
	const html = render('a <img src=x onerror=alert(1)> <script>alert(1)</script> [x](https://example.com/"onclick="evil)');
	assert.doesNotMatch(html, /<img|<script|" ?onclick=/);
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.match(html, /&lt;script&gt;/);
});

test("images never load: they read as a link to their source", () => {
	const html = render("![chart](https://example.com/p.png) ![local](./out/a.png)");
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /<a href="https:\/\/example.com\/p.png"[^>]*>chart<\/a>/);
	assert.match(html, / local<\/p>$/);
});

test("handles incomplete streaming Markdown and keeps surrounding formatting", () => {
	assert.doesNotMatch(render("[Source](https://", { streaming: true }), /<a /);
	assert.equal(
		render("## Sources\n**Read [source](https://example.com)**"),
		'<h3>Sources</h3>\n<p><strong>Read <a href="https://example.com" target="_blank" rel="noopener noreferrer">source</a></strong></p>',
	);
	// Streaming closes an unfinished emphasis instead of showing its marker.
	assert.equal(render("**bold so far", { streaming: true }), "<p><strong>bold so far</strong></p>");
});

test("a settled glob is not mistaken for unfinished emphasis", () => {
	assert.equal(render("运行 ./src/**/* 这样的路径"), "<p>运行 ./src/**/* 这样的路径</p>");
});

test("renders the tool-state table as semantic rows with inline formatting", () => {
	const html = render(
		"## 已演示的状态\n\n| # | 状态 | 触发工具 | 说明 |\n|---|---|---|---|\n| 1 | **读取文件** | `read` | 读取目录与文件 |\n| 2 | 执行命令 | `bash` | pending → completed |\n\n后续说明",
	);
	assert.match(html, /<h3>已演示的状态<\/h3>\n<div class="md-table-scroll md-table-wrap"/);
	assert.match(html, /role="region" tabindex="0" aria-label="Table"/);
	assert.equal((html.match(/<th scope="col"/g) ?? []).length, 4);
	assert.equal((html.match(/<td /g) ?? []).length, 8);
	assert.match(html, /<strong>读取文件<\/strong>/);
	assert.match(html, /<code>read<\/code>/);
	assert.match(html, /<\/table><\/div>\n<p>后续说明<\/p>$/);
});

test("supports alignment and optional edge pipes with Windows line endings", () => {
	const html = render("Name | State | Count\r\n:--- | :---: | ---:\r\nread | done | 3\r\n");
	assert.match(html, /<th scope="col" class="md-align-left">Name<\/th>/);
	assert.match(html, /<th scope="col" class="md-align-center">State<\/th>/);
	assert.match(html, /<td class="md-align-right">3<\/td>/);
});

test("escaped pipes, inline code and links stay in their cells", () => {
	const html = render("| Value | Source |\n| --- | --- |\n| a\\|b and `x \\| y` | [Docs](https://example.com/a?x=1&y=2) |\n");
	assert.equal((html.match(/<td /g) ?? []).length, 2);
	assert.match(html, /a\|b and <code>x \| y<\/code>/);
	assert.match(html, /href="https:\/\/example.com\/a\?x=1&amp;y=2"/);
});

test("incomplete or mismatched delimiters and ordinary prose do not become tables", () => {
	for (const text of ["| A | B |\n| --- |", "a | b\n--- | not-a-rule", "a | b"]) {
		assert.doesNotMatch(render(text), /<table\b/, text);
	}
});

test("table examples in closed or unfinished fenced code stay literal", () => {
	const table = "| A | B |\n| --- | --- |\n| a | b |";
	for (const text of [`\`\`\`md\n${table}\n\`\`\``, `\`\`\`md\n${table}`, `~~~md\n${table}\n~~~`]) {
		assert.doesNotMatch(render(text), /<table\b/);
	}
});

test("table cells and accessible labels cannot inject markup or executable links", () => {
	const html = render(
		"| <img src=x onerror=alert(1)> | **Header** |\n| --- | --- |\n| [Bad](javascript:alert(1)) | <script>alert(1)</script> |",
		{ labels: { ...labels, table: '" onfocus="alert(1)' } },
	);
	assert.doesNotMatch(html, /<img|<script|<a |" onfocus="/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /aria-label="&quot; onfocus=&quot;alert\(1\)"/);
});

test("streaming prefixes always render balanced tables", () => {
	const text = "| Action | Detail |\n| --- | --- |\n| **Read** | `src/main.ts` |\n| Link | [Docs](https://example.com) |";
	for (let end = 0; end <= text.length; end += 1) {
		const html = render(text.slice(0, end), { streaming: true });
		assert.equal((html.match(/<tr>/g) ?? []).length, (html.match(/<\/tr>/g) ?? []).length);
	}
});

test("renders quotes and rules as blocks instead of their source characters", () => {
	const html = render("前文\n\n> 引用块 **加粗** 与 `code`\n> 第二行\n\n---\n\n后文");
	assert.match(html, /<blockquote>\n<p>引用块 <strong>加粗<\/strong> 与 <code>code<\/code>\n第二行<\/p>\n<\/blockquote>/);
	assert.match(html, /<hr\/>/);
	assert.equal(html.includes("&gt; 引用块"), false);
});

test("numbered, nested and task list items keep their structure", () => {
	const html = render("3. 第三步\n4. 第四步\n\n- 并列\n  - 嵌套两级\n\n* [x] 完成\n* [ ] 未完成");
	assert.match(html, /<ol start="3">\n<li>第三步<\/li>\n<li>第四步<\/li>\n<\/ol>/);
	assert.match(html, /<li>并列\n<ul>\n<li>嵌套两级<\/li>\n<\/ul>\n<\/li>/);
	assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled="" checked=""\/> 完成<\/li>/);
});

test("fenced code keeps its copy button, language label and a readable fallback", () => {
	const html = render("```TypeScript extra\nconst a = 1;\n```\n\n```\n<b>\n```");
	assert.match(
		html,
		/<div class="code-block" data-language="TypeScript"><div class="code-block-header"><span>TypeScript<\/span><button class="copy-code" type="button">Copy<\/button><\/div><pre><code>const a = 1;<\/code><\/pre><\/div>/,
	);
	assert.match(html, /<span>Code<\/span>.*<code>&lt;b&gt;<\/code>/s);
});

test("a Mermaid fence shows its source until the diagram draws", () => {
	const html = render("```mermaid\ngraph TD; A-->B\n```");
	assert.match(html, /<div class="code-block" data-language="mermaid">.*<code>graph TD; A--&gt;B<\/code>/s);
	// While streaming the diagram is not drawn at all: the fence stays code.
	assert.match(render("```mermaid\ngraph TD; A-->B\n```", { streaming: true }), /data-language="mermaid"/);
});

test("renders block and inline math with KaTeX", () => {
	const html = render("$$x^2$$ and $$\n\\frac{a}{b}\n$$");
	assert.match(html, /<span class="katex">/);
	assert.match(html, /<annotation encoding="application\/x-tex">x\^2<\/annotation>/);
});

test("italic and strikethrough around prose; a single tilde stays literal", () => {
	assert.equal(render("*斜体*"), "<p><em>斜体</em></p>");
	assert.equal(render("中文*斜体*文本"), "<p>中文<em>斜体</em>文本</p>");
	assert.equal(render("~~删除~~ 与 ~保留~"), "<p><del>删除</del> 与 ~保留~</p>");
	assert.equal(render("这是**加粗文字**。然后"), "<p>这是<strong>加粗文字</strong>。然后</p>");
});

test("single asterisks in arithmetic, identifiers and code stay literal", () => {
	// CommonMark allows intraword `*a*` emphasis (`a*b*c`), like GitHub; underscores and spaced asterisks do not.
	for (const text of ["2 * 3 * 4", "snake_case_value", "x *y", "*a *"]) {
		assert.doesNotMatch(render(text), /<em>/, text);
	}
	assert.equal(render("`*not italic*` 和 *yes*"), "<p><code>*not italic*</code> 和 <em>yes</em></p>");
});

test("multi-backtick code spans keep inner backticks and drop one padding space", () => {
	assert.equal(render("``a`b``"), "<p><code>a`b</code></p>");
	assert.equal(render("`` `x` ``"), "<p><code>`x`</code></p>");
	assert.equal(render("``[**x**](https://example.com)``"), "<p><code>[**x**](https://example.com)</code></p>");
});

test("attached-file markers become chips in text and file names in code", () => {
	const html = render("看 \u00020\u0002 和 `\u00020\u0002`", {
		fileNames: ["a.txt"],
		renderFile: (index) => createElement("b", { className: "chip" }, `file-${index}`),
	});
	assert.equal(html, '<p>看 <b class="chip">file-0</b> 和 <code>a.txt</code></p>');
});

test("headings sit one level below the surface title", () => {
	assert.equal(render("# A\n\n#### D"), "<h2>A</h2>\n<h4>D</h4>");
});
