<!--
Thanks for sending a PR. Before filling this out:

1. Run `pnpm lint` and `pnpm test` locally; both should be green.
2. If your change is user-visible, add a changeset:
     pnpm changeset
   Pick the affected packages and a semver bump (patch / minor / major).
3. If your change touches behavior described in the docs site
   (`docs/`), update the relevant page in the same PR.
-->

## Summary

<!-- 1-2 sentences. What does this change do, and why? -->

## Type of change

<!-- Check one. -->

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] New adapter
- [ ] New capability factory
- [ ] Documentation only
- [ ] Internal refactor / chore (no public API change)

## Packages affected

<!-- List which `@llm-ports/*` packages this PR touches. -->

- [ ] `@llm-ports/core`
- [ ] `@llm-ports/capabilities`
- [ ] `@llm-ports/adapter-anthropic`
- [ ] `@llm-ports/adapter-openai`
- [ ] `@llm-ports/adapter-ollama`
- [ ] `@llm-ports/adapter-vercel`
- [ ] `@llm-ports/adapter-contract-tests` (internal)
- [ ] `@llm-ports/benchmarks` (internal)

## Checklist

- [ ] `pnpm lint` is clean
- [ ] `pnpm typecheck` is clean
- [ ] `pnpm test` passes (existing tests + any new ones for this change)
- [ ] Changeset added via `pnpm changeset` (skip if internal-only / docs-only)
- [ ] Docs updated if user-visible behavior changed
- [ ] If this changes adapter behavior, the contract test suite still passes

## Linked issues

<!-- "Closes #123" or "Refs #123". Skip if standalone. -->

## Additional context

<!--
Anything reviewers should know that isn't in the diff: design tradeoffs you considered, things you tried and rejected, follow-up work this PR enables.
-->
