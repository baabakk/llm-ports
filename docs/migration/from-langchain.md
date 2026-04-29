# Migrating from LangChain.js

::: warning Planned, not yet detailed
This page is a placeholder. A full migration guide ships with v0.2 alongside the LangChain interop adapter.
:::

## Why these are complementary, not competing

`llm-ports` is a utility, not a framework. LangChain.js is a framework with chains, agents, retrieval, memory, and prompt templates as first-class concepts. They solve different problems.

If you're using LangChain.js for chains and retrieval, you don't need to leave it. What you can do today is wrap LangChain's underlying LLM calls with an `llm-ports` port to get cost gating, fallback chains, and provider routing on top — without abandoning chains, retrievers, or vector stores.

## The pragmatic v0.1 pattern

LangChain's `ChatAnthropic` / `ChatOpenAI` / etc. take provider config in their constructors. You can't directly swap them for an `LLMPort`. But for the LLM-call segments of your pipeline, you can:

1. **Compute the prompt with LangChain** (templates, retrieval, chains).
2. **Hand it off to `llm-ports`** for the actual model call.
3. **Pass the result back** to LangChain for downstream chain steps.

```ts
import { llm } from "./llm-ports-setup.js";    // your llm-ports port

// ... LangChain chain that produces a final prompt string ...
const promptText = await myChain.format({ ... });

// LLM call goes through llm-ports for cost gating + fallback
const result = await llm.generateText({
  taskType: "draft",
  prompt: promptText,
});

// Continue downstream with LangChain (output parsing, memory, etc.)
await myChain.parseOutput(result.text);
```

You lose some of LangChain's abstractions for the LLM call itself (the chain doesn't know about `llm-ports`), but you gain the production primitives `llm-ports` ships.

## What v0.2 adds

`@llm-ports/adapter-langchain` will provide a `BaseChatModel` subclass that you can drop into LangChain chains as if it were `ChatAnthropic` / `ChatOpenAI`. Underneath, it routes to `llm-ports`. That gets you:

- LangChain's chains, retrievers, vector stores — unchanged
- `llm-ports`'s cost gating, fallback chains, capability factories — applied to every LLM call

Until v0.2 ships, the manual pattern above is the bridge.

## Reading next

- [Migrating from a direct SDK →](/migration/from-direct-sdk)
- [`llm-ports` philosophy →](/why)
