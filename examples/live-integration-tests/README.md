# `live-integration-tests`

Four small `.mjs` scripts that exercise the full `LLMPort` surface against **real** provider APIs (no mocks). Used to close Gate C of the publishing checklist and as a reproducible bake before each prerelease bump.

## Why these exist

The workspace's `vitest` suite covers ~252 offline tests with mocked SDKs. That's enough to catch regression in the adapter logic but it cannot prove:

1. The exact wire format we send is accepted by the real provider
2. The cost numbers we report against real `gpt-4o-mini` / `claude-haiku-4-5` are sane
3. The retry-with-feedback strategy recovers from real schema-adherence failures
4. The Zod-to-JSON-Schema conversion in `runAgent` produces a schema the real provider can consume

These scripts cover the gap. Each script's cost is well under a cent; running the whole suite costs about a quarter of a cent.

## Scripts

| Script | What it proves | Required env | Approx cost |
|---|---|---|---|
| [`live.mjs`](./live.mjs) | `generateText` + `generateStructured` against `gpt-4o-mini` via `@llm-ports/adapter-openai`. Asserts cost reporting, model id echo, and that retry-with-feedback fires when the first JSON misses the schema. | `OPENAI_API_KEY` | $0.0001 |
| [`live-multi-provider.mjs`](./live-multi-provider.mjs) | Two-alias OpenAI fallback chain: TIGHT is over its sub-cent daily budget, LOOSE is fine. Registry walks TIGHT → LOOSE, returns `providerAlias='loose'`. | `OPENAI_API_KEY` | $0.00001 |
| [`live-anthropic.mjs`](./live-anthropic.mjs) | `generateText` + `generateStructured` + **`runAgent` with a Zod tool schema** against `claude-haiku-4-5`. The tool-use call is the highest-value test in the suite — it proves the alpha.1 Zod-to-JSON-Schema fix works against Anthropic's real Messages API, not just against the mocked SDK. | `ANTHROPIC_API_KEY` | $0.002 |
| [`live-cross-adapter-chain.mjs`](./live-cross-adapter-chain.mjs) | Real cross-adapter fallback: Anthropic primary (budget-exhausted) → OpenAI fallback. Proves the registry walks across DIFFERENT adapter implementations, not just across aliases of the same one. | both keys | $0.00001 |

## Run

From the repo root:

```bash
# Single script
OPENAI_API_KEY=sk-...   pnpm -F @llm-ports/example-live-integration-tests smoke
ANTHROPIC_API_KEY=sk-ant-...   pnpm -F @llm-ports/example-live-integration-tests smoke:anthropic

# All four (needs both keys)
OPENAI_API_KEY=sk-...   ANTHROPIC_API_KEY=sk-ant-...   pnpm -F @llm-ports/example-live-integration-tests smoke:all
```

Or directly inside this directory:

```bash
cd examples/live-integration-tests
OPENAI_API_KEY=sk-... node live.mjs
```

## Why workspace deps, not pinned npm versions

These scripts run against the **local** workspace via `workspace:*`. That means a `pnpm install` at the repo root wires in whatever's in `packages/*/src/`, NOT what's currently published to npm.

That's a deliberate trade-off:

- **Pro**: every PR that touches the adapter source is exercised by these scripts in CI (when CI for live tests lands).
- **Con**: a successful run here does NOT prove the published artifacts work. The build step might transform the code in a way that breaks at publish time but not at workspace runtime.

To test the **published** artifacts (the strictly-stronger smoke), keep a separate tiny project outside the workspace with **pinned** npm versions, like:

```json
{
  "dependencies": {
    "@llm-ports/core": "0.1.0-alpha.2",
    "@llm-ports/adapter-openai": "0.1.0-alpha.2",
    "@anthropic-ai/sdk": "^0.32.1",
    "openai": "^4.73.0",
    "zod": "^3.25.76"
  }
}
```

…and copy whichever of the four scripts you want to run. Bump the pinned versions every release. This is what the `e:/tmp/llm-ports-smoke/` setup did for the alpha.1 / alpha.2 ship verification.

## What each script exits with

All four scripts:

- Exit `0` on success (every assertion passed)
- Exit non-zero on failure with a `✗ FAIL:` message naming what broke

`live-anthropic.mjs` will still exit `0` even if `generateStructured` throws a typed `ValidationError` — that's the typed-error surface working as designed (the registry can route to a fallback on `ValidationError`). The script logs it as `⚠ generateStructured threw ValidationError` and continues.

## Known model quirks observed

| Model | Quirk | Workaround |
|---|---|---|
| `claude-haiku-4-5` | Occasionally drops `z.string().min(N)` fields entirely on first attempt — even retry-with-feedback doesn't always recover when the prompt is generic | Use an explicit "ALWAYS include the X field" instruction in the prompt, OR rely on the typed `ValidationError` being caught and routed to a fallback model |
| `gpt-4o-mini` | Sometimes returns extra fields not in the Zod schema (Zod ignores them by default) | None needed — schema strictness via `.strict()` on the Zod object surfaces the extras as validation errors if you care |

These are noted in [`/v0-1-status`](https://baabakk.github.io/llm-ports/v0-1-status) under "Adapter-specific quirks".

## Adding a new test

The scripts share a simple shape:

1. Read API key(s) from `process.env`
2. Build a registry with a minimal env config
3. Make 1-3 calls
4. Assert what you care about, `process.exit(0)` or `process.exit(1)`

No test framework. No DOM. No build step. Easy to read top-to-bottom and copy as a starting point.
