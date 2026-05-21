---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
---

Two-layer validation hardening that reduces retry-with-feedback round-trips:

**Layer 1 — `extractJSON()` falls back to `jsonrepair`** when plain `JSON.parse` fails. Catches trailing commas, single quotes, smart quotes, unquoted keys, Python `None`/`True`/`False`, comments, missing braces, and most other LLM syntactic quirks before paying for a retry. Gated on "input has `{` or `[`" so prose-only input still throws cleanly.

**Layer 2 — `attemptValidationRepair()` ported from BEPA** runs between Zod `safeParse` failure and the retry-with-feedback step. Deterministic, schema-driven repair of 6 patterns:

1. `null` where a non-null type is expected → delete key (lets `.optional()` succeed)
2. string `"9"` where `number` expected → coerce to `9`
3. string `"true"`/`"false"` where `boolean` expected → coerce to `true`/`false`
4. number `9` where `string` expected → coerce to `"9"`
5. enum case/whitespace drift (`"HIGH"`) → `.toLowerCase().trim()` (`"high"`)
6. `null` in optional union → delete key

Wired into `generateStructured` on every adapter. Each match avoids an LLM retry round-trip.

Compatible with both Zod v3 (`invalid_enum_value`) and Zod v4 (`invalid_value`).

20 new tests in `@llm-ports/core` (8 jsonrepair + 12 repair-validation).
