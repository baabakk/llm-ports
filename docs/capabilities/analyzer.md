# `createAnalyzer`

Evaluate, critique, or compare. Returns Zod-validated structured output. Default temperature 0.3 (analysis benefits from some perspective variety).

Use when you want a "what do you think about this?" answer with explicit reasoning and recommendations. Pair with a framework: SWOT, pros/cons, root-cause-five-whys, decision matrix, etc.

## Signature

```ts
function createAnalyzer<TSchema extends z.ZodTypeAny>(config: {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  framework: Resolvable<AnalyzeInput, string>;       // REQUIRED
  examples?: Resolvable<AnalyzeInput, string>;
  systemContext?: Resolvable<AnalyzeInput, string>;
  taskType?: string;          // default "analyze"
  priority?: LLMPriority;
  temperature?: number;       // default 0.3
  maxOutputTokens?: number;
  onBeforeCall?: (input: AnalyzeInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: AnalyzeInput) => void | Promise<void>;
}): (input: AnalyzeInput) => Promise<z.infer<TSchema>>;

interface AnalyzeInput {
  content: MessageContent;
  question?: string;          // optional: explicit question
  contextOverride?: string;
}
```

## SWOT analysis

```ts
import { createAnalyzer } from "@llm-ports/capabilities";
import { z } from "zod";

const SwotSchema = z.object({
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  opportunities: z.array(z.string()),
  threats: z.array(z.string()),
  recommendation: z.string(),
});

export const swotAnalyze = createAnalyzer({
  port: llm,
  schema: SwotSchema,
  schemaName: "swot",
  framework: `
    SWOT analysis. Be specific:
      strengths: 3-5 internal advantages, each backed by an observation from the input
      weaknesses: 3-5 internal disadvantages, each backed by an observation
      opportunities: 3-5 external favorable factors
      threats: 3-5 external risks
      recommendation: one sentence, actionable, prioritizing which factor matters most
  `,
});

const result = await swotAnalyze({
  content: businessProposal,
});
```

## Pros/cons with a question

```ts
const ProsConsSchema = z.object({
  pros: z.array(z.object({ point: z.string(), weight: z.enum(["low", "medium", "high"]) })),
  cons: z.array(z.object({ point: z.string(), weight: z.enum(["low", "medium", "high"]) })),
  verdict: z.string(),
});

export const evaluateDecision = createAnalyzer({
  port: llm,
  schema: ProsConsSchema,
  schemaName: "decision-prosCons",
  framework: "Pros/cons. Each point gets a weight. Verdict cites the most-decisive factor.",
});

const result = await evaluateDecision({
  content: decisionContext,
  question: "Should we hire a contractor or extend the in-house team?",
});
```

The `question` parameter is appended to the user prompt as a `<question>...</question>` tag, distinct from the content. Use it when the analysis should target a specific decision rather than open-ended evaluation.

## Code review

```ts
const ReviewSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(["nit", "minor", "major", "blocker"]),
    location: z.string(),
    description: z.string(),
    suggestedFix: z.string().optional(),
  })),
  summary: z.string(),
});

export const reviewCode = createAnalyzer({
  port: llm,
  schema: ReviewSchema,
  schemaName: "code-review",
  framework: `
    Code review. Surface issues by severity:
      blocker: bugs, security holes, data loss risks
      major: architecture concerns, performance issues, missing error handling
      minor: maintainability, naming, dead code
      nit: style, minor wording

    For each issue, cite the location and propose a concrete fix when obvious.
    Skip "good job" comments. The reviewer's role is to surface what to change, not what's fine.
  `,
});
```

## Default guardrails

The analyzer's system prompt includes:

> Every claim should be traceable to something in the input. Flag uncertainty explicitly rather than hedging vaguely.

This pushes the model away from generic "it depends" outputs and toward grounded, citation-backed analysis.

## Reading next

- [`createScorer`](/capabilities/scorer) — when you want a single number, not a structured analysis
- [`createPlanner`](/capabilities/planner) — when you want steps, not evaluation
