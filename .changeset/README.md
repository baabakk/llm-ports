# Changesets

This folder contains [changesets](https://github.com/changesets/changesets) used to drive the release process.

## Adding a changeset

When you make a change that should appear in a release, run:

```bash
pnpm changeset
```

You will be prompted to:

1. Select which packages your change affects
2. Choose the type of bump (`patch`, `minor`, `major`) for each
3. Write a short summary that will appear in the changelog

The summary should be plain English, written from the user's perspective. Examples:

- `Fix tool_result content normalization when Anthropic returns an empty array.`
- `Add streamStructured to LLMPort for partial JSON streaming.`
- `Update Claude Sonnet pricing per 2026-04 rate change.`

A new file will be created under `.changeset/` with your entry. Commit it with your code change.

## Releasing

Maintainers run:

```bash
pnpm version-packages   # consumes the changeset entries, bumps versions, updates CHANGELOGs
pnpm release            # builds and publishes to npm
```

The default release branch is `main`. The release process is configured in `config.json`.

## Why changesets and not conventional commits

Changesets decouple "the commit" from "the release intent." A single PR can contain many small commits but exactly one changeset that says how the release should bump. This avoids the noise of forcing every commit message to encode release semantics.
