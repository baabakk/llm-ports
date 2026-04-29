# `createScorer`

Rate input against a rubric. Returns a Zod-validated typed object — typically a numerical score plus reasoning. Default temperature 0.1 (slight randomness for borderline-case calibration consistency).

## Signature

```ts
function createScorer<TSchema extends z.ZodTypeAny>(config: {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  rubric: Resolvable<ScoreInput, string>;        // REQUIRED
  examples?: Resolvable<ScoreInput, string>;
  systemContext?: Resolvable<ScoreInput, string>;
  taskType?: string;          // default "score"
  priority?: LLMPriority;
  temperature?: number;       // default 0.1
  maxOutputTokens?: number;
  onBeforeCall?: (input: ScoreInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ScoreInput) => void | Promise<void>;
}): (input: ScoreInput) => Promise<z.infer<TSchema>>;
```

## Example

```ts
import { createScorer } from "@llm-ports/capabilities";
import { z } from "zod";

const QualitySchema = z.object({
  score: z.number().min(1).max(10),
  reasoning: z.string(),
});

export const scoreDraftQuality = createScorer({
  port: llm,
  schema: QualitySchema,
  schemaName: "draft-quality",
  rubric: `
    Rate the email draft on these criteria, weighted equally:
      1-3: poor (filler, unclear, off-tone)
      4-6: passable (clear but generic)
      7-8: strong (concise, on-tone, specific)
      9-10: excellent (memorable, perfectly on-tone, advances the goal)

    Final score is the average. Reasoning should cite 1-2 specific observations.
  `,
});

const result = await scoreDraftQuality({ content: emailDraftText });
// { score: 7, reasoning: "Direct opening, but uses 'reach out' which is on the AI-blacklist" }
```

## With calibration examples

Calibrated scoring is hard. Examples help the model anchor:

```ts
export const scoreLeadFit = createScorer({
  port: llm,
  schema: QualitySchema,
  schemaName: "lead-fit",
  rubric: "Score the lead on fit (1-10) for our enterprise SaaS product.",
  examples: `
    "VP Eng at 50-person startup, downloaded our case study" -> 8 (strong fit, evident interest)
    "Solo founder pre-seed, no signal of interest" -> 4 (size mismatch)
    "CTO at 5000-person bank looking at compliance tools" -> 9 (target persona, intent signal)
    "Student exploring tools for a class project" -> 1 (no commercial intent)
  `,
});
```

## Why default temperature 0.1 (not 0)

Pure determinism (temperature 0) makes scoring brittle on borderline cases. The model picks the same number every time, even when 6 vs 7 is essentially a coin flip. Slight randomness:

- Surfaces variance in borderline cases (so you can detect them)
- Doesn't introduce instability (the rubric still drives the answer)

Override if your use case wants strict determinism:

```ts
export const scoreStrictly = createScorer({
  port: llm,
  schema: ScoreSchema,
  schemaName: "x",
  rubric: "...",
  temperature: 0,
});
```

## Reading next

- [`createClassifier`](/capabilities/classifier) — when you want a category, not a number
- [`createAnalyzer`](/capabilities/analyzer) — when you want a structured analysis, not a single score
