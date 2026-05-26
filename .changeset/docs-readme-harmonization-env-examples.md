---
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-openai": patch
"@llm-ports/adapter-google": patch
"@llm-ports/adapter-ollama": patch
"@llm-ports/adapter-vercel": patch
---

Docs polish across all 5 adapter READMEs (closes [#7](https://github.com/baabakk/llm-ports/issues/7)). Every adapter README now follows the canonical section template:

```
# @llm-ports/adapter-<name>
<tagline>

## Install
## Configure
## Adapter options
## Bundled pricing
## Supported features
## Content blocks supported
## Cancellation
<adapter-specific sections>
## Reading next
```

Adapter-specific sections (Anthropic's temperature handling, OpenAI's compat-providers + known reasoning models, Ollama's local-to-cloud flip + model management, Google's "why over OpenAI-compat baseURL", Vercel's "when to use vs direct") sit between Cancellation and Reading next. Public-facing behavior unchanged.

Per-example `.env.example` files added to all 10 examples (closes [#8](https://github.com/baabakk/llm-ports/issues/8)) so new users can `cp .env.example .env` then fill in their keys without grepping the source for `process.env.*`.

No code changes; package version bumps via this changeset because the README is published to npm as the package landing page.
