/**
 * Test totalTokens field across all providers.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI Completions: Uses native total_tokens field
 * - OpenAI Responses: Uses native total_tokens field
 * - Google: Uses native totalTokenCount field
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - Other OpenAI-compatible providers: Uses native total_tokens field
 */

import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions, Usage } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
const anthropicOAuthToken = await resolveApiKey("anthropic");

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

describe("totalTokens field", () => {
	// =========================================================================
	// Anthropic
	// =========================================================================

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (API Key)", () => {
		it(
			"claude-sonnet-4-5 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("anthropic", "claude-sonnet-4-5");

				console.log(`\nAnthropic / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.ANTHROPIC_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	describe("Anthropic (OAuth)", () => {
		it.skipIf(!anthropicOAuthToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("anthropic", "claude-sonnet-4-6");

				console.log(`\nAnthropic OAuth / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: anthropicOAuthToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	// =========================================================================
	// OpenAI
	// =========================================================================

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions", () => {
		it(
			"gpt-4o-mini - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
				void _compat;
				const llm: Model<"openai-completions"> = {
					...baseModel,
					api: "openai-completions",
				};

				console.log(`\nOpenAI Completions / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses", () => {
		it(
			"claude-haiku-4.5 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openai", "gpt-4o");

				console.log(`\nOpenAI Responses / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Google
	// =========================================================================

	// =========================================================================
	// xAI
	// =========================================================================

	// =========================================================================
	// Groq
	// =========================================================================

	// =========================================================================
	// Cerebras
	// =========================================================================

	// =========================================================================
	// Cloudflare Workers AI
	// =========================================================================

	// =========================================================================
	// Cloudflare AI Gateway
	// =========================================================================

	// =========================================================================
	// Hugging Face
	// =========================================================================

	// =========================================================================
	// Together AI
	// =========================================================================

	// =========================================================================
	// Baseten
	// =========================================================================

	// =========================================================================
	// z.ai
	// =========================================================================

	// =========================================================================
	// Mistral
	// =========================================================================

	// =========================================================================
	// MiniMax
	// =========================================================================

	// =========================================================================
	// Xiaomi MiMo
	// =========================================================================

	// =========================================================================
	// Xiaomi MiMo Token Plan CN
	// =========================================================================

	// =========================================================================
	// Xiaomi MiMo Token Plan AMS
	// =========================================================================

	// =========================================================================
	// Xiaomi MiMo Token Plan SGP
	// =========================================================================

	// =========================================================================
	// Qwen Token Plan
	// =========================================================================

	// =========================================================================
	// Qwen Token Plan Individual
	// =========================================================================

	// =========================================================================
	// Qwen Token Plan CN
	// =========================================================================

	// =========================================================================
	// Kimi For Coding
	// =========================================================================

	// =========================================================================
	// Vercel AI Gateway
	// =========================================================================

	// =========================================================================
	// OpenRouter - Multiple backend providers
	// =========================================================================

	// =========================================================================
	// GitHub Copilot (OAuth)
	// =========================================================================

	// =========================================================================
	// =========================================================================

	// =========================================================================
	// =========================================================================

	// =========================================================================
	// OpenAI Codex (OAuth)
	// =========================================================================
});
