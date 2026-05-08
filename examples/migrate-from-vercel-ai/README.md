# `@llm-ports/example-migrate-from-vercel-ai`

If you already use `ai` + `@ai-sdk/*`, you don't need to rewrite your code to add fallback chains, USD cost gating, and capability factories. There are two migration paths, both demonstrated here.

## Files in order

1. **[`src/before-vercel-direct.ts`](src/before-vercel-direct.ts)** — what your code looks like today on Vercel AI SDK
2. **[`src/after-wrap-path.ts`](src/after-wrap-path.ts)** — Path A: wrap your existing model factories with `@llm-ports/adapter-vercel`
3. **[`src/after-migrate-path.ts`](src/after-migrate-path.ts)** — Path B: replace `@ai-sdk/*` with native llm-ports adapters

## Run them

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# Before — direct Vercel SDK
pnpm --filter @llm-ports/example-migrate-from-vercel-ai before

# After (Path A) — keeps your @ai-sdk/* imports, adds llm-ports registry
pnpm --filter @llm-ports/example-migrate-from-vercel-ai after-wrap

# After (Path B) — drops @ai-sdk/* entirely
pnpm --filter @llm-ports/example-migrate-from-vercel-ai after-migrate
```

All three should print classification + summary output. The difference is what's underneath.

## Path A: WRAP your existing code (lowest friction)

Total change: add the registry setup at app boot. Each call site becomes a one-line search-and-replace from `generateText({ model, prompt, ... })` to `llm.generateText({ taskType, prompt, ... })`.

### Setup file (one place in your app, ~15 lines)

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createVercelAdapter } from "@llm-ports/adapter-vercel";

const vercelAdapter = createVercelAdapter({
  models: {
    "claude-haiku-4-5": anthropic("claude-haiku-4-5"),  // ← your existing factories
    "gpt-4o-mini": openai("gpt-4o-mini"),
  },
  pricing: {
    "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
});

export const llm = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "vercel|claude-haiku-4-5|cost:5/day",
    LLM_PROVIDER_BACKUP: "vercel|gpt-4o-mini|cost:10/day",
    LLM_TASK_ROUTE_CLASSIFY: "primary,backup",
  },
  adapters: { vercel: vercelAdapter },
}).getPort();
```

### Call site change (per file)

```diff
- import { generateText } from "ai";
- import { anthropic } from "@ai-sdk/anthropic";
- const model = anthropic("claude-haiku-4-5");
+ import { llm } from "./llm-setup";

  async function classifyEmail(body: string) {
-   const result = await generateText({
-     model,
+   const result = await llm.generateText({
+     taskType: "classify",
      prompt: `Classify... ${body}`,
      maxOutputTokens: 50,
    });
    return result.text.trim().toLowerCase();
  }
```

That's it. The call site shape (prompt + maxOutputTokens) is identical; the model object is gone, replaced by a `taskType` that the registry maps to your fallback chain.

**What you get for free:** fallback chain (primary → backup), USD cost gating, validation recovery (for `generateStructured`), capability factories (drop-in `createClassifier`, `createDrafter`, etc. on the same `llm` port), per-call `cost.totalUSD` / `latencyMs` / `providerAlias`.

**What you don't change:** your `anthropic("...")` and `openai("...")` model factories, your `ai` and `@ai-sdk/*` deps.

## Path B: MIGRATE off Vercel SDK entirely

Use this if you're using `ai` only for the `generateText` / `streamText` primitives — not React Server Components, `streamUI`, or `useChat`. You drop two npm deps (`ai`, `@ai-sdk/*`) and gain provider-native features (Anthropic prompt caching, OpenAI's reasoning-model auto-recovery for o-series + Cerebras compat, etc.).

### Setup file change

```diff
- import { anthropic } from "@ai-sdk/anthropic";
- import { openai } from "@ai-sdk/openai";
- import { createVercelAdapter } from "@llm-ports/adapter-vercel";
+ import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
+ import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

  export const llm = createRegistryFromEnv({
    env: {
-     LLM_PROVIDER_PRIMARY: "vercel|claude-haiku-4-5|cost:5/day",
-     LLM_PROVIDER_BACKUP: "vercel|gpt-4o-mini|cost:10/day",
+     LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",
+     LLM_PROVIDER_BACKUP: "openai|gpt-4o-mini|cost:10/day",
      LLM_TASK_ROUTE_CLASSIFY: "primary,backup",
    },
    adapters: {
-     vercel: vercelAdapter,
+     anthropic: createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }),
+     openai: createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
    },
  }).getPort();
```

### Call site change

**None.** Path A and Path B produce identical call sites. The migration is invisible to your business logic; the only file that changes is your registry setup.

## Hybrid: wrap path for RSC, migrate path for backend

Many real Next.js apps end up with this shape. Vercel SDK has React-specific features (`streamUI`, `useChat`, RSC integration) that benefit from staying on `@ai-sdk/*`. Backend services don't need any of that.

Sketch:

```ts
// app/api/chat-rsc/route.ts — uses the wrap path so RSC features keep working
import { llm } from "@/lib/llm-via-vercel";

// services/email-triage.ts — uses native adapters for backend efficiency
import { llm } from "@/lib/llm-native";
```

Two registries, one app. Each call site uses whichever shape matches its needs.

## Comparison table

| Concern | Vercel-direct (before) | Wrap path (Path A) | Migrate path (Path B) |
|---|---|---|---|
| Fallback chain | manual | ✓ | ✓ |
| USD cost gating | manual | ✓ | ✓ |
| Validation recovery for structured output | manual | ✓ | ✓ |
| Capability factories | not available | ✓ | ✓ |
| Provider-native features (Anthropic prompt caching, OpenAI reasoning) | abstracted | abstracted | ✓ direct |
| `ai` + `@ai-sdk/*` deps | ✓ | ✓ kept | dropped |
| React/RSC integration (Next.js useChat etc.) | ✓ | ✓ kept | requires RSC-specific code path |
| Files changed in your codebase | — | 1 (registry setup) + per-file 1-line edit | 1 (registry setup) + per-file 1-line edit (same as A) |

## When NOT to migrate

If your only LLM code is a single `generateText` call in a Next.js Route Handler that uses `streamUI` for the response, and you don't have multi-provider or cost-gating needs, the migration's value is small. Wait until you have at least one of: multi-provider, cost cap, capability reuse, or fallback resilience.
