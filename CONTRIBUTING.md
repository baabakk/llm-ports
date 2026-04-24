# Contributing to llm-ports

Thank you for considering a contribution. This document covers how to propose changes.

## Quick start

```bash
git clone https://github.com/baabakk/llm-ports.git
cd llm-ports
pnpm install
pnpm build
pnpm test
```

## What's in scope

Contributions that fit the project's non-goals will be closed with thanks. The non-goals (see `README.md` and the implementation plan):

- Not a full agent framework. No memory, no retrieval primitives beyond `runAgent`.
- Not a prompt template engine. Users bring their own prompts.
- Not a vector database or RAG layer.
- Not a replacement for LangChain or LlamaIndex.
- Not an evaluation harness.

Welcome contributions:

- Bug fixes with reproducing test cases
- New adapters (community-maintained; won't ship under `@llm-ports/*` scope unless merged into the main repo)
- Pricing table updates (see `packages/adapter-*/src/pricing.ts`)
- Documentation improvements, examples, migration guides
- Contract test additions
- New capability factories that follow the factory pattern

## Development workflow

1. **Open an issue first** for non-trivial changes. Makes sure we're aligned before you write code.
2. **Fork + branch**. Branch names: `feat/<scope>-<topic>`, `fix/<scope>-<topic>`, `docs/<topic>`.
3. **Commit convention**: `<type>(<scope>): <subject>`. Examples:
   - `feat(core): add streamStructured to LLMPort`
   - `fix(adapter-anthropic): handle empty tool_result content`
   - `docs(guides): add cost gating guide`
   - `test(contract): add streamText conformance test`
4. **Write tests** for any code change. Contract tests for adapters; unit tests for core and capabilities.
5. **Add a changeset** with `pnpm changeset` if your change affects any published package.
6. **Open a PR**. CI must pass (lint, test across Node 18/20/22, build, contract tests).

## Code style

- TypeScript strict mode, no `any` without justification
- Prettier for formatting (`pnpm format`)
- ESLint for linting (`pnpm lint`)
- Every public export has TSDoc with `@description`, `@param`, `@returns`, `@example`, `@see`

## Adapter contract

All adapters must pass `@llm-ports/adapter-contract-tests`. If your adapter needs a feature not in the contract, propose it via issue first; don't add adapter-specific extensions that break the port contract.

## Pricing table PRs

Pricing changes frequently. To update a model's price:

1. Edit `packages/adapter-<name>/src/pricing.ts`
2. Update the `Last verified:` comment with today's date and your GitHub handle
3. Include the source URL in the PR description
4. Add a changeset (`patch` bump to that adapter package)

## Security issues

Do NOT open public issues for security vulnerabilities. See `SECURITY.md` for the disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md). By participating, you agree to its terms.
