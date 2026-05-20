---
"@llm-ports/adapter-vercel": patch
---

Non-functional refactor: consumes shared utilities from `@llm-ports/core` instead of local duplicates.

- `wrapError` → `wrapProviderError` (from core)
- `stringifyPrompt` → `stringifyContentBlocks` (from core)
- `extractJSON` and `tryParsePartialJSON` (from core)
- Local `emitRetry` is now a thin wrapper around `emitRetryEvent` (from core)

Public API unchanged. All 19 adapter-vercel tests pass identically.
