# Migration Guide

> Single source of truth for every breaking and non-breaking surface change in the `@llm-ports/*` line. If you're upgrading across one or more releases, find your starting version below and follow the chain.

## TL;DR — at a glance

| Release | Date | Headline | Migration impact | Details |
|---|---|---|---|---|
| alpha.20.1 | 2026-06-15 | Migration safeguards (this file + per-release pages + codemod + postinstall banner) | None — additive only | (no code change) |
| alpha.20 | 2026-06-13 | `BudgetScope` + minute / session gating grammar | **TypeScript-only**: `BudgetLimit.requestsPerHour` is now optional. One-line fix or codemod. Runtime behavior identical. | [docs/migration/alpha-19-to-alpha-20.md](docs/migration/alpha-19-to-alpha-20.md) |
| alpha.19.1 | 2026-06-12 | CacheControl behavior end-to-end (close-out of alpha.19 promise) | None — additive only | (no migration page needed) |
| alpha.19 | 2026-06-12 | CacheControl shape + `cost.cacheDiscountUSD` → `cost.cacheSavingsUSD` rename | **BREAKING** — field rename catches at TypeScript compile time | [docs/migration/alpha-18-to-alpha-19.md](docs/migration/alpha-18-to-alpha-19.md) |
| alpha.18 | 2026-06-05 | Typed error taxonomy (LiteLLM-aligned) | **BREAKING** — `ContextWindowExceededError` no longer matches `instanceof ProviderUnavailableError`; 5xx maps to `ServiceUnavailableError` | (described in alpha.18 release notes) |
| alpha.17 | 2026-06-05 | `RerankPort` skeleton + `BackoffConfig` + `onRetry` parity | None — additive only | (described in alpha.17 release notes) |

## How to use this file

1. Find the latest release you're already on (your `package.json` resolved version).
2. Walk down the table to the target release.
3. Each row with "BREAKING" or "TypeScript-only" links to a detailed migration page in `docs/migration/`.
4. Apply each in order. Test after each step.

If the table says "additive only" you can usually update without code changes; review the per-release CHANGELOG for new opt-in surfaces.

## Codemods

For mechanical migrations (the alpha.19 cost field rename and the alpha.20 `requestsPerHour` guard), use the bundled codemod:

```bash
# Preview the diff without writing changes:
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 --dry-run

# Apply the rewrite:
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 --write

# Migrate across multiple releases in one go:
npx @llm-ports/migrate@alpha alpha-18-to-alpha-20 --write
```

The codemod is conservative: it only rewrites patterns where the fix is unambiguous, prints a manual-review notice for ambiguous matches, and ships as a best-effort tool. Always review the diff before committing.

## Pinning during the alpha line

We recommend **exact-version pins** during the alpha series rather than the `@alpha` dist-tag:

```jsonc
// package.json — recommended during alphas
{
  "dependencies": {
    "@llm-ports/core": "0.1.0-alpha.20.1",
    "@llm-ports/adapter-anthropic": "0.1.0-alpha.20.1"
  }
}
```

Why: the `@alpha` dist-tag tracks the latest published prerelease. A `pnpm install` or `npm update` can therefore jump you across breaking changes silently. An exact pin locks the version until you deliberately bump it — at which point you read this file and apply the migration.

The `@alpha` tag is fine for experimentation. Pin exactly for anything you ship.

## Postinstall banner

`@llm-ports/core@0.1.0-alpha.20.1+` emits a single banner during `npm install` when it detects a version change since the last install:

```
ⓘ  @llm-ports/core upgraded to 0.1.0-alpha.20.1
   See MIGRATION.md or https://github.com/baabakk/llm-ports/blob/main/MIGRATION.md
```

The banner is one line, prints once per upgrade, skips on CI, never blocks the install, and bails silently on any error. Disable via `LLM_PORTS_NO_NOTICE=1` if you want CI-style behavior locally.

## Reporting a missed migration step

If a release breaks you and the migration page doesn't cover it, [open an issue](https://github.com/baabakk/llm-ports/issues/new) tagged `migration-gap`. We will update the per-release page and (where applicable) extend the codemod.

## Roadmap

The remaining alpha is `alpha.21` (OTel-aligned observability hooks, 2026-06-20 target). After that, `beta.0` ships 2026-06-30 with the locked surface. Beta minors are additive only; we will not introduce TypeScript-level breaking changes during beta.
