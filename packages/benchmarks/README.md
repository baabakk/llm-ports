# @llm-ports/benchmarks

Internal benchmark scripts. **Private; never published to npm.**

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
