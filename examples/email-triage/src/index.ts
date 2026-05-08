/**
 * Email triage example.
 *
 * What it shows:
 *   - Capability composition: classify → draft, both reusable factories
 *     defined ONCE at module scope, called many times across messages.
 *   - Fallback chain: Anthropic primary, OpenAI backup. Each provider has
 *     its own daily USD cap; budget exhaustion on the primary falls
 *     through to the backup automatically.
 *   - Quality tracking via `onResult` hooks: every classification and
 *     draft fires an event with usage, cost, latency, and validation
 *     attempts. In production you'd ship these to your observability
 *     stack; here we just log them.
 *   - Structured output with Zod validation: the classifier's output is
 *     typed end-to-end. If the model emits malformed JSON, the
 *     retry-with-feedback strategy gives it the parse errors and asks
 *     it to correct.
 *
 * The pattern matches what production triage flows look like: an
 * inbound email becomes (triage signal, draft reply) and lands in a
 * queue for human review before sending.
 */

import { z } from "zod";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";
import {
  createClassifier,
  createDrafter,
  type CapabilityEvent,
} from "@llm-ports/capabilities";

// ─── Adapter wiring (only LLM-SDK imports in this entire example) ──

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];

if (!anthropicKey && !openaiKey) {
  console.error(
    "Set at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY before running.",
  );
  process.exit(1);
}

const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",
    LLM_PROVIDER_BACKUP: "openai|gpt-4o-mini|cost:10/day",
    LLM_TASK_ROUTE_TRIAGE: "primary,backup",
    LLM_TASK_ROUTE_DRAFT: "primary,backup",
  },
  adapters: {
    ...(anthropicKey
      ? { anthropic: createAnthropicAdapter({ apiKey: anthropicKey }) }
      : {}),
    ...(openaiKey ? { openai: createOpenAIAdapter({ apiKey: openaiKey }) } : {}),
  },
});

const llm = registry.getPort();

// ─── Capability 1: classify ────────────────────────────────────────

const TriageSchema = z.object({
  intent: z.enum([
    "billing_question",
    "technical_issue",
    "feature_request",
    "complaint",
    "compliment",
    "spam",
    "other",
  ]),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  customerSentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
  reasoning: z.string(),
});

const triageEvents: Array<CapabilityEvent<unknown>> = [];

const classifyEmail = createClassifier({
  port: llm,
  schema: TriageSchema,
  schemaName: "email-triage",
  rubric: `
    Classify the email's intent (one of the listed categories), urgency,
    and customer sentiment. Use 'critical' urgency only when an outage,
    payment issue, or legal escalation is implied.
  `,
  onResult: (event) => {
    triageEvents.push(event as CapabilityEvent<unknown>);
  },
});

// ─── Capability 2: draft reply ─────────────────────────────────────

const draftEvents: Array<CapabilityEvent<string>> = [];

const draftReply = createDrafter({
  port: llm,
  persona: "Direct, warm, no filler. First-person plural ('we'). Sign as 'Acme Support'.",
  channelConstraint: "Email. 80-150 words. Plain text, no markdown.",
  antiPatterns:
    "Never say 'reach out', 'hope this finds you well', or 'circle back'.",
  maxLength: 1500,
  onResult: (event) => {
    draftEvents.push(event);
  },
});

// ─── The actual handler — the unit a real app exposes via webhook ──

interface InboundEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
}

async function handleInbound(email: InboundEmail) {
  // Step 1: triage. Result is fully typed via the Zod schema.
  const triage = await classifyEmail({
    content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
  });

  // Step 2: pre-action policy. Spam never gets a draft. Critical pages ops.
  if (triage.intent === "spam") {
    return { triage, draft: null, action: "discarded" as const };
  }
  if (triage.urgency === "critical") {
    console.log(
      `🚨 CRITICAL email from ${email.from}: ${triage.reasoning}\n   In production this would page ops.`,
    );
  }

  // Step 3: draft a suggested reply. The drafter knows nothing about
  // billing systems or tickets — its job is tone + structure. The
  // recipientContext field carries the triage signal so the draft can
  // reference what was found.
  const draft = await draftReply({
    instructions: `Acknowledge the customer's ${triage.intent.replace(/_/g, " ")}. ${
      triage.urgency === "high" || triage.urgency === "critical"
        ? "Acknowledge urgency. Promise a follow-up within 1 business hour."
        : "Set expectations: next-business-day response."
    } Do not commit to a specific resolution; we're routing to a specialist.`,
    recipientContext: `Customer email: ${email.from}. Sentiment: ${triage.customerSentiment}.`,
  });

  // Step 4: in production this would land in a human-review queue.
  return { triage, draft, action: "queued_for_review" as const };
}

// ─── Demo: run a few representative emails through the pipeline ──

const testEmails: InboundEmail[] = [
  {
    id: "e1",
    from: "alice@example.com",
    subject: "Charged twice for my Pro subscription",
    body:
      "Hi - I just noticed two charges of $49 on my card from Acme this month. " +
      "I only have one subscription. Can you refund the duplicate?",
  },
  {
    id: "e2",
    from: "bob@startup.io",
    subject: "Production outage - urgent",
    body:
      "Our entire customer-facing dashboard is down for the second time this week. " +
      "We have enterprise SLA. This is not acceptable. Need someone on this immediately.",
  },
  {
    id: "e3",
    from: "carol@example.com",
    subject: "Love the new export feature!",
    body:
      "Just wanted to say thanks - the CSV export shipped yesterday is exactly " +
      "what we needed. Also: any plans for an Excel format option?",
  },
  {
    id: "e4",
    from: "noreply@buyourthing.example",
    subject: "Increase your sales by 300% with our AI tool",
    body:
      "Limited time offer! Click here to download our free e-book and transform " +
      "your business. Reply STOP to unsubscribe.",
  },
];

console.log(`Processing ${testEmails.length} emails through triage + draft...\n`);

for (const email of testEmails) {
  console.log(`📧 ${email.from} — ${email.subject}`);
  const result = await handleInbound(email);
  console.log(`   intent: ${result.triage.intent}, urgency: ${result.triage.urgency}, sentiment: ${result.triage.customerSentiment}`);
  if (result.draft !== null) {
    console.log(`   draft (${result.draft.length} chars): ${result.draft.slice(0, 120)}...`);
  } else {
    console.log(`   action: ${result.action}`);
  }
  console.log();
}

// ─── Quality tracking summary ──────────────────────────────────────

const triageCost = triageEvents.reduce((s, e) => s + e.cost.totalUSD, 0);
const draftCost = draftEvents.reduce((s, e) => s + e.cost.totalUSD, 0);
const triageRetries = triageEvents.filter((e) => (e.validationAttempts ?? 1) > 1).length;

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`Capability calls: ${triageEvents.length} triages, ${draftEvents.length} drafts`);
console.log(`Total cost: $${(triageCost + draftCost).toFixed(6)} (triage $${triageCost.toFixed(6)} + draft $${draftCost.toFixed(6)})`);
console.log(`Provider routing: ${triageEvents.map((e) => e.providerAlias).join(", ")}`);
console.log(`Validation retries: ${triageRetries} of ${triageEvents.length} triages needed a 2nd attempt`);
console.log(
  "\nIn production the onResult hooks would ship these events to your observability stack",
);
console.log(
  "(quality tracker, cost dashboard, drift alarms, etc.) instead of just logging.",
);
