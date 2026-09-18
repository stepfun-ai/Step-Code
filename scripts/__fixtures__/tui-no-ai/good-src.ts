// Fixture: a compliant tui source file (renderer-only imports). Not compiled by the
// gate (scripts/ is outside tsconfig include and biome includes); scanned only under
// `check-tui-no-ai.mjs --self-test`.
import { marked } from "marked";
import { readFileSync } from "node:fs";

export function render(markdown: string): string {
	void readFileSync;
	return marked.parse(markdown) as string;
}
