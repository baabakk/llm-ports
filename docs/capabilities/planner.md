# `createPlanner`

Decompose a goal into ordered or DAG-shaped steps. Returns Zod-validated structured output. Default temperature 0.2 (slight creativity in step ordering, but deterministic enough to reproduce).

You supply the schema for what a "step" looks like. Typical shape: `{ id, description, dependsOn: [...] }`.

## Signature

```ts
function createPlanner<TSchema extends z.ZodTypeAny>(config: {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  strategy?: Resolvable<PlanInput, string>;
  toolCatalog?: Resolvable<PlanInput, string>;
  examples?: Resolvable<PlanInput, string>;
  systemContext?: Resolvable<PlanInput, string>;
  taskType?: string;          // default "plan"
  priority?: LLMPriority;
  temperature?: number;       // default 0.2
  maxOutputTokens?: number;
  onBeforeCall?: (input: PlanInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: PlanInput) => void | Promise<void>;
}): (input: PlanInput) => Promise<z.infer<TSchema>>;

interface PlanInput {
  goal: MessageContent;
  contextOverride?: string;
}
```

## Example: replying to an email

```ts
import { createPlanner } from "@llm-ports/capabilities";
import { z } from "zod";

const PlanSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      tool: z.string().optional(),
      dependsOn: z.array(z.string()).default([]),
    }),
  ),
  rationale: z.string(),
});

export const planEmailReply = createPlanner({
  port: llm,
  schema: PlanSchema,
  schemaName: "email-reply-plan",
  strategy: "Depth-first; minimize dependencies; prefer parallelizable steps.",
  toolCatalog: `
    fetchEmail(threadId): get the email and its history
    getContact(email): look up sender profile
    draftReply(threadId, instructions): draft a reply
    sendReply(threadId, body): send the reply (destructive — needs approval)
  `,
});

const plan = await planEmailReply({
  goal: "Reply to Alice's intro request from yesterday",
});
// {
//   steps: [
//     { id: "s1", description: "Fetch the email thread", tool: "fetchEmail", dependsOn: [] },
//     { id: "s2", description: "Look up Alice's profile", tool: "getContact", dependsOn: [] },
//     { id: "s3", description: "Draft the reply", tool: "draftReply", dependsOn: ["s1", "s2"] },
//     { id: "s4", description: "Send (after user approval)", tool: "sendReply", dependsOn: ["s3"] }
//   ],
//   rationale: "Two independent fetches in parallel, then draft, then send."
// }
```

## With examples

```ts
export const planAnalyticsReport = createPlanner({
  port: llm,
  schema: PlanSchema,
  schemaName: "analytics-report-plan",
  examples: `
    Goal: "Produce a Q2 revenue report"
    Plan:
      s1: Query MRR data from MongoDB                  (deps: [])
      s2: Query churn data from PostgreSQL             (deps: [])
      s3: Compute month-over-month deltas              (deps: [s1, s2])
      s4: Render markdown report with charts            (deps: [s3])
  `,
});
```

## Why the schema is user-supplied

Different applications want different plan shapes:

- Linear pipelines: `steps: [{ id, description }]` (no dependencies)
- DAGs: `steps: [{ id, description, dependsOn }]`
- With acceptance criteria: `steps: [{ ..., done_when }]`
- With cost estimates: `steps: [{ ..., estimatedCost }]`

The capability doesn't pick for you. Pass whatever Zod schema captures the plan structure your executor expects.

## Pairing with execution

Plans are usually consumed by a deterministic executor (Temporal workflow, manual UI walkthrough, automated runner). The planner produces the plan; something else runs it. Don't conflate the two:

```ts
const plan = await planEmailReply({ goal: "..." });
await runPlan(plan);   // your executor, not the LLM
```

## Reading next

- [`createAnalyzer`](/capabilities/analyzer) — when you want to evaluate a plan, not produce one
- [Tool-use security](/guides/security) — when steps include destructive tools
