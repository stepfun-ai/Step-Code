import { describe, expect, test } from "vitest";
import { redactDiagnosticPii } from "../src/step/feedback/redact-diagnostics.ts";

describe("redactDiagnosticPii", () => {
	test("redacts bare emails", () => {
		expect(redactDiagnosticPii("contact owner@example.com now")).toBe("contact <redacted:email> now");
	});

	test("redacts urls", () => {
		expect(redactDiagnosticPii("see https://api.example.com/x?y=1 for details")).toContain("<redacted:url>");
	});

	test("redacts posix absolute paths including CJK home directories", () => {
		expect(redactDiagnosticPii("failed at /Users/张三/项目/stepcode")).toContain("<redacted:path>");
	});

	test("redacts windows absolute paths", () => {
		expect(redactDiagnosticPii("C:\\Users\\张三\\项目\\stepcode")).toContain("<redacted:path>");
	});

	test("keeps the node_modules tail after collapsing the user prefix", () => {
		const output = redactDiagnosticPii("/Users/me/proj/node_modules/pkg/index.js");
		expect(output).toContain("node_modules/pkg/index.js");
		expect(output).not.toContain("/Users/me");
	});

	test("leaves ordinary diagnostic text intact", () => {
		expect(redactDiagnosticPii("a normal log line with no pii")).toBe("a normal log line with no pii");
	});
});
