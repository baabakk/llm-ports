# Adapters

Four adapters ship with v0.1, covering 14+ providers in total. Plus a 5th private package (`adapter-contract-tests`) that is not published; it's the shared conformance suite every adapter must pass.

| Adapter | Covers | Implements |
|---------|--------|------------|
| [`@llm-ports/adapter-anthropic`](/adapters/anthropic) | Anthropic Claude (Opus, Sonnet, Haiku) | `LLMPort` |
| [`@llm-ports/adapter-openai`](/adapters/openai) | OpenAI + 10+ compat providers via `baseURL` (Azure OpenAI, Groq, Together AI, Fireworks AI, DeepInfra, Perplexity, Cerebras, LiteLLM proxy, ...) | `LLMPort`, `EmbeddingsPort` |
| [`@llm-ports/adapter-ollama`](/adapters/ollama) | Local LLMs via the Ollama daemon | `LLMPort`, `EmbeddingsPort`, model management |
| [`@llm-ports/adapter-vercel`](/adapters/vercel) | Migration from `@ai-sdk/*` | `LLMPort`, `EmbeddingsPort` (limited multimodal in v0.1) |

## Feature matrix

`✓` = supported, `✗` = not supported, `✓*` = model-dependent, `n/a` = doesn't apply.

| Feature | Anthropic | OpenAI | Ollama | Vercel |
|---------|:---------:|:------:|:------:|:------:|
| Text generation | ✓ | ✓ | ✓ | ✓ |
| Structured output (Zod schema) | ✓ | ✓ | ✓\* | ✓ |
| Streaming text | ✓ | ✓ | ✓ | ✓ |
| Streaming structured (partial JSON) | ✓ | ✓ | ✓ | ✓ |
| Tool use | ✓ | ✓ | ✓\* | partial (single-turn in v0.1) |
| Vision input (base64) | ✓ | ✓ (data URI) | ✓\* | partial (string conversion) |
| Vision input (URL) | ✓ | ✓ | ✗ (Ollama doesn't fetch URLs) | partial |
| Audio input | ✗ (Anthropic chat) | ✓ (wav, mp3) | ✗ | ✗ |
| Audio output | ✗ | ✓ | ✗ | ✗ |
| Prompt caching | ✓ native | partial (cached_tokens reported) | n/a | via Vercel |
| Embeddings | ✗ | ✓ | ✓ | ✓ (via Vercel) |
| Batch embeddings | n/a | ✓ | ✓ | ✓ |
| Model management (list/pull/delete) | ✗ | ✗ | ✓ | ✗ |
| Cost tracking (pricing tables) | ✓ | ✓ | ✓ (zero-cost default) | ✓ (user-supplied pricing) |
| `baseURL` override (compat providers) | ✓ | ✓ (primary feature) | n/a (always local) | n/a |

## Gaps to address in v0.2

- **Ollama**: pre-emptive `streamStructured` handling once Ollama's API exposes partial JSON natively.
- **OpenAI**: prompt caching first-class once OpenAI ships its caching API surface.
- **Anthropic**: embeddings, if and when Anthropic ships an embedding model.
- **Vercel**: full multimodal content-block round-trip (currently limited to text via stringify on the way in).

## v0.3 adds

- `@llm-ports/adapter-google` for Gemini (different API shape)
- `@llm-ports/adapter-bedrock` for AWS users (Claude on Bedrock, Titan embeddings)

## Writing your own

If you need a provider not listed here, see [Custom adapters →](/guides/custom-adapters).

Every adapter must pass `@llm-ports/adapter-contract-tests`. The shared suite asserts adapter-agnostic invariants (port shape, content-block round-trip, cost field populated, error mapping). New invariants added there automatically apply to every adapter on the next CI run.
