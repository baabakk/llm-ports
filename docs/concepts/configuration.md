# Configuration: environment variables or an object

There are two ways to tell the registry which providers exist and which one each task should use. They describe the same thing and produce the same `RegistryConfig`. The difference worth knowing is small and easy to trip over: **where the provider's alias comes from.**

## The alias is the name your code routes by

A provider alias is the short name a task route points at, and the name that appears in a `providerAlias` field on every result, every observability event and every error. It is yours to choose. It is not the adapter's name and not the model's id, which is what lets two aliases share one adapter with different models and different spending caps.

## Environment form: the alias comes from the variable name

```bash
LLM_PROVIDER_FAST=openai|gpt-5-mini|cost:5/day
LLM_PROVIDER_LOCAL=ollama|llama3.3|unlimited
LLM_TASK_ROUTE_TRIAGE=fast,local
```

That declares two aliases, `fast` and `local`, and one task whose chain tries `fast` first and falls back to the local runtime. The part after `LLM_PROVIDER_` **becomes** the alias, lowercased, with underscores turned into hyphens, so `LLM_PROVIDER_FAST_LOCAL` declares the alias `fast-local`.

The consequence is the one people hit: **an alias from the environment can only contain what a variable name can contain.** No slashes, no dots, no capitals. Model ids routinely contain all three (`Qwen/Qwen3.7-Max`, `openai/gpt-oss-120b`), so a habit of naming the alias after the model breaks as soon as the model id is not a legal variable name. Pick a short alias that says what the provider is for, and let the model id live in the value where it has no such limit.

## Object form: the alias is an explicit key

```ts
import { createRegistryFromEnv } from "@llm-ports/core";

export const registry = createRegistryFromEnv({
  adapters: { openai: openaiAdapter, ollama: ollamaAdapter },
  config: {
    providers: {
      fast: {
        alias: "fast",
        adapter: "openai",
        modelId: "gpt-5-mini",
        budgetLimit: { kind: "unlimited" },
        costLimit: { kind: "usd", perDay: 5 },
      },
      "qwen-max": {
        alias: "qwen-max",
        adapter: "openai",
        modelId: "Qwen/Qwen3.7-Max",
        budgetLimit: { kind: "unlimited" },
        costLimit: { kind: "unlimited" },
      },
    },
    taskRoutes: { triage: ["fast", "qwen-max"] },
  },
});
```

Here the alias is the object key, so it carries no naming restriction at all, and the model id is plainly a value rather than something squeezed through a variable name. This is the form to reach for when model ids are namespaced, when configuration arrives from a database or a control plane rather than from a shell, or when you want the whole routing table in one reviewable literal.

Three details this form makes you state that the environment form fills in for you:

- **`budgetLimit` and `costLimit` are both required**, and `{ kind: "unlimited" }` is how you say there is no cap. The environment form writes `unlimited` for whichever of the two your gating string leaves out.
- **The limit fields are per-window rather than a window name**: `{ kind: "usd", perDay: 5 }`, with `perMinute`, `perHour`, `perDay` and `perMonth` available and combinable.
- **`alias` is required inside the entry, and the key is what actually counts.** The registry reads the key and ignores the field, so `{ fast: { alias: "quick", ... } }` yields a provider known everywhere as `fast` and quietly discards `"quick"`. Write the same string twice until that redundancy is removed at the next major version.

`config` takes precedence over `env`. Supplying both does not merge them: the object wins outright, which keeps "where did this route come from" answerable.

## Neither form is the recommended one

Environment variables suit a deployment whose routing is set by whoever runs the process, which is most services. The object suits a program that computes its routing, and it is the only form that can express every model id. Projects commonly use the environment in production and the object in tests, and nothing about the registry treats one as primary.

## What happens when the two disagree with reality

A route can name an alias that does not exist, and an alias can name an adapter that was never registered. Rather than failing at the first call that happens to touch the gap, the registry reconciles the configuration when it is constructed:

- **An alias whose adapter is not registered is dropped**, with a warning naming the alias, the missing adapter and the adapters that are available.
- **A route link naming an unknown alias is removed from that chain**, with a warning, and the rest of the chain still works.
- **A task left with no usable providers is removed**, with a warning saying calls to it will report no configured route.

Each warning fires once per process rather than per call, so a misconfiguration is visible without flooding a log.

This is deliberately forgiving, because a partial deployment is common: a key for one provider is missing, and everything routed elsewhere should still run. When you would rather know immediately, pass `strictConfig: true` and each of those three cases throws `ConfigError` at construction instead.

## Reading next

- [Task routing](/concepts/task-routing) for how a chain is walked and when it moves on
- [Cost gating in production](/guides/cost-gating) for what the gating part of a provider entry means
- [Multi-provider routing](/guides/multi-provider) for choosing what goes in a chain
