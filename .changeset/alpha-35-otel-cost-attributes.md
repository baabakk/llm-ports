---
"@llm-ports/telemetry-otel": minor
---

**Spans carry what the call cost, not only how many tokens it used.**

The OpenTelemetry bridge mapped token counts and dropped the dollar figures, so a team that turned tracing on to see spend had to rebuild it downstream by joining span data against a pricing table this library had already applied.

Attempt spans now carry `gen_ai.usage.cost.input_usd`, `gen_ai.usage.cost.output_usd` and `gen_ai.usage.cost.total_usd`, plus `gen_ai.usage.cost.savings_usd` where the provider reported a cache-read discount. The operation span carries the same three for the whole call, retries included, which is the number worth summing: adding up attempt spans double counts a call that failed over.

**Absent means unknown, and nothing is ever written as zero.** A model with no pricing produces no cost attributes at all, while its token attributes are unaffected. This is the alpha.34 rule applied to tracing: a zero in a spend dashboard reads as "this call was free", which is a confident answer to a question nobody had the data for.

One consequence is visible and deliberate. An operation whose price was never known reports zeros in the contract's aggregate field, which is required and cannot say "unknown", so the aggregate attributes are omitted whenever that total is zero. A genuinely free operation is therefore also reported without cost attributes. Making the contract field able to say unknown is a breaking change and is queued for `1.0.0`, tracked as `TD-LLMPORTS-OPERATION-AGGREGATE-COST-SUBSTITUTES-ZERO`.

From `TD-LLMPORTS-OTEL-SINK-DROPS-COST`.
