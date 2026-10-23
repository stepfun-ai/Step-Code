import assert from "node:assert/strict";
import test from "node:test";
import { formatTokens } from "../client/src/lib/format.ts";

test("token counts switch from K to M instead of showing thousands of K", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(45_900), "45.9K");
	assert.equal(formatTokens(292_000), "292K");
	assert.equal(formatTokens(999_400), "999K");
	assert.equal(formatTokens(999_600), "1.0M");
	assert.equal(formatTokens(118_627_000), "119M");
	assert.equal(formatTokens(7_009_000), "7.0M");
});
