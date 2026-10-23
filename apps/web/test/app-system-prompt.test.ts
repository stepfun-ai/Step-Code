import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildStepSystemPromptAppendix, STEP_APP_SYSTEM_PROMPT_PRODUCT } from "@step-harness/coding-agent";

const runtimeSource = readFileSync(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)), "utf8");

test("the shared app prompt attaches the Step operating contract", () => {
	// The identity alone was the old bug: it arrived without the contract.
	assert.equal(STEP_APP_SYSTEM_PROMPT_PRODUCT.promptAppendix, buildStepSystemPromptAppendix);
	assert.equal(Object.isFrozen(STEP_APP_SYSTEM_PROMPT_PRODUCT), true);
	assert.match(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction ?? "", /^You are StepCode, a coding agent/u);
	assert.doesNotMatch(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction ?? "", /StepCode Web|terminal/iu);
	const contract = buildStepSystemPromptAppendix(["read_file", "write_file", "edit_file", "run_command", "subagent"]);
	assert.match(contract, /# StepCode operating contract/u);
	assert.match(contract, /Operating mode: all-tools/u);
	assert.match(contract, /# Delegation/u);
});

test("the host passes the shared app prompt instead of assembling one", () => {
	// Whitespace-insensitive: a formatter reflow must not break this guard.
	const normalized = runtimeSource.replace(/\s+/gu, " ");
	assert.ok(normalized.includes("createAgentSessionFromServices("));
	// Every session-creation call must carry the shared product; a second call site
	// without it would fall back to the builder's default identity, and an inline
	// object here is the regression that dropped the contract.
	assert.equal(normalized.match(/systemPromptProduct:/gu)?.length, 1);
	assert.equal(
		normalized.match(/createAgentSessionFromServices\(/gu)?.length,
		1,
		"a second session-creation call site needs its own systemPromptProduct assertion",
	);
	assert.match(normalized, /systemPromptProduct: STEP_APP_SYSTEM_PROMPT_PRODUCT,/u);
	assert.doesNotMatch(normalized, /systemPromptProduct: \{/u);
});

test("the host mounts the Step tool profile, so tool names match the prompt and plan mode", () => {
	// The prompt, the plan extension and the CLI all name Step's tools
	// (`read_file`, `write_file`, `run_command`). Without the profile the host ran
	// Pi's builtins instead, so plan mode activated tools that did not exist and a
	// proposal could not be written at all ("Tool write_file not found").
	const normalized = runtimeSource.replace(/\s+/gu, " ");
	assert.match(normalized, /createStepToolProfile\(options\.cwd,/u);
	assert.match(normalized, /customTools: profileTools, noTools: "builtin"/u);
	assert.equal(
		normalized.match(/createStepToolProfile\(/gu)?.length,
		1,
		"a second session-creation path needs the profile too",
	);
});
