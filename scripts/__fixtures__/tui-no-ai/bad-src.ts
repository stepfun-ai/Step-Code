// Fixture: a NON-compliant tui source file — imports AI-side packages. Only read by
// `check-tui-no-ai.mjs --self-test`; never part of the real build (scripts/ is outside
// tsconfig include and biome includes). Bare (non-relative) specifiers keep check:ts-imports quiet.
import OpenAI from "openai";
import { createModel } from "@step-harness/providers";

export function boom() {
	return [OpenAI, createModel];
}
