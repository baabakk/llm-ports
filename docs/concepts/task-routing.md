# Task Routing

`llm-ports` separates **what you want done** (a task type) from **how it gets done** (which model, which provider, with what budget). Application code names the task; configuration names the provider.

## Anatomy of a routing decision

```ts
await llm.generateText({
  taskType: "triage",      // <-- the only routing input from app code
  priority: 2,              // optional: 0=critical, 3=low (default 2)
  prompt: "...",
});
```

The registry resolves `taskType: "triage"` like this:

1. Look up `LLM_TASK_ROUTE_TRIAGE` in env config → e.g. `"fast,smart"` (a fallback chain)
2. Walk the chain in order. For each alias:
   - Is it registered? (i.e. matches an `LLM_PROVIDER_*` entry)
   - Is its adapter loaded? (i.e. supplied to `createRegistryFromEnv` under `adapters: {...}`)
   - Is its budget intact this hour? (request-count gating, if configured)
   - Is its cost cap intact? (USD gating, if configured)
   - Does it have pricing for the model id? (or a `pricingOverride`)
3. First alias that passes all checks gets the call.
4. If no alias passes, throw `NoProvidersAvailableError` with a per-alias reason map.

P0 (critical) priority bypasses budget + cost gating. P1, P2, P3 all respect gating.

## Task types are application-defined strings

```ts
export type TaskType = string;
```

Intentionally open. `llm-ports` doesn't impose a vocabulary. Your application defines what task types exist:

```bash
LLM_TASK_ROUTE_TRIAGE=fast,smart
LLM_TASK_ROUTE_DRAFT=premium
LLM_TASK_ROUTE_RESEARCH=premium,fast
LLM_TASK_ROUTE_BULK_CLASSIFY=fast
LLM_TASK_ROUTE_TONE_DRAFT=premium
LLM_TASK_ROUTE_CODE_REVIEW=premium
```

The cost: untyped strings at the call site lose autocomplete. The recovery: opt-in with `declareTasks`.

## `declareTasks<T>()` — opt-in type safety

```ts
import { declareTasks } from "@llm-ports/core";

export const tasks = declareTasks({
  triage:        { priority: 1, defaultTemperature: 0 },
  draft:         { priority: 2, defaultTemperature: 0.4 },
  research:      { priority: 2, defaultTemperature: 0.2 },
  bulkClassify:  { priority: 3, defaultTemperature: 0 },
});

// Now at call sites:
await llm.generateText({
  taskType: tasks.triage,         // typed as the literal "triage", not string
  prompt: "...",
});

await llm.generateText({
  taskType: tasks.tirage,         // ❌ TypeScript error: typo caught
  prompt: "...",
});
```

`tasks.triage` evaluates to the string `"triage"` at runtime. The type system narrows it to the literal — autocomplete, typo protection, refactor safety.

The registry doesn't know about `declareTasks`; it still sees a plain string. The helper is purely a DX win for application code.

## Catch-all task: `general`

If no task type matches a configured route, the registry falls back to `LLM_TASK_ROUTE_GENERAL`:

```bash
LLM_TASK_ROUTE_GENERAL=fast,smart
```

Useful as a safety net while you're still wiring up specific routes. Without `general` and without a matching route for the requested task, calls throw `NoProvidersAvailableError`.

## How capability factories route

The capability factories (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) each use a default task type matching their canonical name. So `createClassifier(...)` calls hit `LLM_TASK_ROUTE_CLASSIFY`, `createDrafter(...)` hits `LLM_TASK_ROUTE_DRAFT`, etc.

Default mapping:

| Factory | Default `taskType` | Env route to configure |
|---|---|---|
| `createClassifier` | `"classify"` | `LLM_TASK_ROUTE_CLASSIFY` |
| `createScorer` | `"score"` | `LLM_TASK_ROUTE_SCORE` |
| `createDrafter` | `"draft"` | `LLM_TASK_ROUTE_DRAFT` |
| `createSummarizer` | `"summarize"` | `LLM_TASK_ROUTE_SUMMARIZE` |
| `createExtractor` | `"extract"` | `LLM_TASK_ROUTE_EXTRACT` |
| `createPlanner` | `"plan"` | `LLM_TASK_ROUTE_PLAN` |
| `createAnalyzer` | `"analyze"` | `LLM_TASK_ROUTE_ANALYZE` |

Two ways to wire your registry to these:

**Option 1 — set `LLM_TASK_ROUTE_GENERAL` as a universal catch-all.** Simplest. Every capability falls through to your `general` chain.

```bash
LLM_TASK_ROUTE_GENERAL=fast,smart
```

**Option 2 — give each capability its own route.** Lets you apply different fallback chains, cost caps, or model preferences per capability (e.g., cheap-fast for classify, smarter for draft).

```bash
LLM_TASK_ROUTE_CLASSIFY=fast
LLM_TASK_ROUTE_DRAFT=smart,fast
LLM_TASK_ROUTE_EXTRACT=fast,smart
```

**Option 3 — override `taskType` at factory construction.** Each capability factory accepts an optional `taskType` config so you can route a specific instance through a custom task name:

```ts
const classifyTickets = createClassifier({
  port: llm,
  schema: TicketSchema,
  schemaName: "ticket-intent",
  taskType: "ticket-triage",   // routes via LLM_TASK_ROUTE_TICKET_TRIAGE
  // ...
});
```

Useful when you have multiple instances of the same factory with different routing needs (e.g., one classifier for customer emails on a tight budget, another for internal logs on a generous budget).

## Priority tiers (0-3)

| Priority | Meaning | Behavior |
|----------|---------|----------|
| **0** | Critical | Bypasses budget + cost gating. Use for compliance, security alerts, urgent triage. |
| **1** | High | Respects gating. Used for production-critical tasks where you want gating but accept that quota issues might block them. |
| **2** | Normal | Default. Same gating behavior as 1. The distinction with 1 is for future "queue if quota exhausted" features. |
| **3** | Low | Same gating behavior as 1, 2. Distinction with 2 is for future "skip if quota exhausted" features (P3 tasks may simply skip rather than fail). |

For v0.1, the only priority that actually changes runtime behavior is P0 (bypasses gating). The others are reserved for future scheduling-aware features.

## Inspecting routing topology

```ts
registry.listProviders();
// Each provider's alias, adapter, modelId, gating limits

registry.listTasks();
// Each task type's name and fallback chain
```

Useful for admin UIs, runtime debugging, "show me where this task would route" features.

## Reading next

- [Cost vs request gating →](/concepts/cost-vs-request-gating) — how gating decisions are made
- [Multi-provider routing guide →](/guides/multi-provider) — practical patterns
