---
"@llm-ports/adapter-google": minor
---

`createGoogleAdapter` now accepts an optional `httpOptions` field that is forwarded verbatim to the underlying `@google/genai` `GoogleGenAI` constructor. Closes [llm-ports#46](https://github.com/baabakk/llm-ports/issues/46) (Q1 from the Dramma backend-proxy plan).

## Motivation

Pre-alpha.22, `GoogleAdapterOptions` exposed only `apiKey`, `pricingOverrides`, `validationStrategy`, `imageSizeLimitBytes`, and `onRetry`. There was no way to redirect Gemini API calls away from the default `https://generativelanguage.googleapis.com/`. That blocks the canonical browser-app pattern of routing cloud LLM calls through a backend proxy that holds the real API key:

```
browser bundle  →  POST https://your-app/api/llm/google/...  →  backend (real GEMINI_API_KEY)  →  Google
```

`@google/genai` itself has supported this via `httpOptions.baseUrl` since at least 2.5.0. The adapter just wasn't forwarding the field.

## What changed

```ts
const adapter = createGoogleAdapter({
  apiKey: process.env.DRAMMA_API_KEY!,  // Bearer token for YOUR backend
  httpOptions: {
    baseUrl: "https://your-app.example/api/llm/google",
    // other HttpOptions fields: apiVersion, headers, timeout, retryOptions, ...
  },
});
```

The `HttpOptions` interface (re-exported from `@google/genai`) is also re-exported from `@llm-ports/adapter-google`, so consumers can type their override without adding `@google/genai` as a peer dep.

## Backwards compatibility

Additive: callers who don't pass `httpOptions` see no behavior change. The conditional spread (`...(opts.httpOptions ? { httpOptions: opts.httpOptions } : {})`) means the field is also omitted from the constructor call when not supplied — matches the pre-alpha.22 wire shape exactly.

## Tests

5 new tests in `tests/quirks/http-options-passthrough.test.ts`:
- baseUrl forwarded to GoogleGenAI constructor
- Full HttpOptions object (baseUrl + apiVersion + headers + timeout) forwarded verbatim
- Constructor call unchanged when httpOptions omitted (no breaking change)
- Constructor call unchanged when httpOptions explicitly undefined
- HttpOptions type is reachable from the package surface (compile-time check)

Plus a `vi.hoisted`-based test helper refactor that exposes the `GoogleGenAI` constructor mock so future tests can assert what the adapter passes through to the SDK.
