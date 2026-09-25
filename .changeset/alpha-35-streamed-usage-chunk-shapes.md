---
"@llm-ports/adapter-openai": minor
---

**Fix: streamed calls through Together AI and Cerebras report their tokens again.**

All three streaming paths captured usage only from a chunk with an empty `choices` array, which is how OpenAI ends a stream. Together AI and Cerebras send no such chunk: they attach `usage` to the chunk that carries `finish_reason`, which has choices. For those providers the usage was discarded, so a streamed call reported no tokens and therefore no cost, while the text arrived normally and the call succeeded.

**Usage is now read from whichever chunk carries it, and only a chunk with nothing else in it is skipped.** Those are two separate decisions, and conflating them is a trap: recording usage and then skipping that chunk would discard a last content delta from any provider that puts one on the same chunk as `finish_reason` and `usage`, which loses output text rather than a token count. A test covers that shape and fails against the narrower fix.

Spend totals and budget gates were under-counting for those providers, silently. This is the same class of defect `0.1.0-alpha.34` removed from the other direction: that release stopped the library inventing zero costs, and this one stops it dropping real numbers.

Usage is now taken from any chunk that carries it, keeping the last one seen, which serves both wire shapes.

**Found by the RLM gateway**, which carried a patch against the published package plus a guard test. That test is adopted here rather than rewritten, extended to assert the OpenAI shape as well, so the fix cannot be made by moving the defect from one shape to the other. Consumers carrying a local patch for this can drop it.
