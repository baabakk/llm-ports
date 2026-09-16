---
"@llm-ports/core": minor
"@llm-ports/capabilities": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-ollama": minor
"@llm-ports/adapter-vercel": minor
"@llm-ports/adapter-codex": minor
"@llm-ports/adapter-aider": minor
"@llm-ports/integration-livekit": minor
---

`@llm-ports/core` is a peer dependency, and its errors are recognised across duplicate copies.

The adapters and `@llm-ports/capabilities` previously depended on an exact version of core. Any version difference produced two installed copies, and since the error taxonomy is checked with `instanceof`, every fallback decision then returned false: failover stopped with no error and no log line.

**Core is now a peer dependency with a caret range**, so one release of difference neither duplicates core nor fails an install. Packages that already declared it as a peer used an exact range, which recent npm treats as an install error on any mismatch; they now use the same caret range.

**Errors also survive a duplicate when one happens anyway.** `instanceof` against any core error class recognises an error thrown by another copy of the package. It is declared as a type predicate, so narrowing after `instanceof` is unchanged. Subclasses you define yourself are matched by the ordinary check, as before.

Make sure your project depends on `@llm-ports/core` directly.
