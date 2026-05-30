---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/capabilities": minor
---

Add `providerExtras?: Record<string, unknown>` to all 5 `*Options` interfaces. Per-call escape hatch for provider-specific request fields the port doesn't model. Shallow-merged into the SDK request body **after** the typed port fields, so callers can override the typed defaults.

```ts
// vLLM serving Qwen3-Reasoning — engage thinking via chat_template_kwargs
const vllm = createOpenAIAdapter({
  apiKey: "EMPTY",
  baseURL: "http://localhost:8000/v1",
  displayName: "vllm",
});
const port = vllm.createLLMPort("Qwen/Qwen3-235B-A22B-Thinking", "vllm");

const result = await port.generateText({
  taskType: "complex-reasoning",
  prompt: "Solve this step by step: ...",
  providerExtras: {
    chat_template_kwargs: { enable_thinking: true },
  },
});
```

**Common patterns the field unlocks:**

- vLLM `chat_template_kwargs` (Qwen3 `enable_thinking`, DeepSeek `thinking`)
- vLLM guided decoding (`guided_json`, `guided_grammar`, `guided_regex`)
- SGLang structured output (`regex`, `ebnf`, `choices`)
- Together AI / Fireworks knobs (`repetition_penalty`, `prompt_truncate_len`, `top_a`, `mirostat_tau`)

**Threaded through every call shape AND every capability factory.** All 5 port methods (`generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`) and all 7 capability factories (`createClassifier`, `createScorer`, `createExtractor`, `createPlanner`, `createAnalyzer`, `createDrafter`, `createSummarizer`) propagate `providerExtras` from per-call input to the underlying port call.

**Vendor-neutral by design.** Chose `providerExtras` over `chatTemplateKwargs` (vLLM-specific) or `providerOptions: { vllm: {...} }` (redundant — our adapter is already per-provider). The library doesn't endorse any one OSS-serving runtime in the public type signature; worked examples in `docs/adapters/openai.md` cover vLLM AND SGLang.

**Caller-overridable typed fields.** Position matters: `providerExtras` shallow-merges AFTER typed fields like `reasoning_effort`, `response_format`, `tools`. So a caller passing `{ providerExtras: { reasoning_effort: "high" } }` along with `reasoningEffort: "low"` ends up with `reasoning_effort: "high"` on the wire (escape hatch wins). The port does not validate `providerExtras` values; field semantics are provider-specific.

15 new tests (6 adapter-openai quirks + 9 capability passthrough); 567 tests passing across the workspace.

Addresses the gap for frontier OSS models served via vLLM (Qwen3-Reasoning, DeepSeek-V3.2, Llama 4 Reasoning, gpt-oss-120b) and SGLang where per-model template variables gate reasoning behavior that the cross-provider port surface intentionally doesn't model. Closes the alpha.16 design ticket.
