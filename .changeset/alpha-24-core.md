---
"@llm-ports/core": minor
---

`deriveValidationRetryFromAdapterRetry` helper — closes the alpha.21-deferred `onValidationRetry` Registry-level emission.

## What changed

```ts
import { createRegistryFromEnv, deriveValidationRetryFromAdapterRetry } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

const registry = createRegistryFromEnv({
  // ...
  observability: {
    onValidationRetry: (e) => myMetrics.validationRetries.inc({ model: e.modelId }),
  },
});

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  onRetry: deriveValidationRetryFromAdapterRetry(registry, {
    userOnRetry: (e) => myLogger.warn("retry", e), // optional chaining
  }),
});
```

The Registry can't intercept adapter-internal retries (adapters are constructed independently). The helper produces an `OnRetry` callback that filters for `reason === "validation-feedback"` events and forwards them to the Registry's `observability.onValidationRetry` hook. Optionally chains with a user-supplied adapter-level `onRetry`.

## Why a helper, not Registry magic

Three rejected alternatives:

1. **Magic interception** — would require a new contract on `AdapterRegistration` so the Registry could intercept retries after adapter construction. Bigger surface, brittle.
2. **Make the user wire it manually** — verbose, error-prone. Users already wire `onRetry` filters by hand for the other reasons.
3. **Defer again** — three releases is enough.

The helper is the minimal-surface answer: opt-in, composable, makes the Registry-level hook actually useful without breaking changes to the existing contract.

## Caveats (documented)

The adapter-level `RetryEvent` doesn't carry `maxAttempts` or `operation`, so the helper:

- Sets `maxAttempts` to `event.attempt + 1` (best-known lower bound)
- Defaults `operation` to `"generateStructured"` (validation-feedback only fires from structured-output paths, so correct in practice; override via `opts.operation` if needed)
- Sets `cause` to `"schema-mismatch"` unconditionally (adapter doesn't distinguish parse errors from schema errors today)
- Forwards `event.cause` (the Zod issues array) into `ValidationRetryEvent.issues`

## Tests

11 new tests covering: forwards validation-feedback events, ignores other reasons, chains with user callback, user receives ALL reasons, swallows user errors, no-op when hook absent, operation override honored, issues forwarded, maxAttempts derivation.

## Backwards compatibility

Additive. The Registry's `observability.onValidationRetry` hook surface was already defined in alpha.21 (type-only); this helper makes it actually fire. Existing code that filtered the adapter's `onRetry` hook directly for `reason === "validation-feedback"` keeps working unchanged.
