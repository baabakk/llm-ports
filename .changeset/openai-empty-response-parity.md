---
"@llm-ports/adapter-openai": patch
---

`generateStructured` now throws the typed `EmptyResponseError` (from `@llm-ports/core`, added in alpha.1) when the response text is empty after `executeChatRequest`'s built-in reasoning-starvation retry has fired. Previously the adapter would fall through to `JSON.parse("")` and raise `SyntaxError`, which got wrapped as a generic `ProviderUnavailableError` and prevented the registry from making intelligent fallback decisions (couldn't tell "provider broken" from "this model can't fit the schema in the budget"). Mirrors `@llm-ports/adapter-vercel`'s behavior shipped in alpha.1. The thrown `EmptyResponseError` carries `alias` and `modelId` so the registry can route to a fallback model. `wrapError()` is also updated to not double-wrap the new error.
