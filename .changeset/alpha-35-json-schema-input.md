---
"@llm-ports/core": minor
"@llm-ports/adapter-openai": minor
"@llm-ports/adapter-anthropic": minor
"@llm-ports/adapter-google": minor
"@llm-ports/adapter-ollama": minor
"@llm-ports/adapter-vercel": minor
---

**`generateStructured` accepts a JSON Schema, not only a Zod schema.**

Adapters convert a Zod schema to JSON Schema before sending it, so a consumer holding a wire-delivered schema had to convert it backwards into Zod for this library to convert it forwards again. An OpenAI-compatible HTTP surface receives exactly that shape from its clients.

```ts
await llm.generateStructured<Triage>({
  taskType: "classify",
  messages,
  jsonSchema: schemaFromTheWire,   // instead of schema: zodSchema
});
```

**What you give up, stated plainly, because it is not obvious.** This library carries no JSON Schema validator. The schema reaches the provider, whose strict mode enforces it where supported, and the decoded JSON is returned **without local validation**. So there is no retry-with-feedback when a model returns the wrong shape, `validationAttempts` is always 1, and `T` is yours to assert rather than inferred. Prefer `schema` unless you genuinely hold a JSON Schema already.

`schema` is now optional and **exactly one of the two is required**. Supplying neither throws, and so does supplying both: a call with both carries two intentions, and picking one silently would make the other a bug nobody can see.

**One break, for readers of the field rather than callers who set it.** If you build a `GenerateStructuredOptions` value and pass `schema`, nothing changes. But making a required field optional changes what the field reads as, and under TypeScript's `exactOptionalPropertyTypes` that is a compile error at the read site rather than a silent widening:

```ts
// Was fine, now fails to compile: `ZodType<T> | undefined` into a `ZodType<T>`
await llm.streamStructured({ taskType, messages, schema: structuredOpts.schema });
```

`streamStructured` still requires a Zod schema, so forwarding one call's schema into a streamed call is the shape that breaks. Hold the schema in its own binding and pass it to both, or narrow with a check. Our own strict-mode consumer canary caught exactly this, which is what it is for.

Implemented across all five adapters that serve `generateStructured`, through one shared resolver in core, so neither-and-both mean the same thing everywhere rather than five adapters each deciding. `streamStructured` is unchanged and still requires a Zod schema.

From `TD-LLMPORTS-STRUCTURED-OUTPUT-IS-ZOD-ONLY`, raised by the RLM gateway.
