---
"@llm-ports/core": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-vercel": minor
"@llm-ports/adapter-ollama": minor
---

Add `signal?: AbortSignal` to all 5 `*Options` interfaces (closes [#24](https://github.com/baabakk/llm-ports/issues/24)).

Previously the only abort mechanism was a consumer-side `Promise.race` against a timeout, which stops awaiting the promise but doesn't actually cancel the in-flight HTTP request — the LLM call keeps running and bills tokens. With `signal` threaded through to the provider SDK, `controller.abort()` now cancels the in-flight fetch.

```ts
const controller = new AbortController();
const promise = llm.generateText({
  taskType: "screen_analyze",
  prompt: [...],
  signal: controller.signal,
});
// User clicks cancel:
controller.abort();
// promise rejects with signal.reason; the HTTP request to the provider is cancelled.
```

**Per-adapter behavior (declared via contract suite's new `signalSupport` flag):**

| Adapter | `signalSupport` | What it does |
|---|---|---|
| `@llm-ports/adapter-openai` | `"entry+inflight"` | Entry-time check + signal threaded as 2nd-arg request options on `client.chat.completions.create` |
| `@llm-ports/adapter-anthropic` | `"entry+inflight"` | Entry-time check + signal threaded into `client.messages.create` (non-streaming) AND `client.messages.stream` |
| `@llm-ports/adapter-google` | `"entry+inflight"` | Entry-time check + signal threaded into `client.models.generateContent` config |
| `@llm-ports/adapter-vercel` | `"entry+inflight"` | Entry-time check + Vercel's `abortSignal` field on `generateText` / `streamText` |
| `@llm-ports/adapter-ollama` | `"entry-only"` | Entry-time check only. ollama-js SDK doesn't expose a per-call signal yet — only a coarse `client.abort()` that cancels all in-flight requests on the client. Tracking upstream for v0.7+ |

**New core export:** `throwIfAborted(signal)` helper. Honors `signal.reason` (modern AbortController convention); falls back to a generic `DOMException("AbortError")`.

**New contract test capability:** `ContractTestContext.signalSupport: "none" | "entry-only" | "entry+inflight"`. Adapters declare their support level; the conformance suite runs entry-time abort tests against `generateText`, `generateStructured`, and `runAgent` for any adapter that declares `"entry-only"` or higher.

**`runAgent` extra:** all 5 adapters' agent loops re-check `throwIfAborted(options.signal)` between steps so cancellation mid-loop propagates (not just at the entry point).

Public API additive only. Existing call sites that omit `signal` are unchanged.

21 new tests (6 unit + 3 contract × 5 adapters).
