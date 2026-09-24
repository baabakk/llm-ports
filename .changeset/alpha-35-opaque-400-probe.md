---
"@llm-ports/adapter-openai": minor
---

**A provider that refuses a feature with an unexplained 400 is learned once instead of on every call.**

The adapter already learns constraints from provider errors: a model that rejects a custom temperature, or a separate system message, or a `response_format` it does not accept, is remembered and the next call omits that field up front. Every one of those signals is read out of the error body.

Some OpenAI-compatible providers do not supply one. A bare 400 with no reason code and no field name was unclassifiable, so the rescue never fired, and every structured-output call against that model rediscovered the same rejection and failed the same way.

Now an unexplained 400 on a request that carried a `response_format` buys one retry with that field removed, and the outcome of that retry decides what is remembered:

- **The retry succeeds.** The feature was the problem, the constraint is recorded, and later calls in the process omit the field without probing.
- **The retry fails too.** The 400 was about something else. Nothing is learned about `response_format`, the original error is raised unchanged, and the model is marked so no later call repeats the experiment.

The second case is why this is a retry rather than a rule. Recording a constraint from an unexplained error would silently disable strict schemas for a model that supports them, and the only symptom would be worse structured-output reliability discovered much later. A provider that does state its reason is unaffected, since the existing classifiers match first.

From alpha.28 item 5, whose probe of 2026-06-18 supplied the failing shape.
