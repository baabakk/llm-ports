---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-ollama": minor
---

Runtime model discovery: `LLMPort.listModels()` + `Registry.checkPricingFreshness()` (closes [#9](https://github.com/baabakk/llm-ports/issues/9)).

**`LLMPort.listModels?(): Promise<ProviderModelInfo[]>`.** New optional method on every LLMPort. Returns the models the provider currently exposes via its catalog API. Implemented in:

| Adapter | Source | Pricing exposed? |
|---|---|---|
| `adapter-openai` | `client.models.list()` | No (just IDs + `owned_by`) |
| `adapter-anthropic` | direct fetch to `/v1/models` (SDK <0.39 lacks `client.models`) | No |
| `adapter-google` | `client.models.list()` from `@google/genai` | No (Gemini surfaces context window, not USD rates) |
| `adapter-ollama` | `client.list()` (locally running models) | No (local; free) |

`adapter-vercel` does NOT implement it: the underlying `LanguageModel` is opaque per-provider and there's no uniform discovery surface.

**`Registry.checkPricingFreshness()`.** Compares each adapter's bundled `*_PRICING` table against the provider's live catalog and reports:

- `addedModels`: live IDs not in the bundled table (newly launched models you can opt into via `pricingOverrides`)
- `removedModels`: bundled IDs the provider no longer exposes (likely deprecated)
- `priceDrift`: per-model rate differences when the API surfaces pricing (today: none; future-proofs the report)
- `skipped`: adapters without `listModels()` or whose call failed (with reason)

Use in CI or a scheduled job to get a heads-up when a provider quietly changes its catalog. The bundled tables remain the source of truth for cost computation; this method does NOT auto-update them.

```ts
const report = await registry.checkPricingFreshness();
for (const a of report.checked) {
  if (a.addedModels.length > 0) {
    console.warn(`[${a.adapter}] new models available: ${a.addedModels.join(", ")}`);
  }
  if (a.removedModels.length > 0) {
    console.warn(`[${a.adapter}] bundled models no longer exposed: ${a.removedModels.join(", ")}`);
  }
}
```

**New core exports:** `ProviderModelInfo`, `PricingFreshnessReport`, `PricingFreshnessAdapterReport`.

4 new core tests for `checkPricingFreshness`.
