---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-ollama": minor
"@llm-ports/adapter-vercel": minor
---

Image-block boundary validation (closes issues #19, #20, #21 from the image-pipeline audit).

**New errors** in `@llm-ports/core`:

- `ImageTooLargeError(alias, imageIndex, byteSize, limitBytes)` — base64 image exceeds the provider's per-image byte limit
- `InvalidImageUrlError(alias, url, reason)` — URL-form image with `file://`, `data:`, missing scheme, or other bad shape

**New helpers** in `@llm-ports/core`:

- `validateImageBlocks(blocks, opts)` — call at the adapter boundary on every outgoing `ContentBlock[]`
- `validateImageUrl(url, alias, allowFileUrl)` — standalone URL-shape check

**Per-adapter boundary checks** wired in every port method (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) with adapter-specific defaults:

| Adapter | Default `imageSizeLimitBytes` | Source |
|---|---|---|
| `adapter-anthropic` | 5 MB | Anthropic's documented per-image limit |
| `adapter-openai` | 20 MB | OpenAI's documented per-image limit |
| `adapter-ollama` | unset (model-dependent) | Ollama itself doesn't enforce |
| `adapter-vercel` | 20 MB | Matches the underlying SDK's image path |
| `adapter-google` | 20 MB (new package) | Gemini's documented inline limit |

**Assistant `image_url` decoding** in `adapter-openai`: `fromOpenAIAssistantMessage` now decodes any `image_url` content part in an assistant response back to an `ImageBlock` (data URI → base64, http(s) → URL). Previously these were silently dropped (commented "very rare"). Zero models emit this today, but future-proofs the round-trip.

17 new tests in `@llm-ports/core` + 3 new tests in `@llm-ports/adapter-openai`.
