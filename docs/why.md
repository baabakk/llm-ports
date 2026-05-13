# Why this exists

Most TypeScript LLM code imports provider SDKs directly. `generateText()` calls scatter across dozens of files. Every SDK upgrade breaks multiple files. Every provider switch is a refactor. Cost control becomes per-call tracking glue you have to write yourself.

`llm-ports` fixes this. Two files import the LLM SDK; everything else talks to a provider-agnostic interface that supports multi-provider routing, USD cost gating, fallback chains, and reusable capability factories.

This is the library that assumes you're running LLMs in production at cost, not in a demo.

## Position in the ecosystem

| Tool | What it does | Where llm-ports differs |
|------|--------------|-------------------------|
| **[Vercel AI SDK](https://sdk.vercel.ai/)** | Unifies provider calls behind one TS API | `llm-ports` adds registry, fallback chains, USD cost gating, validation recovery, capability factories on top. Use `@llm-ports/adapter-vercel` to keep your existing setup. |
| **[LiteLLM](https://github.com/BerriAI/litellm)** | Python-first HTTP proxy that fronts every provider | `llm-ports` is TypeScript client-side — zero network hop, zero extra service to deploy. Talks to LiteLLM via the OpenAI adapter with a `baseURL`. |
| **[Portkey](https://portkey.ai/)** | Commercial hosted gateway with analytics UI | `llm-ports` is MIT, in-process, no vendor dependency. Tradeoff: Portkey ships features `llm-ports` does not (hosted UI, semantic caching). |
| **[LangChain.js](https://js.langchain.com/)** | Full agent / chain framework | `llm-ports` is a utility, not a framework. Wrap LangChain's LLM calls with a port for budget gating without adopting the whole framework. |
| **[LlamaIndex.TS](https://ts.llamaindex.ai/)** | Retrieval-first framework | `llm-ports` handles LLM invocation; bring your own retrieval. They compose cleanly. |
| **[Mastra](https://mastra.ai/)** | Opinionated agent-first with built-in memory and workflows | `llm-ports` is unopinionated primitives beneath that layer. |

The positioning in one line: **`llm-ports` is the smallest opinionated TypeScript library for LLMs in production, built around cost control, fallback chains, validation recovery, and tool-use security as primitives.**

Nothing above that, nothing below it.

## Production track record

`llm-ports` is extracted from BEPA, a private 24/7 AI executive assistant the author has been running in production for 5+ months across 4 LLM providers (Anthropic, OpenAI, Cerebras, DeepInfra), processing millions of LLM calls.

**The extracted core has 5 months of production runtime:**
- Single Hetzner server, Docker, 24/7 uptime
- 4 LLM providers, automatic fallback chains
- One Vercel AI SDK upgrade (v4 to v6) handled in an afternoon: 28 of 30 LLM-calling files were untouched
- Migration commit stats: 192 insertions, 688 deletions (codebase shrunk by 496 lines)
- Latency overhead added by the framework: mean p50 0.04 ms, max p99 0.47 ms (10x under the 5 ms target)

**v0.1 also extends that pattern with features the 2026 ecosystem requires** even though BEPA hasn't adopted them yet: multimodal content blocks, USD-denominated cost gating, split EmbeddingsPort, streamStructured. BEPA will absorb these back over time.

The track record above is for the extracted core, not the extensions. Credibility cuts both ways: overclaiming "all of v0.1 is production-tested" is wrong; underclaiming undersells the part that genuinely is. The above is the precise truth — the BEPA-extracted core has the runtime; the 2026-only additions (multimodal, USD gating, split EmbeddingsPort, streamStructured) ship in `0.1.0-alpha.*` as the test bake before they earn the same claim.

For the per-surface picture — what's stable, what's still being hardened, what ships in v0.2 — see the [v0.1 status page](/v0-1-status). It's the canonical inventory.

## When NOT to use this

- You have 1-2 LLM call sites and a single provider — the abstraction overhead isn't worth it.
- You're prototyping and not committed to an architecture.
- You need a provider-specific feature that doesn't generalize (e.g. Anthropic's prompt caching surface — though you can wire that into the adapter).
- You're building a library that wraps an LLM SDK — you ARE the adapter; just use `LLMPort` directly.

## Read next

- [Getting Started →](/getting-started)
- [Multi-provider routing in production →](/guides/multi-provider)
- [Cost gating in production →](/guides/cost-gating)
