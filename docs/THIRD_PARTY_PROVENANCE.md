# Third-party provenance

This file records the review boundary for source and example material that mentions
an external model vendor or imports an external package.

| Material | Decision | Provenance / license | Review owner |
| --- | --- | --- | --- |
| `packages/coding-agent/examples/extensions/sandbox/` | Retained | The example is project-authored glue code. Its declared `@anthropic-ai/sandbox-runtime` dependency is Apache-2.0 as recorded in the checked-in lockfile; the dependency remains external and is not copied into this repository. | Step Harness maintainers |
| Provider protocol and compatibility documentation under `packages/coding-agent/docs/` | Retained | Project-authored API documentation describing public protocol contracts. It contains no vendor system prompts, hidden tool schemas, OAuth client credentials, or copied session data. | Step Harness maintainers |
| `packages/coding-agent/examples/extensions/subagent/` | Retained | Project-authored generic workflow examples. The bundled prompts contain no vendor-specific system prompt, hidden tool schema, credential, or evaluation sample; model selection inherits the public Step model. | Step Harness maintainers |
| Vendor-specific custom provider and rules examples formerly under `packages/coding-agent/examples/extensions/custom-provider-*` and `claude-rules.ts` | Removed | Source, OAuth/client configuration, and compatibility behavior could not be independently proven to be distributable. | Step Harness maintainers |

Any new vendor adapter or example must add a row here with a verifiable upstream
license and an owner before it is included in a source or binary archive.
