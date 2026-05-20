---
"@llm-ports/adapter-ollama": patch
---

Non-functional refactor: consumes shared utilities from `@llm-ports/core` instead of local duplicates.

- `wrapError` → `wrapProviderError` (from core)
- `stringifyPrompt` → `stringifyContentBlocks` (from core)
- `mergeUsage` → `mergeTokenUsage` (from core)
- `extractJSON` and `tryParsePartialJSON` (from core)

`onRetry` plumbing parity remains a follow-up (no retry sites today). Public API unchanged. All 30 adapter-ollama tests pass identically.
