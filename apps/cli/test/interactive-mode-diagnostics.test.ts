import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../../../packages/coding-agent/src/core/diagnostics.ts";
import type { SourceInfo } from "../../../packages/coding-agent/src/core/source-info.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

type DiagnosticFormatter = {
	formatDiagnostics(diagnostics: ResourceDiagnostic[], sources: Map<string, SourceInfo>): string;
	formatPathWithSource(path: string): string;
	findSourceInfoForPath(): undefined;
};

function format(diagnostics: ResourceDiagnostic[]): string {
	const mode = Object.create(InteractiveMode.prototype) as DiagnosticFormatter;
	mode.formatPathWithSource = () => "[project] example/SKILL.md";
	mode.findSourceInfoForPath = () => undefined;
	return stripVTControlCharacters(mode.formatDiagnostics(diagnostics, new Map()));
}

describe("resource diagnostics", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		"invalid YAML frontmatter at line 3, column 14: invalid YAML",
		'frontmatter is missing "description" — add e.g. description: "..."',
	])("prints a self-contained frontmatter diagnostic on one line: %s", (reason) => {
		const path = "/skills/example/SKILL.md";
		const output = format([{ type: "warning", path, message: `${path}: ${reason}` }]);
		expect(output).toBe(`  [project] example/SKILL.md: ${reason}`);
	});

	it("preserves the separate path line for other diagnostics", () => {
		expect(format([{ type: "error", path: "/skills/example/SKILL.md", message: "cannot read file" }])).toBe(
			"  [project] example/SKILL.md\n    cannot read file",
		);
	});

	it("renders diagnostics without paths", () => {
		expect(format([{ type: "warning", message: "no skill directories found" }])).toBe("  no skill directories found");
	});
});
