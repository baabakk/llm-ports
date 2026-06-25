---
"@llm-ports/adapter-openai": minor
---

Three additions, all empirically grounded in ADW's 2026-06-19 multi-team agentic-build-loop diagnostic. Together they address the two failure modes the diagnostic surfaced (harmony tool-call mis-channeling on DeepInfra-served gpt-oss; prose-only responses with tools available on mimo-parasail and similar) at the adapter layer.

## ASK 1 — Harmony tool-call extraction

`parseHarmonyToolCalls(reasoningContent)` extracts one or more tool calls from a harmony-formatted `message.reasoning_content` string. Wired into `fromOpenAIAssistantMessage` (now accepts `reasoning_content`) and `runAgent` (now forwards the field). When the standard `tool_calls` array is empty AND `reasoning_content` contains a parseable harmony tool call, the call is hoisted into the executable path with zero extra LLM calls.

**Closes the DeepInfra gpt-oss harmony tool-use gap that alpha.22 left open.** Pre-alpha.23, runAgent treated harmony tool intent in `reasoning_content` as an empty assistant turn and terminated. Post-alpha.23, the tool call executes the same as a standard one.

**Returns null gracefully** when reasoning_content is empty, prose chain-of-thought, bare JSON without a tool name (the empirical "{path: '', depth: 3}" probe case), or contains malformed JSON inside a harmony marker. The zero-tool-call rescue (ASK 2) handles the prose-only case via a corrective retry.

Emits `onRetry` with reason `"harmony-tool-call-extracted"` on success for observability.

## ASK 2 — Zero-tool-call corrective rescue

When the model returns a clean completion (`finish_reason: "stop"` or `"length"`) with prose content, empty `tool_calls`, and the request had a tools array — the adapter retries once with a corrective system message asking the model to use the standard tool_calls format rather than describing intent in prose.

**Closes the mimo-parasail prose case from ADW's diagnostic.** Pre-alpha.23, mimo returned ~69 tokens of prose with zero tool_calls, runAgent terminated as `completed`, ADW orchestration promoted empty stubs to main. Post-alpha.23, the rescue gives the model one corrective shot before termination.

**Discriminators prevent over-firing:**
- No tools in request → text response is the correct shape; skip
- `tool_calls` populated → standard tool-use success; skip
- Empty content → reasoning starvation case; handled by `reasoningStarvedResponse`
- `reasoning_content` populated → harmony case; handled by ASK 1 above
- `req.messages` includes a `tool` role message → the model is summarizing tool results, not failing to call tools; skip

Single-shot retry only. If the rescue also returns prose, the consumer's orchestration is responsible for handling it (e.g., comparing planned-file-list against actual-written at the workflow level).

Emits `onRetry` with reason `"zero-tool-call-prose-retry"` for observability.

## ASK 3 — Telemetry tags

The two new retry reasons (`"harmony-tool-call-extracted"` and `"zero-tool-call-prose-retry"`) are added to `@llm-ports/core`'s `RetryReason` union. Consumers can filter the existing `onRetry` hook on these values to distinguish "was rescued via harmony extraction" vs "was rescued via prose corrective retry" vs "clean zero-output (failover candidate)".

## Tests

- 13 new tests for ASK 1 (harmony extraction across all parser branches + runAgent integration + telemetry emission)
- 8 new tests for ASK 2 (rescue fires correctly + 5 discriminator regression guards + single-shot guarantee + telemetry emission)
- 220 adapter-openai tests total (was 199; +21, 0 regressions in the other 18 quirks suites)

## What this does NOT fix

The Case B "under-production" pattern (model makes some tool calls then stops with the planned manifest incomplete) is not addressed by the adapter. The adapter sees a clean multi-call completion; only the orchestration knows the manifest is incomplete. ADW (and similar agentic orchestrators) should add a "planned ≠ written" guard at the workflow layer.

## Empirical sources

- ADW Development_Logs.md commit b1eeee2 — DeepInfra harmony tool-use diagnostic
- ADW production wedge incident 2026-06-19T15:40 UTC — mimo silent prose-only completion
- Babak's raw 2-turn DeepInfra probe — empirical evidence of the `reasoning_content` shape
- llm-ports#46 / discussion #50 — design discussion

## Backwards compatibility

All three additions are additive. Existing callers see no API surface changes. Pre-existing tests that mocked one response and expected the loop to terminate-as-completed on prose now receive the rescue retry's request too — three tests across two existing files updated to use `mockResolvedValue` (instead of `mockResolvedValueOnce`) so the rescue retry has a target. Test intent (schema conversion correctness; termination logic) preserved.
