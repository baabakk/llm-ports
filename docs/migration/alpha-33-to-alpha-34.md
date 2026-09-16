# alpha.33 to alpha.34

**Title marker: `TS-BREAKING: cost, AdapterRegistration.pricing`.** Configuration that survives an incomplete deployment: a missing API key no longer takes every provider down, models nobody is cost-gating no longer need a price, core is now a peer dependency, and three outages that were documented to fail over now do.

```bash
pnpm add @llm-ports/core@0.1.0-alpha.34
```

Upgrade every `@llm-ports/*` package together.

## What changed

| Change | Who it affects | Impact |
|---|---|---|
| `cost` is optional on results and events | Anyone reading `result.cost` | **TypeScript-strict break.** Guard before reading. Codex and Aider results now omit it at runtime too. |
| `AdapterRegistration.pricing` can be `"free"` | Anyone reading `adapter.pricing[...]` directly | **TypeScript-strict break.** Check for `"free"` first. |
| Core is a peer dependency of the adapters and capabilities | Anyone installing an adapter | Install `@llm-ports/core` directly, which most setups already do. |
| An unregistered adapter no longer fails construction | Deployments holding only some API keys | Behaviour change. That provider is skipped with a warning. |
| Unpriced models route on aliases with no cost cap | Anyone who relied on the refusal | Behaviour change. |
| Unknown cost is omitted from telemetry instead of reported as zero | Dashboards that sum cost | Behaviour change. See below. |
| A 5xx, an empty response and an unreachable provider now fail over | Anyone with a fallback chain | Behaviour change, and a fix. See below. |

## `cost` is optional

Every result that carried `cost: CostUsage` now carries `cost?: CostUsage`: text, structured and agent results, embedding results, the streamed-completion metadata, the capability event, and the observability contract's attempt-completed event.

**With one exception, it is absent only where it could never have been present before.** A model with no known price on an alias with no cost cap used to be refused outright, so for the core adapters no configuration that works today starts returning `undefined`.

**The exception is `@llm-ports/adapter-codex` and `@llm-ports/adapter-aider`.** They used to report an explicit zero cost on every call, which was never true, and now report none. If you read `cost` from either, it will be `undefined` after upgrading.

```ts
// Before
recordSpend(result.cost.totalUSD);

// After
if (result.cost) recordSpend(result.cost.totalUSD);
```

**Do not replace it with `?? 0` when totalling.** `undefined` means the price is unknown, not that the call was free. Coalescing to zero makes a total look complete when it is not, which is exactly what this change exists to prevent. Skip unknown rows, or count them separately.

## `AdapterRegistration.pricing` can be `"free"`

An adapter can declare `pricing: "free"` instead of a table, for a runtime that never bills and whose model set cannot be listed in advance.

```ts
// Before: breaks the type check now
const rate = adapter.pricing[modelId];

// After
const rate = adapter.pricing === "free" ? undefined : adapter.pricing[modelId];
```

## Core is a peer dependency

The adapter packages and `@llm-ports/capabilities` previously pinned an exact version of `@llm-ports/core` as their own dependency. Any version difference between your core and an adapter's therefore installed **two copies**, and because the error taxonomy is checked with `instanceof`, every fallback decision then returned false. **Failover silently stopped**, with no error and no log line.

Core is now a peer dependency with a caret range. Make sure your project depends on `@llm-ports/core` directly:

```bash
pnpm why @llm-ports/core    # expect exactly one version
```

Recent npm and pnpm install peers automatically; older setups may need the explicit dependency.

**Errors also survive a duplicate copy now**, if one happens anyway. `instanceof` checks against any `@llm-ports/core` error class recognise an error thrown by another copy. TypeScript narrowing after `instanceof` is unchanged.

If you define your own error class extending one of ours, nothing changes for you: your class is matched by the ordinary check.

## An unregistered adapter no longer fails construction

A provider whose adapter is not in `adapters` is now **dropped with a warning**, and removed from every chain that named it. The other providers keep working. Previously the first such provider made the constructor throw, so a deployment holding eight of nine API keys served nothing.

The constructor still throws when nothing usable is left.

To restore the old behaviour:

```ts
createRegistryFromEnv({ env, adapters, strictConfig: true });
```

If you had written a pre-filter to remove keyless providers before constructing the registry, you can delete it.

## Unpriced models, and `pricingPolicy`

A model with no known price is now routed normally on an alias **with no cost cap**, reporting `cost` as `undefined`. On an alias **with** a cost cap it is still refused by default, because a budget cannot be enforced against a price nobody has.

`pricingPolicy` governs only that second case:

| Value | On a cost-capped alias with no known price |
|---|---|
| `"throw"` (default) | Refuse the alias, as before |
| `"warn"` | Admit it, warn once per model, report `cost` as `undefined` |
| `"silent"` | Admit it without a warning |

If you had assigned placeholder prices so that unpriced models would route, you can remove them. They are now worse than nothing: on a cost-capped alias, a placeholder is a budget input nobody chose.

## Configuring without environment variables

`RegistryOptions.config` accepts a `RegistryConfig` object and takes precedence over `env`. Environment configuration is unchanged and remains the default. The object form exists because a provider alias is derived from the environment variable's own name, which cannot contain `/`, `.` or capitals, so model ids such as `Qwen/Qwen3.7-Max` could not be named directly.

## Failover now happens where it was documented to

Three failures that the documentation said would move on to the next provider did not.

| Failure | Nothing set | `"aggressive"` | `defaultShouldFallback` |
|---|---|---|---|
| Provider HTTP 5xx | now walks | now walks | already walked |
| Empty response | now walks | already walked | already walked |
| Ollama not running, or Google endpoint unreachable | now walks | now walks | now walks |
| A content block the provider cannot carry | already walked | now walks | already walked |

"Walks" means the registry tries the next provider in the chain.

**The 5xx case is the one most deployments will notice.** Since alpha.18 a provider 5xx has been wrapped as `ServiceUnavailableError`, and the two policies most people run named only its subclasses. A 502, 503 or 504 therefore came back to your code even with a healthy second provider configured.

**The unreachable case was reported as the wrong kind of error.** `ollama` and `@google/genai` pass a network failure through as `TypeError: fetch failed`, and the shared error wrapper classified every `TypeError` as a bug in the adapter. You would have seen `AdapterInternalError` for a daemon that simply was not running. It is now `ProviderUnavailableError`. A `TypeError` from anything other than a failed fetch is still reported as an adapter bug and still stops the chain.

If your code caught these errors to retry or reroute them itself, the registry now does it first. To keep handling them yourself, set `runtimeFallback: "none"`, or pass your own predicate. The [multi-provider guide](/guides/multi-provider#which-errors-move-on-to-the-next-provider) lists what each policy does.

**If you maintain an adapter**, wrap failures with `wrapProviderError(alias, err, modelId)` rather than constructing `ProviderUnavailableError` for everything. The blanket form makes a bad request or a revoked key fail over too.

## Check your dashboards

**Unknown cost is now omitted rather than reported as zero**, in results, in the `onCost` hook, and on the attempt-completed event. The `onCost` hook does not fire at all for a call whose price is unknown.

Two sources of false zeros are gone:

- The instrumentation layer substituted zero cost whenever an adapter reported none.
- `@llm-ports/adapter-codex` and `@llm-ports/adapter-aider` reported an explicit zero on every call, because the command-line tools they drive do not say what a run cost. They now report no cost.

A spend total that previously included those zeros was under-counting without saying so. After upgrading it may show fewer cost rows. **That is the numbers becoming honest, not calls going missing.** Token counts are unaffected and are still emitted for every call.

## New in this release

- `RegistryOptions.config`, `strictConfig`, `pricingPolicy`
- `AdapterRegistration.pricing: "free"`
- `conservativeShouldFallback`, the policy an unconfigured registry actually uses, now exported and named. The existing `defaultShouldFallback` is a broader table that applies only when you pass it explicitly; the two names had been easy to confuse.
- `computeChatCostOptional` and `computeEmbeddingCostOptional`
