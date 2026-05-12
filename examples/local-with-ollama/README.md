# `local-with-ollama` example

Local-first LLM dev loop with `@llm-ports/adapter-ollama`. Same `await llm.generateText(...)` works for:

1. **Local only** — Ollama daemon, zero cost, fully offline (default).
2. **Local + cloud fallback** — `LLM_TASK_ROUTE_*=local,cloud` walks the chain.
3. **Force cloud** — same code path runs on Anthropic when `FORCE_CLOUD=1`.

This is the local-to-cloud flip pattern: develop offline, ship with cloud providers, change one env var. Application code never imports `ollama` or `@anthropic-ai/sdk` directly.

## Prereqs

- Ollama installed and daemon running: `ollama serve`
- At least one model pulled: `ollama pull llama3.2` (the example uses this by default; override with `OLLAMA_MODEL=...`)
- The Ollama adapter is also configured with `autoPull: true`, so if you've never pulled the model, the first call will fetch it (one-time).

## Run

```bash
# Local only (default — needs Ollama daemon)
pnpm --filter @llm-ports/example-local-with-ollama start

# Local with cloud fallback (Ollama primary, Anthropic backup)
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @llm-ports/example-local-with-ollama start

# Force cloud — skip Ollama entirely (proves prod parity)
FORCE_CLOUD=1 ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @llm-ports/example-local-with-ollama start
```

## What the example shows

| Step | What runs |
|---|---|
| Health check | `ollama.checkHealth()` — daemon reachable in N ms |
| `generateText` | One-shot text generation via the local model |
| `generateStructured` | Zod-typed extraction with `retry-with-feedback` (smaller local models occasionally need a retry to hit the schema; you'll see `validationAttempts: 2` when that happens) |
| `listModels` (local only) | Snapshot of pulled Ollama models with sizes |

## Why this matters

A cloud-only dev loop is expensive (every iteration costs USD) and slow (200-800 ms p95 round-trip vs. ~20-100 ms locally). With `@llm-ports`, the local path uses the exact same port surface as the cloud path, so:

- You can iterate offline on a flight.
- You can rerun integration tests without burning budget.
- You can switch to cloud for higher quality on production-grade tasks with one `.env` change.
- You can fan out to local + cloud and let the registry pick whichever is in budget.

The pricing table for Ollama models reports `$0/1M tokens` so the cost gating (USD-denominated) treats the local provider as free. Cost-USD on `result.cost.totalUSD` is `0` on the local path and positive on the cloud path; you can compare side-by-side in the same run.
