---
"@llm-ports/adapter-vercel": minor
---

Vercel adapter parity with the direct adapters. Closes three v0.1-status gaps that previously had the adapter shipping visibly degraded relative to `adapter-anthropic` / `adapter-openai` / `adapter-google`.

**Multi-turn `runAgent`.** Previously single-turn — `maxSteps > 1` was ignored. Now wires Vercel AI SDK's native `tools` + `maxSteps` agent loop: the SDK invokes tool `execute` functions between steps and feeds results back to the model, looping until either the model emits text without tool calls (`terminationReason: "completed"`) or `stepsTaken >= maxSteps` (`terminationReason: "max_steps"`). Per-step usage is aggregated across the agent loop.

**Full multimodal.** Previously image / audio content blocks downgraded to `[image content]` placeholder strings. Now translates to Vercel's `MessagePart[]` shape:
- base64 images → `{ type: "image", image: "data:<mt>;base64,<data>" }`
- URL images → `{ type: "image", image: <URL> }`
- base64 audio → `{ type: "file", data, mimeType }`

The adapter switches between the simpler `prompt: string` path (text-only) and the `messages` path (multimodal) automatically based on content shape. The `imageContentSupport` flag on the contract test suite flips from `"none"` to `"base64+url"`; image conformance tests now actually exercise the wire format instead of skipping.

**Bundled pricing.** New `VERCEL_PRICING` table covering OpenAI / Anthropic / Google models via `@ai-sdk/*`. The `pricing` adapter option is now OPTIONAL; user-supplied entries merge on top of the bundled defaults. The bundle table mirrors the direct adapters' tables (same per-model rates, since underlying providers charge identically regardless of SDK layering). For uncommon `@ai-sdk/*` providers (LMStudio, OpenRouter, perplexity-ai, custom routes), users still supply their own entries.

**New exports**: `VERCEL_PRICING`, `lookupVercelPricing`.

Public API is additive — existing call sites with `pricing` supplied still work.
