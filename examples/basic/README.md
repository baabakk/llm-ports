# `@llm-ports/example-basic`

The smallest possible end-to-end example. One adapter, one task type, one `generateText` call.

The point is not to show off features. The point is to show that **your application code does not import any LLM SDK** — only `@llm-ports/core`. Swap providers by changing the adapter wiring; the call site stays identical.

## Run it

```bash
# 1. Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# 2. From the monorepo root, run the example
pnpm --filter @llm-ports/example-basic start
```

You'll see something like:

```
Generated text: Hello, TypeScript developer!
Usage: { inputTokens: 18, outputTokens: 9, totalTokens: 27 }
Cost (USD): 0.000031
Latency (ms): 412
Provider alias: fast
Model: claude-haiku-4-5
```

## What's happening

Three pieces:

1. **Adapter wiring** ([`src/index.ts:24`](src/index.ts#L24)) — the only line in your app that imports an LLM SDK. Anthropic-specific. Replace it with `createOpenAIAdapter` or `createOllamaAdapter` and the rest of the file is untouched.

2. **Registry config** — env-style strings describing the provider chain and per-task routing:
   - `LLM_PROVIDER_FAST=anthropic|claude-haiku-4-5|cost:1/day` — alias `fast` uses the `anthropic` adapter, model `claude-haiku-4-5`, capped at $1 USD per day
   - `LLM_TASK_ROUTE_GREETING=fast` — calls with `taskType: "greeting"` go to the `fast` provider

3. **Call site** ([`src/index.ts:46`](src/index.ts#L46)) — `llm.generateText({ taskType: "greeting", prompt: "..." })`. No SDK types leak in. Returns typed text + usage + cost + latency.

## Cost gating in action

The example sets `cost:1/day` on the provider. Run it many times and watch — once you hit $1 of accumulated spend in the rolling 24h window, the call will throw `BudgetExceededError` instead of charging your card. Cost gating is enforced **before** the API call, not discovered on next month's invoice.

## Try it without an API key

There's no offline mode in this example by design — the point is to demonstrate a real call. If you want to see the wiring without spending tokens, the contract test suite at [`packages/adapter-anthropic/tests/contract.test.ts`](../../packages/adapter-anthropic/tests/contract.test.ts) exercises the same code paths against a mocked SDK.

## Next: multi-provider

Once you've seen this, look at [`examples/multi-provider`](../multi-provider/) for fallback chains across Anthropic + OpenAI.
