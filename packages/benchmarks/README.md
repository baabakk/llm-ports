# @llm-ports/benchmarks

Internal benchmark scripts and live API integration tests. **Private; never published to npm.**

## Live API integration tests

For [TEST-PLAN.md](../../../TEST-PLAN.md) Phase 2 (live adapter validation) and Phase 3 (live capability validation). Tests are gated on `RUN_LIVE_TESTS=1` plus the relevant provider's API key, so the suite skips cleanly without secrets and is safe to commit.

### Run all live tests

```bash
RUN_LIVE_TESTS=1 \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-... \
  pnpm test:live
```

### Run per-provider

```bash
RUN_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:live:anthropic
RUN_LIVE_TESTS=1 OPENAI_API_KEY=sk-...        pnpm test:live:openai
RUN_LIVE_TESTS=1                              pnpm test:live:ollama       # needs daemon at OLLAMA_URL
RUN_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:live:vercel
RUN_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:live:capabilities
```

### Optional env vars

| Var | Purpose | Required for |
|-----|---------|--------------|
| `RUN_LIVE_TESTS=1` | Master gate; without it, all live tests skip | All live tests |
| `ANTHROPIC_API_KEY` | Anthropic API key | anthropic, vercel-anthropic, capabilities |
| `OPENAI_API_KEY` | OpenAI API key | openai, vercel-openai |
| `GROQ_API_KEY` | Groq API key (compat provider) | openai compat-Groq test |
| `CEREBRAS_API_KEY` | Cerebras API key | openai compat-Cerebras test |
| `OLLAMA_URL` | Ollama daemon URL (default `http://localhost:11434`) | ollama |
| `OLLAMA_TEST_MODEL` | Override test model (default `llama3.2`) | ollama |
| `OLLAMA_EMBED_MODEL` | Embedding model (default `nomic-embed-text`) | ollama |
| `OLLAMA_VISION_MODEL` | Vision model (default `llava`) | ollama vision test |

### Cost expectations

Cheapest viable run:

| Adapter | Models used | Estimated cost |
|---------|-------------|----------------|
| anthropic | claude-haiku-4-5 | $0.05 - $0.10 |
| openai | gpt-5-nano + text-embedding-3-small | $0.05 - $0.10 |
| ollama | local | $0 |
| vercel | claude-haiku-4-5 + gpt-5-nano | $0.05 - $0.10 |
| capabilities | claude-haiku-4-5 (~7 calls) | $0.10 - $0.20 |
| **Total** | — | **$0.30 - $0.50** |

Each test prints a cost summary at the end via `reportCosts()`.

### What skipping looks like

Run with no env vars set (the safe default):

```bash
$ pnpm test:live

 RUN  v2.1.x

 ✓ src/live/anthropic.test.ts (skipped, no ANTHROPIC_API_KEY)
 ✓ src/live/openai.test.ts (skipped, no OPENAI_API_KEY)
 ✓ src/live/ollama.test.ts (skipped, RUN_LIVE_TESTS not set)
 ✓ src/live/vercel.test.ts (skipped)
 ✓ src/live/capabilities.test.ts (skipped)

 Test Files  5 passed | 0 failed
```

All tests skip; nothing is hit.

### Adding a new live test

1. Add it to the relevant adapter test file under `src/live/`.
2. Use the assertion helpers from `src/live/shared.ts` for shape consistency.
3. Call `recordCost(adapterName, result.cost.totalUSD)` after each call so the
   summary at the end is accurate.
4. Document any new env vars in the table above.

---

## Latency overhead benchmark

## Latency overhead benchmark

Measures the framework overhead `llm-ports` adds on top of a direct SDK call. Both the "direct" and "llm-ports" paths share an identical mock fetch that returns canned responses with zero network I/O, so the difference is pure framework cost.

### Methodology (per implementation plan v3 §12.4)

- 100 iterations per operation after 10 warmup iterations
- Operations measured: `generateText`, `generateStructured`, `runAgent`
- Anthropic SDK + Anthropic adapter (lowest natural latency variance)
- Mock fetch returns a canned valid Messages API response immediately
- p50 and p99 reported for both paths and the difference

### Run

```bash
pnpm bench
```

### Target

p99 added latency under 5 ms per operation. The actual measured number is reported in the implementation plan §3 ("BEPA Track Record").

### What this measures vs what it doesn't

**Measures:**
- Registry task lookup
- Budget and cost backend recording (in-memory backend)
- Adapter content-block translation
- Cost computation from token usage + pricing table
- Hook dispatch (no hooks configured in this benchmark, just the call sites)
- Zod schema validation (for `generateStructured` only)

**Does NOT measure:**
- Real network latency (the entire LLM call dominates real-world latency)
- Cold-start cost (warmup runs first)
- Memory pressure or GC effects (single-process, short run)
