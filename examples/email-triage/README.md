# `@llm-ports/example-email-triage`

The most common production LLM use case: **inbound email arrives, classify it, draft a reply, queue for human review**. The example shows two capability factories composing in a single pipeline, with fallback chains and per-provider USD cost gating.

This is the BEPA-pattern condensed into ~150 lines.

## Run it

```bash
# Set at least one of the two API keys (both is better — fallback path runs)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...

# From the monorepo root
pnpm --filter @llm-ports/example-email-triage start
```

The example processes four representative emails (a billing duplicate-charge, a critical production-outage escalation, a product compliment with an embedded feature request, and obvious spam). For each:

1. **Triage** — classify intent + urgency + customer sentiment, all typed by Zod
2. **Policy gate** — spam gets discarded, critical issues page ops
3. **Draft** — generate a brand-voiced reply scoped to the triage signal
4. **Quality tracking** — every capability call fires an `onResult` event with cost, latency, validation attempts, provider used

You'll see something like:

```
📧 alice@example.com — Charged twice for my Pro subscription
   intent: billing_question, urgency: normal, sentiment: frustrated
   draft (132 chars): Hi Alice, we see two $49 charges on your account this month and...

📧 bob@startup.io — Production outage - urgent
🚨 CRITICAL email from bob@startup.io: Enterprise customer reporting a recurring outage...
   intent: technical_issue, urgency: critical, sentiment: angry
   draft (148 chars): Bob, we're escalating this immediately. An on-call engineer...

📧 noreply@buyourthing.example — Increase your sales by 300% ...
   intent: spam, urgency: low, sentiment: neutral
   action: discarded
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Capability calls: 4 triages, 3 drafts
Total cost: $0.001924 (triage $0.000412 + draft $0.001512)
Provider routing: primary, primary, primary, primary
Validation retries: 0 of 4 triages needed a 2nd attempt
```

## What's happening, layer by layer

### Layer 1: adapter wiring

The only LLM-SDK imports in the entire example are the two adapter constructors. Anywhere else in your app you'd reach for `import OpenAI from "openai"` or `import Anthropic from "@anthropic-ai/sdk"`, you go through the registry instead.

```ts
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
```

### Layer 2: registry config

```
LLM_PROVIDER_PRIMARY=anthropic|claude-haiku-4-5|cost:5/day
LLM_PROVIDER_BACKUP=openai|gpt-4o-mini|cost:10/day
LLM_TASK_ROUTE_TRIAGE=primary,backup
LLM_TASK_ROUTE_DRAFT=primary,backup
```

Both task types (`triage` and `draft`) walk the same `primary,backup` chain. If Anthropic's $5/day cap exhausts mid-day, every `triage` and `draft` call falls through to OpenAI for the rest of the window. Recovery happens automatically as windows roll over.

### Layer 3: capability factories (defined once)

```ts
const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,        // Zod schema: intent + urgency + sentiment + reasoning
  schemaName: "email-triage",
  rubric: "...",                // The evaluation criteria; improving this improves every call site
  onResult: (event) => { ... }, // Quality tracking hook
});

const draftReply = createDrafter({
  port: llm,
  persona: "Direct, warm, ...",      // Brand voice, defined ONCE
  channelConstraint: "Email...",
  antiPatterns: "Never say...",
  onResult: (event) => { ... },
});
```

The factories return tiny call signatures. Improving the rubric / persona / anti-patterns improves every call site. Versus the typical scattered `generateText({ prompt: ... })` pattern, this is the difference between a system asset and a copy-pasted string.

### Layer 4: business logic (no SDK imports, no provider code)

```ts
async function handleInbound(email: InboundEmail) {
  const triage = await classifyEmail({ content: emailToString(email) });

  if (triage.intent === "spam") return { triage, draft: null, action: "discarded" };
  if (triage.urgency === "critical") await alertOps(email, triage);

  const draft = await draftReply({
    instructions: `Acknowledge the ${triage.intent}. ${urgencyClause(triage.urgency)}`,
    recipientContext: `Sentiment: ${triage.customerSentiment}.`,
  });

  return { triage, draft, action: "queued_for_review" };
}
```

This is the unit a real production app exposes as a webhook handler or queue worker. **No SDK types leak in.** Swap providers via env vars; the function above doesn't change.

## Production-shape extensions

What this example doesn't do but a real app would:

- **Persistence.** Log triage + draft + email-id to a DB so the human-review queue is durable.
- **Approval flow.** Wire `onResult` to a quality-tracking sink. Capture human edits to the drafts; ship the corrections back as labeled training data.
- **Rate limit handling.** The example fails on primary-provider 429 by falling through to backup. A real app might want exponential backoff before falling through; the OpenAI adapter's `transientAuthBackoffMs` option is a starting point.
- **Multi-language support.** Add a language-detection capability before triage; route to language-specific drafters.

## Compare to alternatives

| Library | What you'd write for this same pipeline |
|---|---|
| Direct `@anthropic-ai/sdk` + `openai` | ~3-4× more code: SDK clients, response parsing, JSON validation, manual fallback, manual cost tracking. Each `generateText` call site re-states the rubric. |
| Vercel AI SDK | Slightly less SDK boilerplate, but still: no capability factories, no fallback chains, no USD cost gating. You'd still bolt those on. |
| LangChain | Different abstraction (chains + agents). Capabilities-as-factories isn't first-class. The chain-of-thought pattern wraps this differently. |

The capability layer is what makes this example short. That's the differentiation.
