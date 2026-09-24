---
"@llm-ports/core": patch
---

**Every adapter is now pinned to surface the same validation error, carrying the field-level issues.**

A schema that never validates has always raised `ValidationError` with its `issues` and `attempts`, but nothing asserted it across adapters, so the behaviour was consistent by habit rather than by contract. The shared adapter contract suite now checks it: the error class, a non-empty issue list, an issue naming the offending field, and the attempt count.

A bare message is the failure this prevents. A consumer given only "validation failed" has to parse prose to learn which field was wrong, and the prose shape would be per-adapter, which is how one error handler ends up written five times.

All five adapters running the suite pass it today: OpenAI, Anthropic, Google, Ollama and Vercel.

Asked for by BEPA as alpha.28 item 15. This is a beta-gate item, because cross-adapter behaviour is frozen at the freeze whether or not a test pins it, so it gets pinned first.
