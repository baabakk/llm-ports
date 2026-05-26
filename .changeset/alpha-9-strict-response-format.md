---
"@llm-ports/adapter-openai": minor
---

Add `useStrictResponseFormat` option for OpenAI / Cerebras strict JSON Schema mode.

`generateStructured` can now emit `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` instead of classic `response_format: { type: "json_object" }`. With strict mode the provider constrains decoding to the exact schema before tokens are produced, so invalid JSON or missing fields are impossible (modulo provider bugs).

```ts
const adapter = createOpenAIAdapter({
  apiKey: process.env.CEREBRAS_API_KEY!,
  baseURL: "https://api.cerebras.ai/v1",
  useStrictResponseFormat: true,
});
```

**Auto-detection.** When `baseURL` contains `api.cerebras.ai` the flag enables itself, because Cerebras's gpt-oss / Qwen3.6 tiers silently ignore the classic `json_object` mode and require strict JSON Schema for reliable structured output. Set `useStrictResponseFormat: false` explicitly to override.

**Schema conversion.** Zod schemas are translated via `zod-to-json-schema` (`target: "openAi"`, `$refStrategy: "none"`), then post-processed to add `additionalProperties: false` on every nested object — a hard requirement of strict mode that the SDK does not auto-inject.

**Compatibility.** When omitted (and `baseURL` is not Cerebras), behavior is identical to alpha.8 — classic `json_object` mode. Models that don't support strict mode (and report it via the runtime-learning `jsonModeUnsupported` capability) still see the same fallback path.

5 new unit tests.
