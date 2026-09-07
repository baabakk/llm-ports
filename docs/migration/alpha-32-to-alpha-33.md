# alpha.32 to alpha.33

**Title marker: `TS-BREAKING: ContentBlock`.** One TypeScript-strict break and two behaviour changes, all deliberate, all in service of failover doing what it has always claimed to do.

```bash
pnpm add @llm-ports/core@0.1.0-alpha.33
```

Bump every `@llm-ports/*` package together. Mixed versions are not supported, and on this release they are worse than unsupported: see [Check for duplicate copies of core](#check-for-duplicate-copies-of-core).

## What changed

| Change | Who it affects | Impact |
|---|---|---|
| `ContentBlock` gains a `document` member | Anyone with an exhaustive `switch` over `ContentBlock` | **TypeScript-strict break.** Compile error until a case is added. |
| Streamed methods can now fall back | Anyone using `streamText` or `streamStructured` with a chain | Behaviour change, and the behaviour they already believed they had. |
| A blown per-attempt deadline triggers failover | Anyone who set `perAttemptTimeoutMs` | Behaviour change. A timeout walks the chain instead of surfacing. |
| Unsupported content blocks trigger failover | Anyone sending images, audio or documents through a chain | Behaviour change under the default policy. |

## The TypeScript break, and its one-line fix

`ContentBlock` was:

```ts
type ContentBlock = TextBlock | ImageBlock | AudioBlock | ToolUseBlock | ToolResultBlock;
```

It now includes `DocumentBlock`. Constructing content is unaffected. **Consuming** content breaks if you exhaustively switch:

```ts
// Before alpha.33 this compiled. Now it errors on the unhandled "document" case.
function render(block: ContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "image": return "[image]";
    case "audio": return "[audio]";
    case "tool_use": return "[tool call]";
    case "tool_result": return "[tool result]";
  }
}
```

Add the case, or a `default`:

```ts
    case "document": return `[document: ${block.filename ?? block.source.kind}]`;
```

A `default` clause is the safer habit if you expect the union to keep growing. It will.

## Using documents

```ts
await port.generateText({
  taskType: "analysis",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "List every defect this report records." },
      {
        type: "document",
        source: { kind: "base64", mediaType: "application/pdf", data: pdfBase64 },
        filename: "inspection-report.pdf",
      },
    ],
  }],
});
```

`mediaType` accepts `application/pdf`, `text/plain`, `text/markdown` and `text/csv`. The `filename` is optional and OpenAI is the provider that uses it.

### Adapter support

| Adapter | base64 | URL |
|---|---|---|
| `adapter-openai` | Yes | No. OpenAI's file content part has no URL form. |
| `adapter-google` | Yes | Yes, when `mediaType` is set. |
| `adapter-vercel` | Yes | Yes, when `mediaType` is set. |
| `adapter-anthropic` | No | No. The supported SDK range cannot express a document. |
| `adapter-ollama` | No | No. |

**Uneven support is handled by routing, not by failure.** An adapter that cannot carry a document throws `ContentBlockUnsupportedError`, which now walks the chain under the default policy, so a chain of `anthropic,openai` answers a PDF on OpenAI without any configuration from you. Put a supporting provider somewhere in the chain and it works.

If you would rather a hard failure than a walk, set `runtimeFallback: "none"`.

## Streamed methods fall back now

`streamText` and `streamStructured` have never fallen back, on any released version. The chain walker opened a provider's stream inside a `try` and treated a throw as the signal to advance, but an async generator runs none of its body until first iteration, so the walker saw a healthy open for a dead provider and returned before the real failure happened.

**Nothing you do changes.** If you configured a chain, you now get the failover you configured. The visible difference is that a first-provider outage during streaming produces an answer from the second provider instead of an error.

## A per-attempt deadline now triggers failover

`perAttemptTimeoutMs` has aborted the attempt since alpha.30, but the abort reached you as a raw SDK error, so the chain stopped. Timeouts now raise `AttemptTimeoutError`, which extends `ProviderUnavailableError`, so every fallback predicate already accepts it.

```ts
import { AttemptTimeoutError } from "@llm-ports/core";

try {
  await port.generateText({ taskType: "chat", messages, perAttemptTimeoutMs: 30_000 });
} catch (err) {
  if (err instanceof AttemptTimeoutError) {
    console.warn(`provider ${err.alias} missed its ${err.timeoutMs}ms deadline`);
  }
}
```

**Your own `AbortSignal` is never reclassified.** A cancellation you requested propagates untouched and does **not** walk the chain, which would otherwise spend money on every remaining provider after you asked it to stop.

Note that when a whole chain exhausts you receive `NoProvidersAvailableError` as before, with the timeout recorded in its `reasons`. `AttemptTimeoutError` surfaces directly only when there is nowhere to walk, such as a `forceProviderAlias` call.

**If you relied on a timeout ending the call**, that is the behaviour change. Set `runtimeFallback: "none"`, or catch `AttemptTimeoutError` and decide for yourself.

## Check for duplicate copies of core

Not a change in this release, but this release is a good moment to check, because the failure is silent.

Every adapter depends on `@llm-ports/core` as a regular dependency. If your install tree ends up with two copies, typically from upgrading `core` without upgrading an adapter, the error classes are different objects in each copy and every `instanceof` check in the fallback classifier returns false. **Failover stops working, with no error and no log line.**

```bash
pnpm why @llm-ports/core   # or: npm ls @llm-ports/core
```

One copy is what you want. Tracked as `TD-LLMPORTS-CORE-IS-A-DEP-NOT-A-PEER-DEP`; the fix, moving core to a peer dependency, lands in alpha.34.

## Check your dashboards

No cost field changed in this release. Token and cost accounting is unaffected.

One thing worth knowing if you chart failover: streamed calls and timed-out attempts now produce fallback events that previously did not exist, because the walks they represent did not happen. A rise in `onFallback` after upgrading is the fix working, not a regression.
