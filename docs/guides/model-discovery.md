# Runtime model discovery

Bundled per-adapter pricing tables go stale. Providers add models, retire models, and quietly change USD rates. `LLMPort.listModels()` and `Registry.checkPricingFreshness()` (both shipped in `0.1.0-alpha.9`) give you a way to detect that drift without leaving runtime cost computation to chance.

## Listing the live catalog

Every adapter that implements `listModels()` returns a `ProviderModelInfo[]` from the provider's catalog API. The shape is uniform across providers; each adapter populates the fields its provider exposes.

```ts
import type { ProviderModelInfo } from "@llm-ports/core";

const port = registry.getPort();
const models = await port.listModels?.();
// [
//   { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: 1048576 },
//   { id: "gemini-2.5-pro",   displayName: "Gemini 2.5 Pro",   contextWindow: 2097152 },
//   ...
// ]
```

The method is optional on `LLMPort`. Check `port.listModels` exists before calling — adapters that don't speak a `/models` endpoint (today: `adapter-vercel`, because the underlying `LanguageModel` is opaque per-provider) return `undefined` for the method.

| Adapter | Source | Pricing exposed? | Notes |
|---|---|---|---|
| `adapter-openai` | `client.models.list()` | No (just IDs + `owned_by`) | Works against the canonical OpenAI endpoint AND every compat-`baseURL` that implements the same shape (Groq, Cerebras, Together, etc.). |
| `adapter-anthropic` | Direct fetch to `/v1/models` | No | SDK <0.39 didn't expose `client.models`, so the adapter hits the REST endpoint directly. SDK 0.39+ is fine too. |
| `adapter-google` | `client.models.list()` from `@google/genai` | No (Gemini surfaces context window, not USD rates) | The model `name` comes back prefixed with `models/`; the adapter strips it so you get `"gemini-2.5-flash"` not `"models/gemini-2.5-flash"`. |
| `adapter-ollama` | `client.list()` (locally running models) | No (local; free) | Returns `id`, `size`, `modified_at`, `digest` in metadata. |
| `adapter-vercel` | NOT implemented | — | The Vercel `LanguageModel` shape doesn't surface a discovery API. Use the underlying provider's adapter for discovery. |

## Checking bundled pricing freshness

`Registry.checkPricingFreshness()` compares each registered adapter's bundled `*_PRICING` table against the provider's live catalog. It reports added models, removed models, per-model rate drift (when the API exposes pricing), and skipped adapters.

```ts
const report = await registry.checkPricingFreshness();

for (const a of report.checked) {
  if (a.addedModels.length > 0) {
    console.warn(
      `[${a.adapter}] ${a.addedModels.length} new models from provider, not in bundled table:`,
      a.addedModels,
    );
  }
  if (a.removedModels.length > 0) {
    console.warn(
      `[${a.adapter}] ${a.removedModels.length} bundled models no longer exposed by provider:`,
      a.removedModels,
    );
  }
  if (a.priceDrift.length > 0) {
    console.warn(`[${a.adapter}] price drift detected:`, a.priceDrift);
  }
}

for (const s of report.skipped) {
  console.info(`[${s.adapter}] skipped — ${s.reason}`);
}
```

Output shape:

```ts
interface PricingFreshnessReport {
  checked: Array<{
    adapter: string;
    liveModelCount: number;
    bundledModelCount: number;
    addedModels: string[];       // in catalog, not in bundle (newly launched)
    removedModels: string[];     // in bundle, not in catalog (deprecated)
    priceDrift: Array<{          // rate divergence when the API exposes it
      modelId: string;
      bundledInputPer1M: number;
      bundledOutputPer1M: number;
      liveInputPer1M: number;
      liveOutputPer1M: number;
    }>;
  }>;
  skipped: Array<{ adapter: string; reason: string }>;
}
```

### Recommended usage

Wire it into a **scheduled CI job** (daily, weekly, whatever cadence matches your tolerance for stale pricing). The report is informational, not blocking — the bundled tables remain the source of truth for cost computation. Treat freshness output as a signal that someone needs to update `packages/adapter-*/src/pricing.ts`.

```yaml
# .github/workflows/pricing-freshness.yml
on:
  schedule:
    - cron: "0 0 * * 0"   # weekly Sunday 00:00 UTC
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/check-pricing.mjs
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

```js
// scripts/check-pricing.mjs
import { createRegistryFromEnv } from "@llm-ports/core";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
// ... build the registry with your real adapters
const report = await registry.checkPricingFreshness();
if (report.checked.some(a => a.addedModels.length || a.removedModels.length || a.priceDrift.length)) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);   // fail the workflow so you notice
}
```

## What freshness does NOT do

- **It does not auto-update the bundled tables.** Pricing remains a manually-maintained source of truth. Auto-updating from a `/models` endpoint would create a network dependency at adapter construction time, and providers' catalog APIs are not the canonical pricing source anyway.
- **It does not replace the registry's per-call cost computation.** USD cost on every call still comes from the bundled `*_PRICING` table (or per-model `pricingOverrides`). Freshness is a separate, opt-in surface.
- **It does not detect rate-only drift on most providers.** Most provider `/models` endpoints don't return USD rates. The `priceDrift` field is populated only for providers that surface pricing — today: none of the major ones. The mechanism is in place for when that changes (e.g. Cerebras has hinted at exposing per-tier pricing on `/v1/models`).

## Why not just bundle a network call?

The `pricing.ts` tables are intentionally point-in-time snapshots:

- **Zero network dependency at construction.** Building a registry is a fast, deterministic, offline operation. Adapters that fetch pricing at construction would make app startup brittle (provider 5xx → app fails to boot) and slower (extra round-trip per adapter).
- **Predictable cost math.** When the registry computes `cost.totalUSD = inputTokens * pricing.inputPer1M / 1e6 + ...`, you want the multiplier to be the value you reviewed, not whatever the provider was returning two milliseconds ago. If pricing changed and you didn't notice, that's a problem you want to fix in a PR, not silently absorb at runtime.
- **Bundled tables are debuggable.** Open `packages/adapter-openai/src/pricing.ts`, see the rates, see the date verified, blame the commit. A network fetch leaves no audit trail.

`listModels()` + `checkPricingFreshness()` are the mechanism for noticing when the snapshot needs to be refreshed. Refresh remains a human-in-the-loop step.

## Reading next

- [Cost gating guide](/guides/cost-gating) — how USD limits and per-call cost computation actually work
- [v0.1 status](/v0-1-status) — current bundled-pricing scope per adapter
