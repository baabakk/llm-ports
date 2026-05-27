# Reasoning effort

Some LLMs gate quality vs cost on a `reasoning_effort` parameter. Set it via the `reasoningEffort?: "low" | "medium" | "high"` option on any LLMPort call (alpha.12+) or on any `Create*Config` (alpha.13+).

## What it does

For reasoning models, the provider runs an internal chain-of-thought before producing visible output. Higher `reasoning_effort` means more CoT tokens (more cost, more latency, generally higher quality on hard problems). Lower means the model gives a faster, cheaper, less thoroughly-reasoned answer.

OpenAI's reasoning family defaults to `"medium"`. Setting `"high"` notably increases reasoning-token spend on hard problems.

## Where it applies

| Provider / model | `reasoning_effort` accepted | Notes |
|---|---|---|
| OpenAI `o3` / `o3-mini` / `o4-mini` | ✓ | Native; default `"medium"` |
| OpenAI `gpt-5-nano` | ✓ | Default `"medium"` |
| OpenAI `gpt-5` | ✓ | Default `"medium"` |
| Groq `openai/gpt-oss-120b` | ✓ | **No separate model IDs per effort level** — this knob is the only way to escalate quality |
| Anthropic Claude 4.5+ reasoning models | ✗ | Anthropic uses its own [thinking config](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking), not this parameter — silently ignored |
| Google Gemini reasoning | ✗ | Gemini uses `thinkingBudget` — silently ignored |
| Ollama local models | ✗ | Local-only; silently ignored |
| Non-reasoning OpenAI models (`gpt-4o`, etc.) | depends — often rejects | Use a reasoning model OR a compat provider that honors it |

If a provider doesn't honor the field, the adapter still passes it through. Most non-supporting endpoints just ignore unknown fields. A few may reject — runtime capability learning for that case (parallel to `jsonModeUnsupported`) lands in v0.2.

## Three ways to set it

### Per-call on the port directly

```ts
const result = await port.generateText({
  taskType: "complex-reasoning",
  prompt: "Explain the trade-offs of using Raft vs Paxos for consensus.",
  reasoningEffort: "high",
});
```

Works on every call shape: `generateText`, `generateStructured`, `streamText`, `streamStructured`, `runAgent`.

### Per-factory on a capability

Set once at factory definition; every call from that capability inherits it:

```ts
const score = createScorer({
  port: llm,
  schema: LeadScoreSchema,
  schemaName: "lead-score",
  rubric: ...,
  reasoningEffort: "high",   // every score(...) call uses high effort
});

const result = await score({ content: leadProfile });
```

### Per-call on a capability — NOT yet supported

`reasoningEffort` is per-factory only on the capability layer for v0.1. If you need to vary effort per-call within the same capability, drop down to the port directly:

```ts
// Workaround: skip the factory, call port.generateStructured
const easy = await port.generateStructured({ ..., reasoningEffort: "low" });
const hard = await port.generateStructured({ ..., reasoningEffort: "high" });
```

A per-call override on the factory input (`score({ content, reasoningEffort: "high" })`) is on the v0.2 list if there's demand.

## Cost / latency trade-off

Setting `"high"` typically **doubles or triples** reasoning-token spend on hard problems. Concretely (rough, observed on BEPA traffic against Groq's `openai/gpt-oss-120b`):

| Effort | Reasoning tokens / call | Latency | Quality on hard problems |
|---|---|---|---|
| `"low"` | ~100 | fastest | acceptable on easy/medium |
| `"medium"` (default) | ~400 | 1–2× baseline | strong |
| `"high"` | ~1500 | 3–5× baseline | best |

Quality plateaus quickly for easy problems. Reserve `"high"` for genuinely hard reasoning steps (multi-step deduction, careful planning, code refactoring decisions). For triage and classification, `"low"` is usually fine.

## When NOT to use it

- **Plain text gen on a non-reasoning model.** No effect (or rejection). Just don't set it.
- **Speed-critical paths.** `"low"` is faster than not setting it at all, but `"high"` is always slower than the model's default. If you have a latency budget, leave it unset and use a smaller / faster model instead.
- **Vendor lock-in concerns.** Different providers use different mechanisms (Anthropic `thinking`, Gemini `thinkingBudget`). `reasoningEffort` is the OpenAI-shape lever; capabilities that need cross-provider portability should rely on bigger structural levers (model selection, prompt design) instead.

## Implementation notes

- Forwarded verbatim from the call site to the provider. No per-model gating in v0.1.
- `adapter-openai` reads the option and sets `reasoning_effort` on the SDK call. Other adapters silently drop it (the field is simply not in their request shape).
- The capability layer (`@llm-ports/capabilities`) propagates the option from `Create*Config` to the underlying `port.generateStructured` / `port.generateText` call since alpha.13.

## Reading next

- [Cost gating guide](/guides/cost-gating) — set USD caps that catch high-effort runaway spend
- [`createScorer`](/capabilities/scorer) — the typical factory you'd want `"high"` on
- [Capabilities overview](/capabilities/) — the per-factory passthrough surface
