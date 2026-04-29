# `createSummarizer`

Compress input text while preserving the key meaning. Returns plain text. Default temperature 0.2.

For structured summaries (e.g. `{ tldr, keyPoints, actionItems }`), use [`createExtractor`](/capabilities/extractor) with a schema instead.

## Signature

```ts
function createSummarizer(config: {
  port: LLMPort;
  schemaName?: string;        // default "summary"
  persona?: Resolvable<SummarizeInput, string>;
  styleGuide?: Resolvable<SummarizeInput, string>;
  systemContext?: Resolvable<SummarizeInput, string>;
  targetWords?: number;
  taskType?: string;          // default "summarize"
  priority?: LLMPriority;
  temperature?: number;       // default 0.2
  maxOutputTokens?: number;
  onBeforeCall?: (input: SummarizeInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<string>) => void | Promise<void>;
  onError?: (error: Error, input: SummarizeInput) => void | Promise<void>;
}): (input: SummarizeInput) => Promise<string>;

interface SummarizeInput {
  content: MessageContent;
  contextOverride?: string;
}
```

## Minimal example

```ts
import { createSummarizer } from "@llm-ports/capabilities";

export const summarizeMeetingNotes = createSummarizer({
  port: llm,
  targetWords: 75,
  styleGuide: "3-5 bullets. Start each with a verb. No filler.",
});

const summary = await summarizeMeetingNotes({
  content: longMeetingTranscript,
});
// "- Decided to launch Q2 ahead of plan
//  - Eng team to scope deeper integration with X
//  - Marketing budget approved at $250k"
```

## With a persona for tone

```ts
export const summarizeForExec = createSummarizer({
  port: llm,
  targetWords: 100,
  persona: `
    You write executive briefings. Direct, decisions-first, no filler.
    Lead with what changed and what to do about it.
  `,
  styleGuide: `
    Format: 1-line headline, then 3-5 bullets. Each bullet ends with a recommendation.
  `,
});
```

## Cost control via maxOutputTokens

The summarizer auto-derives `maxOutputTokens` from `targetWords` (1.5x ratio) if you don't set it explicitly. Override for tighter control:

```ts
export const summarizeStrict = createSummarizer({
  port: llm,
  targetWords: 50,
  maxOutputTokens: 100,  // hard cap, prevents runaway long output
});
```

## Reading next

- [`createExtractor`](/capabilities/extractor) — for structured summaries with explicit fields
- [`createDrafter`](/capabilities/drafter) — when you're generating new text, not compressing
