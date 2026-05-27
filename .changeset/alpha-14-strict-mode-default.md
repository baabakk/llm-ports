---
"@llm-ports/adapter-openai": minor
---

`useStrictResponseFormat` auto-detect expanded to OpenAI native + Groq. **Default behavior change**: `generateStructured` against OpenAI native (no `baseURL`) or Groq (`api.groq.com`) now uses strict `response_format: { type: "json_schema", strict: true }` instead of classic `{ type: "json_object" }`.

## Why

A real BEPA A/B harness against 5 production models × 10 Upwork jobs showed only Cerebras gpt-oss-120b satisfied the (intentionally nested) BEPA scoring schema 100% of the time. OpenAI native `gpt5-4-nano` + `gpt5-5` returned 0/10 — `recommendation` came back as objects, scores got flattened to top-level keys, enum strings got invented. The fix was a one-line flag (`useStrictResponseFormat: true`) the users didn't know they needed.

Generalizing: every llm-ports user calling `generateStructured` against OpenAI native or Groq with a non-trivial nested schema was silently paying a **2× cost + 2× latency** tax on retry-with-feedback rounds, because the default sent classic `json_object` mode. Strict json_schema mode has been GA on OpenAI's gpt-4o / gpt-5 / o-series since August 2024 and verified on Groq's `openai/gpt-oss-120b` per their docs. There is no scenario where the un-strict path produces better results on a well-formed schema.

## What auto-enables

| Condition | Default in alpha.14+ |
|---|---|
| `baseURL` unset (OpenAI native) | **`useStrictResponseFormat: true`** |
| `baseURL` contains `api.openai.com` | **`useStrictResponseFormat: true`** |
| `baseURL` contains `api.cerebras.ai` | `useStrictResponseFormat: true` (existing — alpha.9) |
| `baseURL` contains `api.groq.com` | **`useStrictResponseFormat: true`** |
| `baseURL` contains anything else (SambaNova, Together, Fireworks, Clarifai, LiteLLM, Ollama compat) | `useStrictResponseFormat: false` (unchanged — set explicitly to enable) |

## Breaking change for what

Users whose Zod schemas use **open shapes** that can't accept `additionalProperties: false`:

- `z.record(...)`
- Schemas where the model is allowed to add extra fields
- Schemas with computed/optional sections

These users will see strict-mode rejection from the provider on the first call after upgrade. **Opt out**: set `useStrictResponseFormat: false` explicitly:

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  useStrictResponseFormat: false,  // opt out of the new default
});
```

The adapter's runtime capability learning also catches the rejection — `jsonModeUnsupported: true` is remembered after the first 400 and subsequent calls fall back to prompted JSON. So even users who don't know about the opt-out will recover after one wasted round-trip.

## Bug fix bundled

`learnConstraintsFromError` now also triggers `jsonMode: false` learning when a `response_format` rejection happens on the `strictResponseSchema` path (alpha.9 only triggered on the legacy `jsonMode: true` path). This means a model that rejects `response_format` of either kind now gets `jsonModeUnsupported: true` remembered after one failure, regardless of which `response_format` shape the adapter sent.

## Tests

15 new tests (`autoDetectStrictResponseFormat` direct unit tests covering 10 baseURL shapes + 5 integration tests covering OpenAI native, Groq, Cerebras, SambaNova, opt-out). Total adapter-openai tests: 143 (up from 128). Total workspace: 552.

## New export

`autoDetectStrictResponseFormat(baseURL: string | undefined): boolean` — the predicate, exported for users who build adapter instances programmatically and want to inherit the same default logic.

## Discovered by

BEPA A/B harness on Upwork scoring (2026-05-26T20:45 -07:00). The harness file ([`scripts/upwork-ab-test.ts`](https://github.com/baabakk/BEPA)) is reusable; if you want to re-run it against any combination of llm-ports models, drop your model IDs in and `pnpm tsx scripts/upwork-ab-test.ts`. Pre-alpha.14: 1/5 models satisfied a non-trivial nested schema. Post-alpha.14: 3-4/5 expected.
