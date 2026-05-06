# Changelog

`llm-ports` uses [Changesets](https://github.com/changesets/changesets) to manage releases. Each published package keeps its own per-version changelog beside the source:

| Package | Per-package changelog |
|---|---|
| `@llm-ports/core` | [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md) |
| `@llm-ports/capabilities` | [`packages/capabilities/CHANGELOG.md`](packages/capabilities/CHANGELOG.md) |
| `@llm-ports/adapter-anthropic` | [`packages/adapter-anthropic/CHANGELOG.md`](packages/adapter-anthropic/CHANGELOG.md) |
| `@llm-ports/adapter-openai` | [`packages/adapter-openai/CHANGELOG.md`](packages/adapter-openai/CHANGELOG.md) |
| `@llm-ports/adapter-ollama` | [`packages/adapter-ollama/CHANGELOG.md`](packages/adapter-ollama/CHANGELOG.md) |
| `@llm-ports/adapter-vercel` | [`packages/adapter-vercel/CHANGELOG.md`](packages/adapter-vercel/CHANGELOG.md) |

This root file aggregates the **release-level** notes — the user-facing summary of what changed across all packages in a given version, breaking changes, and migration guidance.

## Unreleased

Tracked changesets that haven't shipped yet live under [`.changeset/`](.changeset/). Run `pnpm changeset` to add a new one.

## Format

Each release entry follows this shape:

```markdown
## v0.1.0 — YYYY-MM-DD

### What changed
<!-- 1-2 sentence summary of the release theme -->

### New
<!-- bullet list of new packages, capabilities, adapters, public API surface -->

### Changed
<!-- breaking changes, behavior changes; link to migration notes -->

### Fixed
<!-- bug fixes notable enough for release notes -->

### Migration notes
<!-- how to upgrade from the previous version, if anything is breaking -->

### Known limitations
<!-- carry-overs from the README's "Known Limitations" section that this release didn't fix -->

### Thanks
<!-- contributor handles, including non-PR feedback contributors -->
```

## Versioning

Pre-release: `0.1.0-alpha.0`, `0.1.0-alpha.1`, ... published under the `alpha` npm tag.

Stable: `0.1.0`, `0.1.1`, ... published under the `latest` npm tag once gate B from PUBLISHING is met.

Internal-only packages (`@llm-ports/adapter-contract-tests`, `@llm-ports/benchmarks`) are not published to npm; their changes are not version-bumped here.
