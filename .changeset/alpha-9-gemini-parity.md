---
"@llm-ports/adapter-google": minor
---

Gemini parity: multi-turn `runAgent` + native `responseSchema`.

**`runAgent` is now multi-turn.** alpha.5–alpha.8 shipped a single-turn shim that ignored `maxSteps > 1` and surfaced no `toolCalls`. The adapter now translates `options.tools` to Gemini's `Tool[]` shape (function declarations with JSON Schema, OpenAPI 3.0 subset, via `zod-to-json-schema`), loops the chat / function-call / function-response cycle until the model returns text only (`terminationReason: "completed"`) or `maxSteps` is reached (`terminationReason: "max_steps"`), and reports the full `toolCalls` array + aggregated usage across steps. Parallel function calls (Gemini emits multiple in a single turn) are executed and their responses are returned together, matching Gemini's required protocol.

**`generateStructured` now uses native `responseSchema`** for constrained-decoding when the Zod schema converts cleanly to Gemini's accepted JSON Schema dialect. The adapter passes `config.responseSchema` + `config.responseMimeType: "application/json"` so Gemini constrains decoding to the schema before tokens are produced. Zod validation, the alpha.5 repair pass, and `retry-with-feedback` remain the safety net (Gemini's schema enforcement is best-effort).

When the schema contains features Gemini's responseSchema does not accept (`oneOf`, `allOf`, `not`, `$ref` — note: `anyOf` IS accepted; `z.discriminatedUnion` produces `anyOf` and stays on the native path), the adapter falls back to the prompted-JSON path with a one-time `console.warn` per (model, feature) pair. Output is still correct in either case — only the constrained-decoding guarantee differs.

**New dependency:** `zod-to-json-schema ^3.23.5` (already a transitive dep via adapter-openai / adapter-anthropic).

**New exported helpers** (mostly used internally; exported for advanced testing):
- `_resetSchemaFallbackWarnings()` — test-only Set reset.

Closes the two v0.2-commitments listed in alpha.5's release notes for `adapter-google`. 13 new tests (7 multi-turn + 6 native responseSchema).
