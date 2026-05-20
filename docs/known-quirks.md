# Known model quirks

Per-model behaviors that the adapters absorb automatically. This file is the public catalog of quirks the static-catalog seeding inside each adapter pre-knows about. Runtime learning catches new ones; this file records what we've already absorbed so users can search before opening duplicate issues.

If you hit a model rejection or behavior not listed here, the adapter's runtime-learning warning will include a pre-filled GitHub issue URL. One click + submit and we add it to the next release.

---

## `@llm-ports/adapter-anthropic`

### Models that reject `temperature`

Anthropic deprecates `temperature` per-model on the newer reasoning lineup. The adapter strips the parameter automatically.

| Model pattern | Constraint | First seen |
|---|---|---|
| `claude-opus-4-5*` | `temperatureLocked` | alpha.3 (2026-05) |
| `claude-sonnet-4-5*` | `temperatureLocked` | alpha.3 (2026-05) |

To extend: edit `KNOWN_TEMPERATURE_REJECTORS` in `packages/adapter-anthropic/src/capabilities.ts` and ship a patch release. Or wait for runtime learning to catch the new model on first use; the adapter retries and learns automatically.

---

## `@llm-ports/adapter-openai`

### Models that reject `temperature`

OpenAI's reasoning models (o-series, gpt-5-nano) reject custom `temperature` values. Handled by the same runtime-learning machinery as adapter-anthropic, with OpenAI-specific error classifiers in `packages/adapter-openai/src/capabilities.ts`.

Detected via `isTemperatureRejection` matching:
- `code: "unsupported_value"` + `param: "temperature"` in the OpenAI error response, OR
- error message containing `/temperature/i + /(unsupported|not support|does not)/i`

No static catalog yet (the adapter learns from the first call). If you want to skip the wasted round-trip, supply `pricingOverrides[modelId].capabilities.temperatureLocked = true` at adapter construction.

### Models that reject `response_format: json_object`

Some reasoning models don't support OpenAI's native JSON mode. The adapter falls back to prompted-JSON-plus-Zod-retry automatically.

Detected via `isJsonModeRejection` in `packages/adapter-openai/src/capabilities.ts`.

### Models that reject a separate `system` message

Some reasoning models require the system content folded into the first user message. The adapter handles this transparently.

Detected via `isSystemMessageRejection` in `packages/adapter-openai/src/capabilities.ts`.

### Reasoning-model starvation

Reasoning models (OpenAI o-series, gpt-5-nano, Cerebras `gpt-oss-*` via `baseURL`) can spend their entire output-token budget on hidden reasoning, returning empty visible text. The adapter detects this (empty text + `finishReason === "length"` + tokens consumed + caller-supplied `maxOutputTokens`) and retries once with `REASONING_RETRY_MULTIPLIER` × the budget.

---

## `@llm-ports/adapter-vercel`

### Reasoning-model starvation

Mirrors the adapter-openai behavior: empty visible text + `finishReason === "length"` + tokens consumed + `maxOutputTokens` set → adapter retries once with 4× budget.

### Empty structured-output response

Vercel adapter's `generateStructured` throws a typed `EmptyResponseError` (from `@llm-ports/core`) instead of letting `JSON.parse("")` raise an uninterpretable `SyntaxError`. The registry can route on this error type.

---

## `@llm-ports/adapter-ollama`

No model-specific quirks observed in the wild yet. Ollama runs locally; users control the model lineup. If you hit one, the warning + pre-filled GitHub URL will guide you to file.

---

## How to read this file

Each entry has three things:

1. **Pattern**: regex that matches model IDs the constraint applies to
2. **Constraint**: the `ModelCapabilities` flag the adapter learns / pre-seeds
3. **First seen**: which release added the entry

The static catalog is an optimization. If your model is NOT listed here, the adapter still catches the constraint on first call via runtime learning. The catalog just skips one round-trip on the first call for known cases.

## How to add an entry

1. Click the URL in the `console.warn` your adapter prints when it learns a constraint.
2. GitHub opens a New Issue page with title + body + labels pre-filled.
3. Review the fields (especially the model ID, in case the warning got a partial match).
4. Submit. We'll add the entry to this file + the relevant adapter's static catalog in the next patch release.
