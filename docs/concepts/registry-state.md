# What a Registry holds, and what it shares

A single question this page exists to answer: **if I construct two Registry instances, what do they share and what do they not?**

Until alpha.31.1 that was only answerable by reading `registry.ts`, and one class of defect came directly from the ambiguity. This page is the answer.

## The short version

| State | Default | Injectable? | Option |
|---|---|---|---|
| Parsed configuration | Per instance | Not applicable | Derived from `env` at construction |
| Request-count budgets | Per instance | **Yes** | `budget` |
| USD cost accounting | Per instance | **Yes** | `cost` |
| Authentication history | Per instance | **Yes** (alpha.31.1+) | `auth` |
| Task defaults | Per instance | Not applicable | `taskDefaults` |
| Instrumentation | Per instance | Not applicable | `instrumentation` |

**Nothing is shared between Registry instances by default.** Every one of the three injectable stores defaults to a fresh private instance. Sharing is always something you opt into by constructing the backend yourself and passing it to each Registry.

## Most applications should hold exactly one Registry

Create it once at startup and hold the port as a singleton. This is the [getting-started](../getting-started.md) advice and it remains correct: with one instance, none of this page matters.

The page matters when you have a reason to hold more than one.

## Why you might hold more than one, and what to do about it

**Per-tenant credentials.** One Registry per tenant, same provider aliases, different API keys. This is the case that most needs `auth` shared, and the one that motivated the option.

**Different configuration for different work.** Historically some consumers built a second Registry purely to give one route a longer per-attempt timeout. **Since alpha.30 you do not need a second instance for that**: `taskDefaults` expresses per-task configuration on a single Registry, which is simpler and avoids every question on this page.

If you are about to construct a second Registry, check `taskDefaults` first. It removes the most common reason.

## Authentication state, and why sharing it matters

Since alpha.30 the Registry tracks which provider aliases have ever authenticated successfully. That single fact decides how an authentication failure is handled:

- Alias has **never** authenticated: the credential is simply dead, so walk to the next provider in the chain.
- Alias **has** authenticated before: something changed underneath the process, such as a revoked key or a downgraded plan. Abort loudly rather than quietly degrading onto a fallback, because silent degradation hides an outage.

That is the right behaviour, and it depends entirely on the instance's own history. Two Registries hold two independent histories, so **the same credential failing on the same alias can be classified differently by each**, decided by whichever authenticated first. Nothing logs it and nothing fails loudly.

Share the backend when the instances should agree:

```ts
import { createRegistryFromEnv, InMemoryAuth } from "@llm-ports/core";

const auth = new InMemoryAuth();

const tenantA = createRegistryFromEnv({ adapters, env: envA, auth });
const tenantB = createRegistryFromEnv({ adapters, env: envB, auth });
```

`Registry.auth` is public, so you can inspect it or seed it. A deployment that already knows a key is good can say so without making a call first:

```ts
auth.markAuthenticated("openai-primary");
```

Any implementation of the interface works:

```ts
import type { AuthBackend } from "@llm-ports/core";

const backend: AuthBackend = {
  hasEverAuthenticated: (alias) => myStore.has(alias),
  markAuthenticated: (alias) => myStore.add(alias),
};
```

### It is synchronous, deliberately, and that has a limit

`AuthBackend` is synchronous while `budget` and `cost` are asynchronous. That is not an oversight. `Registry.hasEverAuthenticated()` is a public synchronous method, and the value is read inside error classification, which is a synchronous decision path. An async interface would have been a breaking change and would have pushed `await` into error handling for a set-membership test.

The consequence is a real scope limit, worth stating plainly: **a synchronous backend can share state between instances in one process. It cannot perform a blocking read against a shared external store.** A horizontally-scaled deployment still has each process learn independently which credentials work.

The practical effect is bounded. Each process converges after its own first successful call per alias, and revocation is still detected per process rather than missed. An implementation may serve a locally-cached snapshot that some other mechanism refreshes, but that refresh is the implementation's concern, not this interface's. A genuinely asynchronous variant is open work, tracked as `TD-LLMPORTS-AUTH-STATE-CROSS-PROCESS`.

## Budget and cost

Both take injectable backends for the same reason and with the same default. Two Registries each get their own counters unless you pass one backend to both, which means per-provider request limits and USD ceilings are enforced **per instance** by default.

If you hold one Registry per tenant and want a fleet-wide daily spend ceiling rather than a per-tenant one, share the `cost` backend. If you want per-tenant ceilings, do not.

```ts
import { createRegistryFromEnv, InMemoryBudget, InMemoryCost } from "@llm-ports/core";

const budget = new InMemoryBudget();
const cost = new InMemoryCost();
const a = createRegistryFromEnv({ adapters, budget, cost });
const b = createRegistryFromEnv({ adapters, budget, cost });
```

All three in-memory implementations are process-local and reset on restart. Durable or cross-process accounting means implementing the interface over your own store.

## Rule of thumb

If two Registries should agree about something, pass one backend to both. If they should be isolated, which is the case for per-tenant budgets, do nothing.

The failure mode to avoid is assuming isolation you did not ask for, or sharing you did not arrange. The defaults isolate.
