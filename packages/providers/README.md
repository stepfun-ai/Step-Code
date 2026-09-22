# @step-harness/providers

Unified LLM API with provider collections, automatic auth resolution, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note**: This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Table of Contents

- [Supported Providers](#supported-providers)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Providers and Models](#providers-and-models)
  - [Registering Providers](#registering-providers)
  - [Querying Models](#querying-models)
  - [Static Catalog Reads](#static-catalog-reads)
  - [Dynamic Providers](#dynamic-providers)
- [Auth](#auth)
  - [How Auth Resolves](#how-auth-resolves)
  - [Transforming Request Headers](#transforming-request-headers)
  - [Credential Store](#credential-store)
  - [Environment Variables](#environment-variables)
- [Tools](#tools)
  - [Defining Tools](#defining-tools)
  - [Handling Tool Calls](#handling-tool-calls)
  - [Streaming Tool Calls with Partial JSON](#streaming-tool-calls-with-partial-json)
  - [Validating Tool Arguments](#validating-tool-arguments)
  - [Complete Event Reference](#complete-event-reference)
- [Image Input](#image-input)
- [Thinking/Reasoning](#thinkingreasoning)
  - [Unified Interface](#unified-interface-streamsimplecompletesimple)
  - [Provider-Specific Options](#provider-specific-options-streamcomplete)
  - [Streaming Thinking Content](#streaming-thinking-content)
- [Stop Reasons](#stop-reasons)
- [Error Handling](#error-handling)
  - [Aborting Requests](#aborting-requests)
  - [Continuing After Abort](#continuing-after-abort)
  - [Debugging Provider Payloads](#debugging-provider-payloads)
- [Custom Providers](#custom-providers)
  - [createProvider()](#createprovider)
  - [Calling API Implementations Directly](#calling-api-implementations-directly)
  - [OpenAI Compatibility Settings](#openai-compatibility-settings)
- [Faux Provider for Tests](#faux-provider-for-tests)
- [Cross-Provider Handoffs](#cross-provider-handoffs)
- [Context Serialization](#context-serialization)
- [Browser Usage](#browser-usage)
- [Bundling and Tree Shaking](#bundling-and-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [Programmatic OAuth](#programmatic-oauth)
- [Migrating from the Old Global API](#migrating-from-the-old-global-api)
- [Development](#development)
- [License](#license)

## Supported Providers

This build ships **no built-in provider catalog**: `builtinProviders()` returns
`[]` and the generated model catalog is empty. The package provides the wire
protocols and request dialects; concrete providers and models are configured at
runtime.

Wire protocols (implemented in `src/api/`):

- **`openai-completions`** — OpenAI Chat Completions API
- **`openai-responses`** — OpenAI Responses API
- **`anthropic-messages`** — Anthropic Messages API

Request dialects layered over `openai-completions` for vendor-specific quirks:
DeepSeek, ZAI, Qwen, Kimi, OpenRouter, Ant Ling, and OpenCode.

Configure providers and models at runtime against any OpenAI- or
Anthropic-compatible endpoint on those protocols:

- Declare custom providers in `~/.pi/agent/models.json`.
- Fetch a live catalog from a provider's `/v1/models` endpoint (for example the
  Step provider registered by the product).
- Build a provider from parts with `createProvider()` (see [Custom Providers](#custom-providers)).

## Installation

```bash
npm install @step-harness/providers
```

TypeBox exports are re-exported from `@step-harness/providers`: `Type`, `Static`, and `TSchema`.

## Quick Start

You build a `Models` collection of providers and stream through it. This build ships no built-in provider catalog, so you register a provider you declare yourself (see [createProvider()](#createprovider)) against any OpenAI/Anthropic-compatible endpoint.

```typescript
import { Type, type Context, type Model, type Tool, createModels, createProvider, envApiKeyAuth } from '@step-harness/providers';
import { openAICompletionsApi } from '@step-harness/providers/api/openai-completions.lazy';

// Declare a model against any OpenAI-compatible endpoint (Step shown here).
const model: Model<'openai-completions'> = {
  id: 'step-2',
  name: 'Step 2',
  api: 'openai-completions',
  provider: 'step',
  baseUrl: 'https://api.stepfun.com/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

// Register it on a collection; auth resolves STEP_API_KEY from the environment.
const models = createModels();
models.setProvider(createProvider({
  id: 'step',
  name: 'Step',
  baseUrl: 'https://api.stepfun.com/v1',
  auth: { apiKey: envApiKeyAuth('Step API key', ['STEP_API_KEY']) },
  models: [model],
  api: openAICompletionsApi(),
}));

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (STEP_API_KEY from the environment here).
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

Snippets in the rest of this README assume a `models` collection set up like this. Since no catalog ships built-in, the specific provider and model ids in later examples (e.g. `getModel('anthropic', 'claude-sonnet-4-6')`) are illustrative — they resolve only if you have registered a provider under that id with `createProvider()`.

## Providers and Models

A **provider** is the runtime unit: it owns its model catalog, its auth (API key resolution, OAuth flows), and its stream behavior. A `Models` collection holds providers and routes every request to the provider that owns the model.

Providers internally share **API implementations** (the wire protocols): Anthropic models use `anthropic-messages`, OpenAI uses `openai-responses`, while xAI, Groq, Cerebras, OpenRouter, and most others share `openai-completions`. Mixed-API providers (GitHub Copilot, OpenCode Zen) dispatch per model.

### Registering Providers

This build ships no built-in provider factories. Register providers you declare with [`createProvider()`](#createprovider) — a local inference server, a proxy, or any OpenAI/Anthropic-compatible endpoint — then add them to a collection:

```typescript
const models = createModels();
models.setProvider(createProvider({ /* id, baseUrl, auth, models, api */ }));
```

See [Custom Providers](#custom-providers) for the full `createProvider()` reference, and [Bundling and Tree Shaking](#bundling-and-tree-shaking) for keeping only the wire-protocol implementations you use. With bundler code splitting, SDK implementations (`@anthropic-ai/sdk`, `openai`) stay in lazy chunks loaded on the first request to a model of that API.

### Querying Models

Reads are synchronous and return the last-known lists:

```typescript
const providers = models.getProviders();       // registered Provider objects
const provider = models.getProvider('step');    // one provider

const all = models.getModels();                 // every model across providers
const stepModels = models.getModels('step');
const model = models.getModel('step', 'step-2');

for (const m of stepModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

Dynamically listed models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

```typescript
import { hasApi } from '@step-harness/providers';

// A model from a custom Anthropic-compatible provider you registered.
const m = models.getModel('my-anthropic', 'claude-sonnet-4-6');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream options fully typed
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

This build ships no generated built-in catalog, so `getBuiltinModel()` / `getBuiltinModels()` / `getBuiltinProviders()` from `@step-harness/providers/providers/all` resolve against an empty set. Read models from a collection after registering providers (see [Querying Models](#querying-models)).

### Dynamic Providers

Providers may have dynamic model lists (a llama.cpp server, a live OpenRouter listing). Reads stay sync; fetching is an explicit async verb:

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ['llamacpp'] }); // refresh one provider
await models.refresh();                            // refresh all providers concurrently, best-effort
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

Static built-in providers are no-ops for `refresh()`. See [createProvider()](#createprovider) for building a dynamic provider.

## Auth

Every provider owns its auth: how API keys resolve (stored credentials, environment variables, ambient sources like AWS profiles or gcloud ADC) and, where supported, OAuth login/refresh flows.

### How Auth Resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
} else {
  console.log('not configured');
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when something is actually broken (`"oauth"`: token refresh failed, credential preserved for re-login; `"auth"`: key resolution or credential store failure). Request paths surface the same failures as stream errors.

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

### Transforming Request Headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a Models-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, but before provider dispatch:

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

The ordering is:

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names are merged case-insensitively. Explicit headers override auth/model headers, and the transform has final control; returning `null` for a header suppresses lower-level defaults that support deletion.

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation must consume it and remove it before calling `Provider.stream*()`. Provider implementations continue receiving ordinary `ApiStreamOptions` or `SimpleStreamOptions` and never handle the transform themselves. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve request auth twice.

### Credential Store

Stored credentials (API keys entered interactively, OAuth tokens) live in a `CredentialStore` — one type-tagged credential per provider. pi-ai ships an in-memory default; apps inject persistent storage:

```typescript
import { createModels, type CredentialStore } from '@step-harness/providers';

const models = createModels({ credentials: myFileBackedStore });
```

The contract is small: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` (the only write path — a serialized read-modify-write), and `delete(providerId)`. Each operation accepts optional cancellation options. Enumeration must not resolve secrets or execute configured key commands. OAuth token refresh runs inside `modify`, so concurrent requests and processes cannot double-refresh a rotated token. A stored credential *owns* its provider: environment variables are only consulted when nothing is stored, and a failed refresh never silently falls back to an env key.

API-key credentials use the same discriminator as pi's `auth.json` and can carry provider-scoped env/config values:

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### Environment Variables

A provider registered under one of these ids (with `envApiKeyAuth`) resolves the matching env var (Node.js; in browsers pass `apiKey` explicitly):

| Provider | Environment Variable(s) |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` (e.g. `https://{resource}.ai.azure.com`) or `AZURE_OPENAI_RESOURCE_NAME`. Supports `*.openai.azure.com`, `*.cognitiveservices.azure.com` and `*.ai.azure.com`; root endpoints auto-normalize to `/openai/v1`. Optional: `AZURE_OPENAI_API_VERSION` (default `v1`), `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` or `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`qwen-token-plan-individual` and `qwen-token-plan` share the international endpoint and
`QWEN_TOKEN_PLAN_API_KEY`. The Individual provider exposes only the models documented for Individual
subscriptions, while the existing provider retains its broader catalog for backward compatibility.
Stored credentials remain provider-scoped, so save the key under the provider ID you register.

Amazon Bedrock resolves ambient AWS credentials (`AWS_PROFILE`, access key pairs, `AWS_BEARER_TOKEN_BEDROCK`, ECS task roles, web identity tokens); its provider-owned login flow supports bearer tokens, AWS profiles, and the existing credential chain. Vertex AI resolves either an explicit key or gcloud Application Default Credentials plus project/location, with a provider-owned login flow for API keys, ADC, and service-account files.

## Tools

Tools enable LLMs to interact with external systems. This library uses TypeBox schemas for type-safe tool definitions with automatic validation using TypeBox's built-in validator and value conversion utilities. TypeBox schemas can be serialized and deserialized as plain JSON, making them ideal for distributed systems.

### Defining Tools

```typescript
import { Type, type Tool, StringEnum } from '@step-harness/providers';

// Define tool parameters with TypeBox
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: For Google API compatibility, use StringEnum helper instead of Type.Enum
// Type.Enum generates anyOf/const patterns that Google doesn't support

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### Constrained Sampling for Tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` uses provider-side strict schema enforcement when supported and otherwise falls back to normal tool calling. `strict: 'require'` fails the request when the active provider/model cannot honor it. Set `constrainedSampling: false` to explicitly opt out; it behaves the same as omitting the field.

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

Strict JSON-schema constrained sampling is supported for OpenAI, Anthropic, supported Amazon Bedrock Converse models, Mistral, and Gemini 3 tool calls through the Google Generative AI and Vertex adapters. Google uses `VALIDATED` function-calling mode (or `ANY` when explicitly requested); earlier Gemini versions fall back for `strict: 'prefer'` and reject `strict: 'require'` because they do not enforce required parameters. Bedrock strict-tool capability is generated from model structured-output metadata; custom Bedrock models can override `compat.supportsStrictMode`. OpenAI Responses and Chat Completions can also emit grammar-constrained custom tools with OpenAI Lark or regex grammar variants. If multiple OpenAI variants are supplied, Lark is preferred over regex. Grammar constraints are enforced when the active model supports grammar tools; otherwise the tool falls back to normal function/JSON-schema handling. Grammar tool capability is model metadata: the generated catalog sets `compat.supportsOpenAIGrammarTools` for GPT-5+ models on endpoints that pass OpenAI custom tools through (OpenAI, OpenAI Codex, Azure OpenAI Responses, GitHub Copilot, opencode, and Cloudflare AI Gateway). OpenAI rejects `type: "custom"` tools for pre-GPT-5 models, and gateways that normalize tool schemas (e.g. OpenRouter) mangle them, so the flag stays off elsewhere. Custom model definitions can opt in via `compat`. Grammar-capable models reject grammar configurations without a non-empty supported variant. Native grammar tools must have an object parameter schema with exactly one required string property:

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### Handling Tool Calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**
- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON
- Fields may be missing or incomplete - always check for existence before use
- String values may be truncated mid-word
- Arrays may be incomplete
- Nested objects may be partially populated
- At minimum, `arguments` will be an empty object `{}`, never `undefined`
- The Google provider does not support function call streaming. Instead, you will receive a single `toolcall_delta` event with the full arguments.

### Validating Tool Arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools:

```typescript
import { validateToolCall, type Tool } from '@step-harness/providers';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### Complete Event Reference

All streaming events emitted during assistant message generation:

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | Stream begins | `partial`: Initial assistant message structure |
| `text_start` | Text block starts | `contentIndex`: Position in content array |
| `text_delta` | Text chunk received | `delta`: New text, `contentIndex`: Position |
| `text_end` | Text block complete | `content`: Full text, `contentIndex`: Position |
| `thinking_start` | Thinking block starts | `contentIndex`: Position in content array |
| `thinking_delta` | Thinking chunk received | `delta`: New text, `contentIndex`: Position |
| `thinking_end` | Thinking block complete | `content`: Full thinking, `contentIndex`: Position |
| `toolcall_start` | Tool call begins | `contentIndex`: Position in content array |
| `toolcall_delta` | Tool arguments streaming | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args |
| `toolcall_end` | Tool call complete | `toolCall`: Complete validated tool call with `id`, `name`, `arguments` |
| `done` | Stream complete | `reason`: Stop reason ("stop", "length", "toolUse"), `message`: Final assistant message |
| `error` | Error occurred | `reason`: Error type ("error" or "aborted"), `error`: AssistantMessage with partial content |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and pi may surface corresponding events interleaved, for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`. Consumers must use `contentIndex` to associate each delta/end event with its block and must not assume that a block's `*_start`/`*_delta`/`*_end` sequence is uninterrupted by events for other blocks.

## Image Input

Models with vision capabilities can process images. You can check if a model supports images via the `input` property. If you pass images to a non-vision model, they are silently ignored.

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## Thinking/Reasoning

Many models support thinking/reasoning capabilities where they can show their internal thought process. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

### Unified Interface (streamSimple/completeSimple)

```typescript
// Many models across providers support thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('xai', 'grok-4.6');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` and `max` are model-specific, opt-in levels. Use `getSupportedThinkingLevels(model)` to determine whether a concrete model exposes either level; models such as GPT-5.6 can expose both.

### Provider-Specific Options (stream/complete)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

```typescript
import { hasApi } from '@step-harness/providers';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // OpenAI Responses API only
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // Optional token limit
  });
}
```

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

- `"pending"` - Only present in partial messages when we do not know what the stop reason will be
- `"stop"` - This is the final message the model will produce this turn
- `"length"` - Output hit the maximum token limit
- `"toolUse"` - Model is calling tools and expects tool results
- `"error"` - An error occurred during generation
- `"aborted"` - Request was cancelled via abort signal

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.

## Error Handling

Request failures never throw out of the stream functions: when a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event and the final message carries the details:

```typescript
// In streaming
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

Auth failures (no key configured, OAuth refresh failed, unknown provider) surface the same way: as a stream error with `stopReason: "error"`.

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

## Custom Providers

### createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and an API implementation. Use it for local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@step-harness/providers';
import { openAICompletionsApi } from '@step-harness/providers/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from '@step-harness/providers/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@step-harness/providers/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. The Cloudflare providers do this to materialize account/gateway endpoint placeholders from the resolved provider env:

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic model lists use `fetchModels`. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

Use `models.refresh({ providers: ['openrouter'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI Compatibility Settings](#openai-compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### Calling API Implementations Directly

The API implementations are importable on their own. Each module exports exactly `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth — pass `apiKey` explicitly:

```typescript
import { stream } from '@step-harness/providers/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./mistral`, `./openai-completions`, ...) were removed; use `@step-harness/providers/api/<api-id>`.

### OpenAI Compatibility Settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together AI, zAi, OpenCode, Cloudflare Workers AI, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: true)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: false)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Format for session affinity: 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity`; 'openrouter' uses `x-session-id` (default: auto-detected)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: max_completion_tokens)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // Format for reasoning param: 'openai' uses reasoning_effort, 'openrouter' uses reasoning: { effort }, 'deepseek' uses thinking: { type } plus reasoning_effort when supported, 'together' uses reasoning: { enabled } plus reasoning_effort when supported, 'baseten' uses configurable chat_template_args plus reasoning_effort when supported, 'zai' uses thinking: { type }, 'qwen' uses enable_thinking, 'chat-template' uses configurable chat_template_kwargs, 'qwen-chat-template' uses chat_template_kwargs.enable_thinking and preserve_thinking, 'string-thinking' uses top-level thinking, 'ant-ling' uses reasoning: { effort } only for mapped efforts (default: openai)
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values; use $var for pi-controlled thinking values
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_args values for thinkingFormat: 'baseten'; use $var for pi-controlled thinking values
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format: 'openai' sends `session_id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`; 'openrouter' sends `x-session-id`. Does not affect the `prompt_cache_key` body param (default: auto-detected)
  supportsLongCacheRetention?: boolean; // Whether provider supports `prompt_cache_retention: "24h"` (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for built-in OpenAI models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
}
```

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

## Faux Provider for Tests

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@step-harness/providers';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:
- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids.

## Cross-Provider Handoffs

The library supports seamless handoffs between different LLM providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including thinking blocks, tool calls, and tool results.

When messages from one provider are sent to a different provider, the library automatically transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider/API** are preserved as-is
- **Assistant messages from different providers** have their thinking blocks converted to text with `<thinking>` tags
- **Tool calls and regular text** are preserved unchanged

```typescript
import { createModels, createProvider, envApiKeyAuth, type Context, type Model } from '@step-harness/providers';
import { anthropicMessagesApi } from '@step-harness/providers/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@step-harness/providers/api/openai-responses.lazy';

// Two custom providers on different wire protocols.
const claude: Model<'anthropic-messages'> = {
  id: 'claude', name: 'Claude', api: 'anthropic-messages', provider: 'my-anthropic',
  baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000,
};
const gpt5: Model<'openai-responses'> = {
  id: 'gpt-5-mini', name: 'GPT-5 mini', api: 'openai-responses', provider: 'my-openai',
  baseUrl: 'https://api.openai.com/v1', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 128000,
};

const models = createModels();
models.setProvider(createProvider({ id: 'my-anthropic', auth: { apiKey: envApiKeyAuth('Anthropic key', ['ANTHROPIC_API_KEY']) }, models: [claude], api: anthropicMessagesApi() }));
models.setProvider(createProvider({ id: 'my-openai', auth: { apiKey: envApiKeyAuth('OpenAI key', ['OPENAI_API_KEY']) }, models: [gpt5], api: openAIResponsesApi() }));

const context: Context = { messages: [] };

// Start with Claude
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// Switch to GPT-5 — it will see Claude's thinking as <thinking> tagged text
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));
```

All providers can handle messages from other providers — text, tool calls and results (including images), thinking blocks (transformed to tagged text), and aborted messages with partial content. This enables flexible workflows: start with a fast model, switch to a more capable one for complex reasoning, or maintain continuity across provider outages.

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data too — no functions or implementations attached — so persisting "which model was this conversation using" is a `JSON.stringify` away.

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.

## Browser Usage

The library supports browser environments. The core entrypoint and providers you build with `createProvider()` are side-effect free and bundle cleanly. Environment variables are not available in browsers, so pass API keys explicitly — or inject a `CredentialStore` (e.g. localStorage-backed) and let provider auth resolve from stored credentials:

```typescript
import { createModels, createProvider, type Model } from '@step-harness/providers';
import { openAICompletionsApi } from '@step-harness/providers/api/openai-completions.lazy';

const model: Model<'openai-completions'> = {
  id: 'step-2', name: 'Step 2', api: 'openai-completions', provider: 'step',
  baseUrl: 'https://api.stepfun.com/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
};
const models = createModels();
models.setProvider(createProvider({
  id: 'step', baseUrl: model.baseUrl,
  auth: { apiKey: { name: 'Step', resolve: async () => ({ auth: {} }) } },
  models: [model], api: openAICompletionsApi(),
}));

const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

Browser compatibility notes:

- OAuth login flows are Node-only. They are lazy-loaded behind bundler-opaque imports, so registering an OAuth-capable provider does not pull Node-only code into a browser bundle — only actually logging in would.
- Use a server-side proxy or backend service if you need OAuth-based auth from a web app.

## Bundling and Tree Shaking

For small bundles, register only the providers you need and import only the wire-protocol implementations they use:

```typescript
import { createModels, createProvider, envApiKeyAuth } from '@step-harness/providers';
import { openAICompletionsApi } from '@step-harness/providers/api/openai-completions.lazy';

const models = createModels();
models.setProvider(createProvider({
  id: 'my-openai',
  auth: { apiKey: envApiKeyAuth('OpenAI key', ['OPENAI_API_KEY']) },
  models: [/* your Model<'openai-completions'> list */],
  api: openAICompletionsApi(),
}));
```

Rules:

- `@step-harness/providers` is the core entrypoint and does not import built-in catalogs, provider factories, or SDK implementations.
- This build has no per-provider factory subpaths and no built-in catalog; `@step-harness/providers/providers/all` re-exports only the (now empty) `builtinModels()` / `builtinProviders()` / `getBuiltin*` helpers and imports no catalogs or SDKs.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- A bundle pulls in the SDK of each wire-protocol implementation you import (`@step-harness/providers/api/openai-completions.lazy` → `openai`, `@step-harness/providers/api/anthropic-messages.lazy` → `@anthropic-ai/sdk`). Without code splitting these fold into the single bundle.
- Importing `@step-harness/providers/api/<api-id>` directly loads that API implementation and its SDK immediately.

Avoid `@step-harness/providers/compat` in new bundled apps; it preserves the old global API.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser or Cloudflare Workers workaround.

### Provider-Scoped Environment Overrides

Pass `env` in stream options to scope provider configuration to a request. Values in `env` are used before process environment variables for provider auth and configuration such as API keys, gateway/account settings, and `HTTP_PROXY`/`HTTPS_PROXY`.

```typescript
// `models` and `model` from Quick Start.
const response = await models.complete(model, context, {
  env: {
    STEP_API_KEY: '...',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
  }
});
```

Use this when one process needs different provider settings per request, or when ambient environment variables should not leak into a provider call.

## OAuth Providers

No OAuth provider ships built-in. A provider you register with `createProvider()` may carry an `OAuthAuth` on `provider.auth.oauth` with three operations: `login(interaction)` uses the provider-neutral `AuthInteraction.prompt()`/`notify()` protocol and returns a credential, `refresh(credential, signal)` refreshes expiring credentials when applicable, and `toAuth(credential)` derives request auth. Login interactions and refresh calls always carry a concrete abort signal. Refresh is automatic: `models.getAuth(providerId)` and request paths refresh expired tokens under a credential-store lock, so concurrent requests and processes cannot double-refresh.

`Models` drives the flow and persists the credential:

```typescript
const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(myOAuthProvider); // a createProvider() provider whose auth.oauth is set

// Login: Models drives the flow and persists the credential
await models.login('my-provider', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code prompts race a local callback server; p.signal aborts them when the server wins
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModel('my-provider', 'my-model')!;
await models.complete(model, context);

// Logout
await models.logout('my-provider');
```

### Programmatic OAuth

The `@step-harness/providers/oauth` entry point retains only the type declarations required by coding-agent extension OAuth compatibility; it no longer ships any built-in login flow. Provide login/refresh through a custom provider's `OAuthAuth`, which composes with `CredentialStore` and gets locked auto-refresh through `Models`.

## Migrating from the Old Global API

Older versions exposed a global API: `stream()`/`complete()` dispatching on `model.api` via a global registry, sync `getModel()`/`getModels()`/`getProviders()` catalog reads, `registerApiProvider()`, `getEnvApiKey()`, and per-API lazy stream functions. That surface lives unchanged on the **compat entrypoint**:

```typescript
// Before
import { getModel, complete } from '@step-harness/providers';

// After (verbatim behavior, one import-path change)
import { getModel, complete } from '@step-harness/providers/compat';
```

Compat is a strict superset of the root entrypoint, so a file can switch its import path wholesale. It will be removed in a future release; migrate to `createModels()` + `createProvider()`:

| Old | New |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` (against a registered provider) |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` |
| `stream(model, ctx, opts)` (env-key injection) | `models.stream(model, ctx, opts)` (provider auth resolution) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | `stream` from `@step-harness/providers/api/anthropic-messages`, or a provider in a collection |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## Development

### Adding a New Provider

> The Step-only build ships no built-in providers; the supported way to add one is [`createProvider()`](#createprovider) / a `~/.pi/agent/models.json` entry, no package changes required.

Adding a new LLM provider requires changes across multiple files. The layered layout: API implementations live in `src/api/`, provider factories in `src/providers/`, stable generated catalog wrappers live in `src/providers/<id>.models.ts`, and `src/models.generated.ts` registers them. This checklist covers all necessary steps:

#### 1. Core Types (`src/types.ts`)

- Add the API identifier to `KnownApi` (for example `"bedrock-converse-stream"`), if it is a new API
- Add the provider name to `KnownProvider` (for example `"amazon-bedrock"`)
- Add the options type to `ApiOptionsMap`

#### 2. API Implementation (`src/api/<api-id>.ts`, only for a new API)

Create a new API implementation file (for example `bedrock-converse-stream.ts`) that exports exactly `stream` and `streamSimple`, plus:

- An options interface extending `StreamOptions` (for example `BedrockOptions`)
- Message conversion functions to transform `Context` to provider format
- Tool conversion if the provider supports tools
- Response parsing to emit standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

Add a lazy wrapper `src/api/<api-id>.lazy.ts` (`<name>Api()` via `lazyApi()`) so providers can reference the implementation without importing its SDK. Add any root-level `export type` re-exports in `src/index.ts` that should remain available from `@step-harness/providers`.

#### 3. Model Generation (`scripts/generate-models.ts`)

- Add logic to fetch and parse models from the provider's source (e.g., models.dev API)
- Map chat/tool-capable provider model data to the standardized `Model` interface via `scripts/generate-models.ts`; hydration groups the ignored `src/providers/data/<id>.json` values by API, while stable `src/providers/<id>.models.ts` wrappers derive exact model/API types directly from those JSON keys
- Handle provider-specific quirks (pricing format, capability flags, model ID transformations)

#### 4. Provider Factory (`src/providers/<id>.ts`)

- `createProvider()` wiring catalog + auth + the lazy API wrapper
- Auth: `envApiKeyAuth` for standard key providers, a custom `ApiKeyAuth` for ambient auth (AWS profiles, ADC), `lazyOAuth` where an OAuth flow exists
- Register the factory in `src/providers/all.ts`
- If it is a new API: register it in the builtin list in `src/compat.ts` and add the package subpath export in `package.json`

#### 5. Tests (`test/`)

Create or update test files to cover the new provider:

- `stream.test.ts` - Basic streaming and tool use
- `tokens.test.ts` - Token usage reporting
- `abort.test.ts` - Request cancellation
- `empty.test.ts` - Empty message handling
- `context-overflow.test.ts` - Context limit errors
- `image-limits.test.ts` - Image support (if applicable)
- `unicode-surrogate.test.ts` - Unicode handling
- `tool-call-without-result.test.ts` - Orphaned tool calls
- `image-tool-result.test.ts` - Images in tool results
- `total-tokens.test.ts` - Token counting accuracy
- `cross-provider-handoff.test.ts` - Cross-provider context replay
- `providers.test.ts` - Provider listing and auth resolution

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

For providers with non-standard auth (AWS, Google Vertex), create a utility like `bedrock-utils.ts` with credential detection helpers.

#### 6. Coding Agent Integration (`../coding-agent/`)

Update `src/core/model-resolver.ts`:

- Add a default model ID for the provider in `DEFAULT_MODELS`

Update `src/cli/args.ts`:

- Add environment variable documentation in the help text

Update `README.md`:

- Add the provider to the providers section with setup instructions

#### 7. Documentation

Update `packages/providers/README.md`:

- Add to the Supported Providers table
- Document any provider-specific options or authentication requirements
- Add environment variable to the Environment Variables section

#### 8. Changelog

Add an entry to `packages/providers/CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## License

MIT
