---
"@llm-ports/core": patch
---

**`onComplete` now fires for every operation, which is what `alpha.35` said it did.**

As shipped in `0.1.0-alpha.35` the hook was emitted from `generateText` and `generateChat` only, while its event type's `operation` field named nine operations. A consumer adopting it as their single per-call spend event, which is what it was built and documented for, silently lost every streamed and structured call from their totals. Reported by a consumer who checked before adopting rather than after.

It now fires once per call from `generateText`, `generateStructured`, `generateChat`, `runAgent`, `streamText`, `streamStructured` and `streamChat`, on success and on failure.

**What "once per call" means for a stream**, since a stream has no single completion instant. The event fires when the stream is exhausted, and on the failure side it fires for an abort or an error whether that happens before the first chunk or midway through after chunks were already delivered. Usage and cost carry whatever accumulated before the failure, absent rather than zero when nothing did.

This is deliberately different from `onStreamComplete`, which fires only on natural completion and stays that way. `onComplete` promises the failure case, and the failure case is the reason to switch it on.

**If you already adopted it in `alpha.35`**, your streamed and structured calls were missing and will now appear. Expect totals to rise rather than change shape.

No API change, no configuration change. `embed` and `rerank` remain in the type for consumers emitting the event themselves; the LLM port does not route them.

From `TD-LLMPORTS-ONCOMPLETE-FIRES-FOR-TWO-OF-NINE-OPERATIONS`.
