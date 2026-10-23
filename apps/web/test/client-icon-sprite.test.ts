import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

test("icon registry resolves every shared and feature-specific symbol exactly once", () => {
	const text = readFileSync(new URL("../client/src/ui/IconSprite/IconSprite.tsx", import.meta.url), "utf8");
	const source = ts.createSourceFile("IconSprite.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const names: string[] = [];
	const missing: string[] = [];
	const symbols: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const target = node.name.text === "ICON_NAMES" ? names : node.name.text === "MISSING_FROM_LIBRARY" ? missing : null;
			if (target) {
				const value = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
				assert.ok(ts.isArrayLiteralExpression(value));
				for (const element of value.elements) {
					assert.ok(ts.isStringLiteral(element));
					target.push(element.text);
				}
			}
		}
		if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "symbol") {
			const id = node.attributes.properties.find(
				(attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "id",
			);
			assert.ok(id && ts.isJsxAttribute(id) && id.initializer && ts.isStringLiteral(id.initializer));
			symbols.push(id.initializer.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(names.length > 0);
	assert.equal(new Set(names).size, names.length, "Registry names must be unique");
	assert.equal(new Set(symbols).size, symbols.length, "Symbol IDs must be unique");
	assert.deepEqual(symbols.sort(), names.map((name) => `i-${name}`).sort());
	assert.equal(new Set(missing).size, missing.length);
	for (const name of missing) assert.ok(names.includes(name), `Unknown library gap: ${name}`);
	// PR #270 must retain feature symbols when shared design-library artwork changes. (The terminal's
	// clipboardPaste symbol was dropped together with its copy/paste/clear buttons.)
	for (const name of ["stepPlatform", "accountCheck", "summaryRing", "bot", "disclosure"]) {
		assert.ok(names.includes(name), `Missing feature symbol: ${name}`);
	}
});
