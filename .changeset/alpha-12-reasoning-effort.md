---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
---

Add `reasoningEffort?: "low" | "medium" | "high"` to all 5 `*Options` interfaces. Forwarded as `reasoning_effort` on OpenAI-shape SDK calls.

Applies to OpenAI native `o3` / `o4-mini` / `gpt-5-nano` / `gpt-5` and to OpenAI-compat providers that honor the parameter — notably **Groq's `openai/gpt-oss-120b`**, which gates reasoning quality on this knob without offering separate model IDs per effort level.

```ts
const groq = createOpenAIAdapter({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
  displayName: "groq",
});

const port = registry.getPort();
const result = await port.generateText({
  taskType: "complex-reasoning",
  prompt: "...",
  reasoningEffort: "high",  // ← controls internal CoT depth
});
```

**Threaded through every call shape.** `generateText`, `generateStructured`, `streamText`, `streamStructured`, and `runAgent` (every loop step) all forward the field when set.

**Silently ignored** by adapters whose providers don't honor it — adapter-anthropic, adapter-google, adapter-ollama, adapter-vercel. The call still succeeds at the provider's default effort level. No per-model gating in v0.1 for adapter-openai either: if a user sets `reasoningEffort` on a non-reasoning model and the provider doesn't accept it, the SDK call may reject — runtime capability learning (`jsonModeUnsupported`-style) would be the right reaction, but a v0.2 follow-up.

5 new tests; 508 tests passing across the workspace.

Closes BEPA-side tech debt `TD-LLMPORTS-REASONING-EFFORT`.
