# @llm-ports/adapter-contract-tests

Internal-only package. Shared conformance test suite that every llm-ports adapter must pass.

**Not published to npm.** Distributed only to other packages in this monorepo via `workspace:*` dependencies.

## Usage from an adapter package

```typescript
// packages/adapter-anthropic/tests/contract.test.ts
import { runContractTests } from "@llm-ports/adapter-contract-tests";
import { createAnthropicAdapter } from "../src/index.js";
import { setupMockHTTP } from "./helpers/mock-http.js";

runContractTests("anthropic", async () => {
  const mock = setupMockHTTP();
  const adapter = createAnthropicAdapter({
    apiKey: "test-key",
    fetch: mock.fetch,
  });
  return {
    port: adapter.createLLMPort("claude-haiku-4-5", "test-anthropic"),
    expectedAlias: "test-anthropic",
    expectedModelId: "claude-haiku-4-5",
    setupGenerateText: (r) => mock.respondWith("messages", r),
    setupGenerateStructured: (r) => mock.respondWith("messages.structured", r),
    setupStreamText: (r) => mock.respondWith("messages.stream", r),
    setupStreamStructured: (r) => mock.respondWith("messages.stream-structured", r),
    setupRunAgent: (r) => mock.respondWith("messages.agent", r),
    setupNetworkError: (e) => mock.respondWithError(e),
  };
});
```

The adapter author is responsible for wiring the mock-control surface to whatever HTTP mocking they prefer (MSW, fetch injection, axios interceptors, etc.).

## What the suite covers

- `generateText`: result shape, error propagation
- `generateStructured`: schema validation, retry-with-feedback on first-attempt failures
- `streamText`: chunk ordering and clean iterator close
- `streamStructured`: progressively complete partial yields
- `runAgent`: result shape with terminationReason

Each test reuses the public LLMPort interface and asserts adapter-agnostic invariants. New invariants added here automatically apply to every adapter on the next CI run.
