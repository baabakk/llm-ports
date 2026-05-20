---
"@llm-ports/adapter-anthropic": minor
---

Fix: adapter forwards `temperature` to Claude models that reject it ([#12](https://github.com/baabakk/llm-ports/issues/12)).

The adapter now learns at runtime when a model rejects `temperature` (Anthropic returns 400 "temperature is deprecated for this model" on newer reasoning Claude). On detection, the adapter strips the parameter, retries the call, and remembers the constraint for the rest of the process so subsequent calls skip the bad parameter.

Five things ship together:

- **Runtime learning + retry.** Single retry per call on `temperatureLocked` detection. Subsequent calls in the process apply the constraint up front.
- **Static catalog.** `claude-opus-4-5` and `claude-sonnet-4-5` are pre-seeded so first-call discovery is skipped for these known cases. Extend by editing `KNOWN_TEMPERATURE_REJECTORS` in `src/capabilities.ts`.
- **`onRetry` plumbing.** Brings adapter-anthropic to parity with adapter-openai and adapter-vercel. New `AnthropicAdapterOptions.onRetry` option. Fires with `reason: "capability-fallback", capability: "temperatureLocked"` on every learning retry.
- **Click-to-file URL on first learning.** `console.warn` with a pre-filled GitHub New Issue URL the user can click to file a report. Maintainers see signal only when users take explicit action. No telemetry.
- **SDK version compatibility warning.** Surfaces "upgrade us or downgrade them" when the installed `@anthropic-ai/sdk` is outside the tested range (`>=0.32.0 <0.50.0`).

Also refactors the adapter to consume shared utilities from `@llm-ports/core` (no behavior change beyond the bug fix above; net deletion of ~150 lines of duplicated helpers).

15 new tests (8 temperature-rejection + 7 SDK version check). All 29 existing tests still pass. Closes #12.
