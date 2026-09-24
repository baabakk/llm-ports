---
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-google": minor
---

**A system message that is not adjacent to the others now warns and folds, instead of failing the call.**

Anthropic and Gemini both take system content as a separate field rather than a turn in the message array, so a system message appearing after a user turn has nowhere to sit in the provider's own shape. Both adapters threw `NonContiguousSystemError` and the call failed.

Throwing was the wrong trade. The caller's intent is never ambiguous, because a later system message is an additional instruction, so refusing the call protected nothing while punishing the ordinary case of appending an instruction to a transcript assembled elsewhere.

Every system message is now folded into the provider's system field, in order, with a warning issued **once per process** so an accidental message shape stays visible. Leading system messages behave exactly as before, with no warning.

**Two things deliberately unchanged.** `NonContiguousSystemError` is still exported, so a consumer catching it still compiles. And a late system message carrying a non-text block, such as an image, is still refused: that content cannot be represented in a system field at all, and dropping it silently would be worse than failing.

Asked for by SalesCoach as alpha.29 item 20. This is a beta-gate item: a hard throw that stops being thrown is a behaviour change that cannot land after the public surface freezes.
