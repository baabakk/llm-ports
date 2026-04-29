# `createDrafter`

Generate new text in a specific persona/voice. Returns plain text. Default temperature 0.4 (creative but controlled).

The persona is the most important configuration: it tells the model who is "writing." Channel constraints (SMS = 160 chars, email = 150-250 words) help size the output. Anti-pattern blacklists eliminate AI-isms ("I wanted to reach out", "I hope this finds you well", etc.).

## Signature

```ts
function createDrafter(config: {
  port: LLMPort;
  schemaName?: string;        // default "draft"
  persona: Resolvable<DraftInput, string>;        // REQUIRED
  channelConstraint?: Resolvable<DraftInput, string>;
  antiPatterns?: Resolvable<DraftInput, string>;
  writingSamples?: Resolvable<DraftInput, string>;
  systemContext?: Resolvable<DraftInput, string>;
  taskType?: string;          // default "draft"
  priority?: LLMPriority;
  temperature?: number;       // default 0.4
  maxLength?: number;         // hard character cap; truncates output
  maxOutputTokens?: number;
  onBeforeCall?: (input: DraftInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<string>) => void | Promise<void>;
  onError?: (error: Error, input: DraftInput) => void | Promise<void>;
}): (input: DraftInput) => Promise<string>;

interface DraftInput {
  instructions: string;
  threadHistory?: MessageContent;
  recipientContext?: string;
  contextOverride?: string;
}
```

## Email drafting

```ts
import { createDrafter } from "@llm-ports/capabilities";

export const draftEmail = createDrafter({
  port: llm,
  persona: `
    Babak Abbaschian. Direct, warm, no filler. Short paragraphs (1-3 sentences).
    Lead with the answer; explain only when needed.
  `,
  channelConstraint: "Email. Target 150-250 words. Sign off: 'Babak'.",
  antiPatterns: `
    Never say:
      - "I wanted to reach out"
      - "I hope this finds you well"
      - "Looking forward to hearing from you"
      - "Just wanted to circle back"
      - Three consecutive sentences starting with "I"
  `,
  maxLength: 1500,
});

const draft = await draftEmail({
  instructions: "Reply to Alice's intro request. Suggest a 30-min call next week.",
  recipientContext: "Alice from Sequoia. Met at All-In summit. Warm.",
});
```

## Channel-specific drafters

Production codebases typically have one drafter per channel (SMS, email, LinkedIn DM, Twitter):

```ts
export const draftSMS = createDrafter({
  port: llm,
  persona: BABAK_PERSONA,
  channelConstraint: "SMS. HARD LIMIT: 160 characters. No greeting. No sign-off. Match the sender's informality.",
  maxLength: 160,
  temperature: 0.3,  // shorter output, less creative
});

export const draftLinkedInPost = createDrafter({
  port: llm,
  persona: BABAK_PERSONA,
  channelConstraint: "LinkedIn post. Under 1300 chars (before the 'see more' fold). Hook in the first line. No hashtag spam.",
  maxLength: 1300,
});
```

## Thread history (reply context)

Pass `threadHistory` so the model sees the conversation context:

```ts
const reply = await draftEmail({
  instructions: "Reply that we'd like to schedule a follow-up next week.",
  threadHistory: previousEmails,    // string or ContentBlock[]
  recipientContext: "Alice from Sequoia",
});
```

The drafter wraps thread history in `<thread>...</thread>` tags so the model can distinguish historical context from the current instruction.

## Writing samples (style transfer)

Show the model 1-3 examples of correctly-styled output:

```ts
export const draftTechnicalEmail = createDrafter({
  port: llm,
  persona: "engineering lead — concise, specific, no marketing-speak",
  writingSamples: `
    Sample 1:
    "I'm landing a fix for the latency regression today. Three things changed:
    - Removed N+1 in /api/users (root cause)
    - Cached the org membership lookup (60% of remaining time)
    - Bumped Redis pool size from 10 to 30 (avoids saturation under burst)
    p99 should drop from 1200ms → ~200ms. I'll watch it for 24h."
  `,
});
```

In production, load samples from a database keyed by (channel, register, recipient_type) — see the BEPA `writing_samples` table pattern in the implementation plan.

## Output truncation

`maxLength` enforces a hard character cap. If the model overshoots, the result is truncated to `maxLength` and trimmed. Useful for SMS (Twilio rejects >160 chars), tweet caps (280), LinkedIn fold (1300):

```ts
export const draftTweet = createDrafter({
  port: llm,
  persona: BABAK_PERSONA,
  channelConstraint: "Twitter. Max 280 chars. Punchy, no corporate jargon.",
  maxLength: 280,
});
```

## Reading next

- [Tool-use security](/guides/security) — drafts going through approval flows
- [`createSummarizer`](/capabilities/summarizer) — when you're compressing, not generating new text
