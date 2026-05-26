---
"@llm-ports/adapter-anthropic": patch
---

Fix: `claude-opus-4-7` (and the rest of the Claude 4.5+ Opus / Sonnet family) now seeds `temperatureLocked: true` BEFORE the first call, preventing a wasted 400 round-trip on non-streaming methods and a HARD FAILURE on streaming methods.

**Why this is more than cosmetic for streaming.** The non-streaming methods (`generateText`, `generateStructured`, `runAgent`) auto-retry on a temperature 400 via the in-adapter capability-fallback loop. The streaming methods (`streamText`, `streamStructured`) call `client.messages.stream` directly and cannot mid-stream retry — the catalog hit is the only mechanism that prevents `streamText({ temperature, model: "claude-opus-4-7", ... })` from hard-failing with `400 Bad Request: temperature is deprecated for this model.`.

**What changed:**

- `KNOWN_TEMPERATURE_REJECTORS` regexes broadened from `/^claude-opus-4-5/` + `/^claude-sonnet-4-5/` to `/^claude-opus-4-\d/` + `/^claude-sonnet-4-\d/`. Matches 4-5, 4-6, 4-7 (the new bug report), 4-8, 4-9, 4-N going forward, and dated aliases like `claude-opus-4-7-20251220`. Bare `claude-opus-4` (predates the deprecation) is intentionally NOT matched.
- Bundled pricing entries for `claude-opus-4-7`, `claude-sonnet-4-5`, and `claude-sonnet-4-6-20250514` now carry `capabilities: { temperatureLocked: true }` belt-and-suspenders.
- Haiku 4-5 still accepts `temperature` and is not affected.

12 new regression tests covering 7 temperature-locked model IDs + 4 still-accepts-temperature model IDs + 1 streaming-path test for `claude-opus-4-7`.

Closes a bug observed in BEPA on 2026-05-26: a `streamText` against `claude-opus-4-7` failed with `400` because the catalog hadn't been extended past `4-5` when alpha.9 added the model to the pricing table.
