# Examples

Ten worked examples ship in the repo at [`examples/`](https://github.com/baabakk/llm-ports/tree/main/examples). Each one is a self-contained `pnpm` project that builds cleanly against the published `@llm-ports/*@alpha` packages. Pick the one that matches what you're trying to do.

## Getting started

| Example | What it shows | Lines | Required keys |
|---|---|---|---|
| [basic](https://github.com/baabakk/llm-ports/tree/main/examples/basic) | The simplest possible call: one adapter, one `generateText`. | 30 | `ANTHROPIC_API_KEY` |
| [multi-provider](https://github.com/baabakk/llm-ports/tree/main/examples/multi-provider) | Fallback chain across Anthropic + OpenAI, USD cost gating, classifier capability factory. | ~120 | both |
| [streaming-chat](https://github.com/baabakk/llm-ports/tree/main/examples/streaming-chat) | Express SSE server: `streamText`, `streamStructured`, multi-turn, tool-augmented agent. | ~200 | either |

## Capability factories in practice

| Example | What it shows |
|---|---|
| [email-triage](https://github.com/baabakk/llm-ports/tree/main/examples/email-triage) | Compose `createClassifier` + `createDrafter`. Quality tracking. The BEPA-pattern condensed. |
| [extract-from-pdf](https://github.com/baabakk/llm-ports/tree/main/examples/extract-from-pdf) | `generateStructured` + validation retry-with-feedback against a (mock) OCR'd invoice. |
| [agent-with-approval](https://github.com/baabakk/llm-ports/tree/main/examples/agent-with-approval) | Tool-use security: read-only tools execute freely, destructive tools route through an approval gate. |

## Migration paths

| Example | What it shows |
|---|---|
| [migrate-from-vercel-ai](https://github.com/baabakk/llm-ports/tree/main/examples/migrate-from-vercel-ai) | Two paths: (a) wrap existing Vercel code, (b) progressively port to the typed registry. |

## Alpha.1+ observability + local LLMs

| Example | What it shows |
|---|---|
| [with-onretry](https://github.com/baabakk/llm-ports/tree/main/examples/with-onretry) | The new `onRetry` hook (alpha.1) wired to a console-logger and a metrics sink. Fires for `transient-auth`, `capability-fallback`, `reasoning-starvation`, `validation-feedback`. |
| [local-with-ollama](https://github.com/baabakk/llm-ports/tree/main/examples/local-with-ollama) | `@llm-ports/adapter-ollama` end-to-end: health check, `generateText`, `generateStructured`, optional cloud fallback chain via `FORCE_CLOUD=1`. |

## Live API integration tests

| Example | What it shows |
|---|---|
| [live-integration-tests](https://github.com/baabakk/llm-ports/tree/main/examples/live-integration-tests) | Four `.mjs` scripts that exercise the full `LLMPort` surface against real provider APIs (no mocks). Used to close Gate C of the publishing checklist; ~$0.002 to run the full suite. The `live-anthropic.mjs` `runAgent` step is the highest-value end-to-end verification of the alpha.1 zod-to-json-schema fix. |

## Reading next

- [Getting Started](/getting-started) — install and first call in under 5 minutes
- [Multi-Provider Routing](/guides/multi-provider) — the fallback-chain story behind `examples/multi-provider`
- [Local-to-Cloud Flip](/guides/local-to-cloud) — the deeper story behind `examples/local-with-ollama`
- [Tool-Use Security](/guides/security) — the policy model behind `examples/agent-with-approval`
