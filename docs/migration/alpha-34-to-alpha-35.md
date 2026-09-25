# alpha.34 to alpha.35

**Title marker: `TS-BREAKING: GenerateStructuredOptions.schema`.** Contract corrections, a missing chat method, and the close of the observability work. Most of this release is additive; one field became optional and that is a compile-time break for code which reads it.

```bash
pnpm add @llm-ports/core@0.1.0-alpha.35
```

Upgrade every `@llm-ports/*` package together. Two of them deliberately have no `alpha.35`: `@llm-ports/capabilities` and `@llm-ports/integration-livekit` stay at `0.1.0-alpha.34` because nothing in them changed and they accept this core through a caret range. Leave them where they are; asking for a version that does not exist is the only way to get an install error here.

## What changed

| Change | Who it affects | Impact |
|---|---|---|
| `GenerateStructuredOptions.schema` is optional | Code that **reads** the field | **TypeScript-strict break.** See below. |
| `jsonSchema` accepted instead of `schema` | Anyone holding a JSON Schema already | Additive, with a real trade-off. See below. |
| Streamed usage read from whichever chunk carries it | Anyone streaming through Together AI, Cerebras or similar | **A fix.** Usage and cost stop reading as absent. |
| Non-adjacent system messages fold instead of throwing | Anthropic and Google adapter users | Behaviour change, and a fix. A hard failure becomes a warning. |
| `generateChat` | Anyone wanting one turn with its tool calls | Additive, optional on the port. |
| `onComplete`, `createRetryRecorder`, `combineSinks` | Observability consumers | Additive. |
| Cost attributes on OpenTelemetry spans | Anyone using the bridge | Additive. Absent when unpriced, never zero. |
| An unexplained 400 is remembered | OpenAI-compatible providers that reject opaquely | Behaviour change. One extra request once, then never again. |

## The break: `schema` is optional now

`jsonSchema` became an alternative way to describe the shape you want, so exactly one of the two is required rather than `schema` always being there. Supplying neither throws `ConfigError`, and so does supplying both.

**If you build options and pass `schema`, nothing changes.** The break is at the read site, and only under TypeScript's `exactOptionalPropertyTypes`, because the field now reads as `ZodType<T> | undefined`.

The shape that breaks is forwarding one call's schema into a streamed call, since `streamStructured` still requires a Zod schema:

```ts
// Before: compiled.
// After: ZodType<T> | undefined is not assignable to ZodType<T>.
await llm.streamStructured({ taskType, messages, schema: structuredOptions.schema });
```

Hold the schema in its own binding and pass it to both:

```ts
const schema = z.object({ intent: z.string() });

await llm.generateStructured({ taskType, messages, schema });
await llm.streamStructured({ taskType, messages, schema });
```

If the options object is genuinely all you have, narrow before using it:

```ts
if (!options.schema) throw new Error("this path needs a Zod schema");
await llm.streamStructured({ taskType, messages, schema: options.schema });
```

Our own strict-mode consumer canary failed exactly this way during the release, which is what it exists for.

## Structured output from a JSON Schema

If a schema arrives over the wire, you no longer have to convert it into Zod so that the adapter can convert it back:

```ts
await llm.generateStructured<Triage>({
  taskType: "classify",
  messages,
  jsonSchema: schemaFromTheWire,
});
```

**What you give up, because it is not obvious.** This library carries no JSON Schema validator. The schema reaches the provider, whose strict mode enforces it where supported, and the decoded JSON is returned **without local validation**. So there is no retry-with-feedback when a model returns the wrong shape, `validationAttempts` is always 1, and `T` is yours to assert rather than inferred.

Prefer `schema` unless you genuinely hold a JSON Schema already. `streamStructured` is unchanged and still requires Zod.

## Streamed usage: a fix you may see in your numbers

Usage was read only from a chunk that carried no choices, which is the shape OpenAI itself sends. Together AI and Cerebras attach usage to the final chunk *with* choices, so **through those providers a streamed call reported no usage and therefore no cost.**

Nothing about your code changes. What changes is that your totals go up, because they were under-counting: cost dashboards, spend reports and per-provider budget gates all read from the usage that was being dropped. A budget that appeared to have room may now trip where it previously could not.

If you were working around this by summing tokens yourself, the workaround is no longer needed.

## Non-adjacent system messages

A conversation whose system messages are not all at the front used to throw on the Anthropic and Google adapters. It now folds the system content the way each provider's protocol expects and warns once per process.

The error class is still exported, so code that catches it still compiles, and it still throws for the one case that genuinely cannot be expressed: non-text content in a system message that arrives late.

**If you were reordering messages to avoid this**, you can stop, though nothing breaks if you do not.

## `generateChat`

One assistant turn, with any tool calls surfaced and **not executed**, for callers who want to run the loop themselves. `runAgent` runs the loop for you; `streamChat` gives you the turn as it arrives.

```ts
const turn = await llm.generateChat({ taskType: "assist", messages, tools });
for (const call of turn.toolCalls ?? []) {
  // you decide whether to run it
}
```

**It is optional on the port**, like `streamChat`. The registry knows which aliases implement it and filters a chain to those, so a chain mixing adapters that do and do not support it works, and a chain where none do throws `NoProvidersAvailableError` naming each alias rather than failing at the first attempt.

Tool-call arguments are parsed where they parse. Where a model emits arguments that are not valid JSON, `args` is left undefined and the raw text is preserved, rather than the call failing.

## Cost on OpenTelemetry spans

Attempt spans now carry `gen_ai.usage.cost.input_usd`, `gen_ai.usage.cost.output_usd` and `gen_ai.usage.cost.total_usd`, plus `gen_ai.usage.cost.savings_usd` where the provider reported a cache-read discount. The operation span carries the same three for the whole call, retries included, which is the figure worth summing: adding attempt spans double counts a call that failed over.

**Absent means unknown, and nothing is written as zero.** A model with no pricing produces no cost attributes at all, while its token attributes are unaffected. If you build a spend query, treat a missing attribute as "not known" rather than as zero, and note that a genuinely free operation is also reported without cost attributes on the operation span. That last wrinkle is recorded as `TD-LLMPORTS-OPERATION-AGGREGATE-COST-SUBSTITUTES-ZERO` and gets a proper fix at `1.0.0`.

## An unexplained 400 is remembered

Some OpenAI-compatible providers reject a request feature with a bare 400 that names no field and carries no reason code. That was unclassifiable, so the adapter's existing rescue never fired and every structured-output call rediscovered the same rejection.

Such an error now buys one retry with `response_format` removed. If that retry succeeds, the constraint is remembered and later calls omit the field up front. If it fails too, the 400 was about something else: nothing is learned, your original error is raised unchanged, and the model is marked so no later call repeats the experiment.

**What you may notice:** one extra request, once per model per process, in the case where an opaque 400 has some other cause. A provider that states its reason is unaffected.

## New observability pieces

- **`onComplete`** fires once per call, on success **and on failure**, with usage, dollar cost where known, how many providers were attempted and which answered. **Incomplete in this version:** it covers `generateText` and `generateChat` only, so do not make it your only spend event yet if you stream or use structured output. See `TD-LLMPORTS-ONCOMPLETE-FIRES-FOR-TWO-OF-NINE-OPERATIONS`.
- **`createRetryRecorder`** gives a bounded, newest-first view of recent retries for a dashboard or health check. Pass `recorder.onRetry` as each adapter's `onRetry`; it is not a registry method, because retries happen inside adapters and the registry never sees them.
- **`combineSinks`** lets two observability sinks coexist, isolating a failing sink so it cannot silence the others.

## What is not in this release

- **A per-call cap on attempts.** The ask has two readings that would produce different public options in different layers, and shipping the wrong one is worse than shipping neither. Blocked pending an answer from the team that asked.
- **Persistent budget counters as a package.** Still coming, and **you do not need to wait for it**: `BudgetBackend` and `CostBackend` are public interfaces the registry accepts, so you can supply Redis-backed counters today. See the [cost-gating guide](/guides/cost-gating).

## Reading next

- [Configuration](/concepts/configuration), a new page on the two configuration forms and where a provider alias comes from
- [What ships next](/v0-1-status), which now describes the path to `1.0.0`
