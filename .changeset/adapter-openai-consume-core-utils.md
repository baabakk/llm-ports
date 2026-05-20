---
"@llm-ports/adapter-openai": patch
---

Non-functional refactor: consumes shared utilities from `@llm-ports/core` instead of maintaining local duplicates.

- `wrapError` → `wrapProviderError` (from core)
- `stringifyPrompt` → `stringifyContentBlocks` (from core)
- `mergeUsage` → `mergeTokenUsage` (from core)
- `extractJSON` and `tryParsePartialJSON` (from core; the streaming partial-parse now uses a proper bracket stack)
- Local `emitRetry` is now a thin wrapper around `emitRetryEvent` (from core)
- `capabilities.ts` now consumes `createCapabilityLearner` from core; OpenAI-specific error classifiers remain.

Public API unchanged. No behavior change for users; all 95 adapter-openai tests pass identically.
