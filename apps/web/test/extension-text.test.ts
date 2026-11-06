import assert from "node:assert/strict";
import test from "node:test";
import { hasDescriptionMarkup, normalizeExtensionDescription } from "../client/src/lib/extension-text.ts";

test("HTML comments, tags and badge markup are removed", () => {
	assert.equal(normalizeExtensionDescription("<!-- mcp-name: io.github.54yyyu/zotero-mcp -->"), "");
	assert.equal(normalizeExtensionDescription('<div align="center">'), "");
	assert.equal(
		normalizeExtensionDescription('<p align="center"> <picture> <img src="x.png" width="400"> </picture> </p>'),
		"",
	);
	assert.equal(
		normalizeExtensionDescription(
			"[![smithery badge](https://smithery.ai/badge/@GongRzhe/Office-Word-MCP-Server)](https://smithery.ai/server/@GongRzhe/Office-Word-MCP-Server)",
		),
		"",
	);
	assert.equal(normalizeExtensionDescription("&lt;div&gt;hi&lt;/div&gt;"), "hi");
});

test("a description cut mid-tag leaves no markup behind", () => {
	assert.equal(normalizeExtensionDescription('<!-- mcp-name: x --> <img src="h'), "");
	assert.equal(normalizeExtensionDescription("A server <img src=\"https://example.test/a.png for charts"), "A server");
});

test("markdown keeps its prose", () => {
	assert.equal(
		normalizeExtensionDescription("A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server."),
		"A Model Context Protocol (MCP) server.",
	);
	assert.equal(normalizeExtensionDescription("python-pptx. **Version 2.0** provides 32 tools."), "python-pptx. Version 2.0 provides 32 tools.");
	assert.equal(normalizeExtensionDescription("Reads `project.config.json` and `appid`."), "Reads project.config.json and appid.");
});

test("whitespace collapses and the full text is preserved for hover", () => {
	assert.equal(normalizeExtensionDescription("a\n\n  b\t c"), "a b c");
	const long = `${"word ".repeat(400)}end`;
	assert.equal(normalizeExtensionDescription(long), long.trim());
	assert.equal(normalizeExtensionDescription(""), "");
	assert.equal(normalizeExtensionDescription(undefined), "");
});

test("markup detection matches what the normalizer removes", () => {
	for (const value of ["<!-- c -->", "<p>", "![badge](u)", "[a](b)", "**b**", "`c`", "&lt;p&gt;"])
		assert.equal(hasDescriptionMarkup(value), true, value);
	for (const value of ["Plain text", "a - b", "1. item", "C++ / C#", "成本 - 低"])
		assert.equal(hasDescriptionMarkup(value), false, value);
});
