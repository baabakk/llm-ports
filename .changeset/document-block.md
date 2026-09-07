---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-vercel": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-ollama": minor
---

Add `DocumentBlock` to the content model, so a PDF can be sent through the port.

`ContentBlock` gains a `document` member carrying `application/pdf`, `text/plain`, `text/markdown` or `text/csv`, from base64 bytes or a URL, with an optional `filename` hint. A separate block rather than a widened `ImageSource`, following the precedent `AudioBlock` set: a PDF is not an image, and providers treat documents as a distinct input kind.

This existed because a consumer could not express a document at all and was importing a provider SDK directly at two call sites to work around it. Their settings panel consequently offered a provider choice that did not govern half their pipeline.

**Adapter support, verified against each SDK's shipped typings.** `adapter-openai` maps base64 to the `file` content part and rejects URL sources, which that part has no shape for. `adapter-google` maps base64 to `inlineData` and URLs to `fileData`. `adapter-vercel` maps both through its generic file part. `adapter-anthropic` rejects documents, because the supported `@anthropic-ai/sdk` range cannot express them. `adapter-ollama` rejects them explicitly rather than dropping them silently, which is what its text-only message builder would otherwise have done.

**TypeScript-strict consumer impact.** Widening `ContentBlock` is additive for anyone constructing content and breaking for anyone consuming it: an exhaustive `switch` over the union that compiled before now fails on the unhandled `"document"` case. Add a case, or a `default`.

**Behaviour change: unsupported content blocks now trigger failover under the default policy.** Previously, a chain whose selected provider could not express a block surfaced `ContentBlockUnsupportedError` to the caller unless the consumer had opted into a broader fallback classifier. It now walks to the next provider. This class is categorically unlike the transient failures the default preset already walked on: it is a static capability mismatch, so the provider will never serve that call, and walking is the only route to an answer rather than a retry in hope. Consumers wanting the previous hard stop can set `runtimeFallback: "none"`.
