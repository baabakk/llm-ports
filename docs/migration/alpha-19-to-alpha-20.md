# Migrating from alpha.19 (or alpha.19.1) to alpha.20

> **One small TypeScript-level breaking change.** Runtime behavior is identical; the `.env` grammar is fully backwards compatible. The break is at the type-read level on a single field. Most callers will see zero TypeScript errors. The exception: code that introspects a parsed `BudgetLimit` and reads `requestsPerHour` in strict mode.

`alpha.20` is the fourth and last shape-lock before `beta.0` on 2026-06-30. It adds the five-tier `BudgetScope` hierarchy, the minute window (`req:N/minute`, `cost:N/minute`), and four session-grain ceiling tokens (`cost:N/session`, `req:N/session`, `total_tokens:N/session`, `tool_calls:N/session`). All additive except the one type tweak called out below.

## The breaking thing (TypeScript-level only)

In `alpha.19.1`:

```ts
type BudgetLimit =
  | { kind: "requests"; requestsPerHour: number }
  | { kind: "unlimited" };
```

In `alpha.20`:

```ts
type BudgetLimit =
  | {
      kind: "requests";
      requestsPerHour?: number;   // ← now optional (alpha.20 change)
      perMinute?: number;          // new
      perHour?: number;            // new (preferred name)
      perSession?: number;         // new (enforced by CostSession)
    }
  | { kind: "unlimited" };
```

`requestsPerHour` went from required to optional. The semantic reason is that a `BudgetLimit` configured with only `req:30/minute` legitimately has no hour cap, so the field IS optional in the new grammar.

### Who actually breaks

| Pattern | Breaks? |
|---|---|
| Parse `.env`, hand to Registry, call `llm.generateText(...)` | No |
| Hand-construct `{ kind: "requests", requestsPerHour: 100 }` | No (the literal still typechecks) |
| Read `entry.budgetLimit.requestsPerHour` in arithmetic without a guard | **Yes** (strict mode error: value is `number \| undefined`) |
| Pass-through to `InMemoryBudget` | No (backend reads `limit.perHour ?? limit.requestsPerHour` and falls through) |

### One-line fix

```diff
- const rph = entry.budgetLimit.requestsPerHour;
+ const rph = entry.budgetLimit.requestsPerHour ?? Infinity;
```

`Infinity` here means "no hour cap" — which is what an undefined `requestsPerHour` actually means in the new model.

Or use the codemod:

```bash
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 --write
```

The codemod scans your `.ts` / `.tsx` files for the broken pattern and applies the `?? Infinity` rewrite. Use `--dry-run` first to preview.

## Everything else (additive — no migration needed)

### New scope hint on every request

```ts
import type { BudgetScope, BudgetScopeRef } from "@llm-ports/core";

await llm.generateText({
  taskType: "triage",
  prompt: messageForTenantAcme,
  budgetScope: { scope: "tenant", scopeId: "acme" },
});
```

When set, the Registry composes the gating storage key as `${alias}|${scope}:${scopeId}` so every configured cap applies per-scope. Five axes: `tenant` / `customer` / `user` / `agent` / `session`. Omit the field and you get alpha.19.1 per-alias behavior unchanged.

### New env tokens

`parseGating` accepts these in addition to the alpha.19 set:

| Token | Meaning | Enforced by |
|---|---|---|
| `req:N/minute` | Request rate per minute | `InMemoryBudget` |
| `cost:N/minute` | USD cap per minute | `InMemoryCost` |
| `cost:N/session` | USD cap per `CostSession` | `CostSession.budgetUSD` |
| `req:N/session` | Request cap per `CostSession` | `CostSession.maxRequests` |
| `total_tokens:N/session` | Total tokens per session | `CostSession.maxTokens` |
| `tool_calls:N/session` | Tool / function calls per session | `CostSession.maxToolCalls` |

Alpha.19 tokens (`req:N/hour`, `cost:N/{hour,day,month}`) keep working unchanged.

### CostSession extends

New optional constructor opts: `maxRequests`, `maxTokens`, `maxToolCalls`. New getters: `requestsMade()`, `tokensUsed()`, `toolCallsMade()`. `SessionBudgetExceededError` gains an optional `grain` field naming which cap fired:

```ts
catch (err) {
  if (err instanceof SessionBudgetExceededError) {
    console.log(err.grain);  // "tokens (50000 >= 50000)" / "tool_calls (8 >= 8)"
                              // / "requests (100 >= 100)" / undefined for USD cap
  }
}
```

Constructor signature is back-compat; existing `new CostSession(port, { budgetUSD })` works identically.

## Migration steps

1. `npm install @llm-ports/core@alpha` (or pin to `0.1.0-alpha.20.1` exactly).
2. Run TypeScript. The compiler will flag any direct read of `requestsPerHour` in strict mode.
3. Apply the one-line fix (or run the codemod) at each error site.
4. Optionally start using `budgetScope` on multi-tenant call sites.
5. Optionally start using the new env tokens for minute / session ceilings.
6. Re-run your test suite.

## Release context

This is the fourth in the five-alpha sequence to `beta.0`:

| Release | Date | Surface |
|---|---|---|
| alpha.17 | 2026-06-05 | RerankPort skeleton, BackoffConfig, onRetry parity |
| alpha.18 | 2026-06-05 | Typed error taxonomy |
| alpha.19 | 2026-06-12 | CacheControl shape + cacheSavingsUSD rename |
| alpha.19.1 | 2026-06-12 | CacheControl behavior end-to-end |
| **alpha.20** | **2026-06-13** | **BudgetScope + minute / session gating** |
| **alpha.20.1** | **2026-06-15** | **Migration safeguards: this page + codemod + postinstall banner + MIGRATION.md** |
| alpha.21 | 2026-06-20 (target) | OTel-aligned observability hooks |
| beta.0 | 2026-06-30 (target) | Scope-closed |
