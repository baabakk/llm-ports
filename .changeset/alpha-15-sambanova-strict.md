---
"@llm-ports/adapter-openai": minor
---

`useStrictResponseFormat` auto-detect extended to SambaNova (`api.sambanova.ai`). Empirically verified — MiniMax-M2.7 with strict mode forced on jumped from **0/10 → 10/10** schema-valid on a nested production scoring schema (BEPA A/B harness, 2026-05-27).

## What changed

Single-line addition to `autoDetectStrictResponseFormat`:

```ts
if (baseURL.includes("api.sambanova.ai")) return true;
```

Default for SambaNova users:

| Before alpha.15 | After alpha.15 |
|---|---|
| `useStrictResponseFormat: false` (must opt in explicitly) | `useStrictResponseFormat: true` (auto-enabled) |

## Why

A BEPA A/B probe forced `useStrictResponseFormat: true` on a SambaNova adapter pointed at MiniMax-M2.7 and re-ran the same 10-job nested-schema test that produced 0/10 in alpha.13. Result: **10/10 schema-valid, 3987ms avg latency, $0.041 total cost across 10 calls.** SambaNova accepts strict `response_format: json_schema` and constrains decoding properly — the documentation was just silent about it.

Without the auto-detect, every SambaNova user with a non-trivial nested schema sees the same broken-by-default pattern OpenAI native users saw before alpha.14: invented enum values, flat strings where objects expected, retry-with-feedback tax on every call.

## Breaking change for what

Users whose Zod schemas use **open shapes** that can't accept `additionalProperties: false` (`z.record(...)`, model-extends-allowed schemas) on a SambaNova adapter will hit the rejection. Opt out:

```ts
const sambanova = createOpenAIAdapter({
  apiKey: process.env.SAMBANOVA_API_KEY!,
  baseURL: "https://api.sambanova.ai/v1",
  useStrictResponseFormat: false, // opt out
});
```

Runtime capability learning also catches the rejection: `jsonModeUnsupported: true` is remembered after the first 400.

## Tests

1 flipped entry in the `autoDetectStrictResponseFormat` `it.each` matrix (SambaNova flipped from `false` → `true`); 1 new integration test (SambaNova auto-enables in adapter construction); 1 new "stays opt-in" coverage replaced with Together AI as the new unknown-compat exemplar. 144 adapter-openai tests passing.

## Closes

- BEPA-internal `TD-APPLICATIONS-SCORING-SCHEMA-STRICT-MULTIPROVIDER` sub-task 3 (SambaNova strict-mode probe). Sub-task 1 (OpenAI native + Groq) was closed by alpha.14. Sub-task 2 (Anthropic structured-output discipline) is structural library work that lands in v0.2.

## Discovered by

BEPA Upwork-scoring A/B harness re-run with explicit `useStrictResponseFormat: true` override on SambaNova, 2026-05-27. Probe script: `scripts/upwork-ab-test.ts`.
