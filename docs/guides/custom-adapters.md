# Writing a Custom Adapter

The four bundled adapters cover OpenAI, Anthropic, Ollama, and Vercel AI SDK (with the OpenAI adapter's `baseURL` covering 10+ compatible providers). For genuinely-different APIs (Google Gemini, AWS Bedrock, Cohere, etc., until those land in v0.2/v0.3), you can write a custom adapter.

## What an adapter is

A function that returns an `AdapterRegistration`:

```ts
import type { AdapterRegistration, LLMPort, EmbeddingsPort, ModelPricing } from "@llm-ports/core";

export interface AdapterRegistration {
  /** Adapter name; matches the env config token (e.g. LLM_PROVIDER_FAST=mycorp|...) */
  name: string;
  /** Pricing table keyed by model id */
  pricing: Record<string, ModelPricing>;
  /** Build an LLMPort for a specific (modelId, alias) pair */
  createLLMPort?: (modelId: string, alias: string) => LLMPort;
  /** Optional: build an EmbeddingsPort. Omit if your provider has no embeddings */
  createEmbeddingsPort?: (modelId: string, alias: string) => EmbeddingsPort;
}
```

The factory pattern: register the adapter once at startup; the registry calls `createLLMPort(modelId, alias)` per task.

## Skeleton

```ts
import {
  computeChatCost,
  ProviderUnavailableError,
  type AdapterRegistration,
  type LLMPort,
  type ModelPricing,
} from "@llm-ports/core";

const PRICING: Record<string, ModelPricing> = {
  "mycorp-flagship": { inputPer1M: 5, outputPer1M: 15 },
};

export interface MyAdapterOptions {
  apiKey: string;
  baseURL?: string;
}

export function createMyAdapter(opts: MyAdapterOptions): AdapterRegistration {
  return {
    name: "mycorp",
    pricing: PRICING,
    createLLMPort: (modelId, alias) => createPort(opts, modelId, alias),
  };
}

function createPort(opts: MyAdapterOptions, modelId: string, alias: string): LLMPort {
  const pricing = PRICING[modelId];
  if (!pricing) {
    throw new Error(`No pricing for "${modelId}"`);
  }

  return {
    async generateText(options) {
      const start = Date.now();
      try {
        // 1. Translate options to your provider's API shape
        const body = {
          model: modelId,
          messages: [{ role: "user", content: stringifyPrompt(options.prompt) }],
          max_tokens: options.maxOutputTokens ?? 1024,
          temperature: options.temperature,
          system: options.instructions,
        };

        // 2. Call the provider's API
        const response = await fetch(`${opts.baseURL ?? "https://api.mycorp.com"}/v1/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();

        // 3. Translate the response back to llm-ports types
        const usage = {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        };
        return {
          text: data.message.content,
          usage,
          cost: computeChatCost(usage, pricing),
          modelId: data.model ?? modelId,
          providerAlias: alias,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        // Always wrap unknown errors in ProviderUnavailableError
        throw new ProviderUnavailableError(alias, err instanceof Error ? err : new Error(String(err)));
      }
    },

    // ... generateStructured, streamText, streamStructured, runAgent
  };
}
```

## Required: pass the contract test suite

Every llm-ports adapter must pass `@llm-ports/adapter-contract-tests`. This shared suite asserts adapter-agnostic invariants:

- `generateText` returns the expected shape, error propagation, latency populated
- `generateStructured` validates schema, retries with feedback on first-attempt failure, returns `validationAttempts`
- `streamText` yields chunks in order, iterator closes cleanly
- `streamStructured` yields progressively-complete partial objects
- `runAgent` returns the expected shape with `terminationReason`

Wire it up in your test file:

```ts
// packages/adapter-mycorp/tests/contract.test.ts
import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { setupMockHTTP } from "./helpers/mock-http.js";
import { createMyAdapter } from "../src/index.js";

runContractTests("mycorp", () => {
  const mock = setupMockHTTP();
  const adapter = createMyAdapter({
    apiKey: "test-key",
    baseURL: mock.url,
  });
  return {
    port: adapter.createLLMPort!("mycorp-flagship", "test-mycorp"),
    expectedAlias: "test-mycorp",
    expectedModelId: "mycorp-flagship",
    setupGenerateText: (r) => mock.respondWith({ ...r }),
    setupGenerateStructured: (r) => mock.respondWith({ ...r }),
    setupStreamText: (r) => mock.respondStream(r.chunks),
    setupStreamStructured: (r) => mock.respondStream([...]),
    setupRunAgent: (r) => mock.respondWith({ ...r }),
    setupNetworkError: (e) => mock.respondWithError(e),
  };
});
```

The mock-control surface (the `setup*` callbacks) is yours to implement against whatever HTTP mocking you prefer (`vi.mock`, [MSW](https://mswjs.io/), fetch injection, etc.).

## Required: pricing table

Cost gating only works if every model id has a pricing entry. Ship a `pricing.ts`:

```ts
// packages/adapter-mycorp/src/pricing.ts
//
// Source: https://mycorp.example.com/pricing
// Last verified: 2026-04-10 by @yourhandle
//
import type { ModelPricing } from "@llm-ports/core";

export const MYCORP_PRICING: Record<string, ModelPricing> = {
  "mycorp-flagship": { inputPer1M: 5, outputPer1M: 15 },
  "mycorp-mini":     { inputPer1M: 0.5, outputPer1M: 1.5 },
};
```

Users override via the registry's `pricingOverrides` option when prices change between releases. See [cost gating →](/guides/cost-gating).

## Optional: ModelManagement

If your provider exposes model management endpoints (list / pull / delete), implement the `ModelManagement` interface on the adapter object:

```ts
export function createMyAdapter(opts: MyAdapterOptions) {
  return {
    name: "mycorp" as const,
    pricing: PRICING,
    createLLMPort: (modelId, alias) => createPort(opts, modelId, alias),

    // Optional: ModelManagement methods at the adapter level
    async listModels() { /* ... */ },
    async pullModel(name, onProgress) { /* ... */ },
    async deleteModel(name) { /* ... */ },
    async checkHealth() { /* ... */ },
  };
}
```

Callers detect this via `if ("listModels" in adapter)`.

## Naming and publishing

- **First-party adapters use the `@llm-ports/*` scope.** Community adapters must use their own scope (e.g. `@yourorg/llm-ports-adapter-mycorp`). This is policy, not technical — the scope is reserved for first-party safety reasons.
- **Pricing data attribution.** Reproducing vendor pricing verbatim is OK under MIT, but include a source URL comment at the top of your `pricing.ts`.
- **Security disclosure.** If your adapter handles credentials, ship a `SECURITY.md` covering credential lifecycle and reporting process.

## Reading next

- [Adapter feature matrix →](/adapters/) — what existing adapters support
- [Adapter contract tests README →](https://github.com/baabakk/llm-ports/blob/main/packages/adapter-contract-tests/README.md)
