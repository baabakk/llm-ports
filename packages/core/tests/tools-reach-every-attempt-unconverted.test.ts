/**
 * Each failover attempt receives the original tool definitions.
 *
 * Gate item 9 asks that tool schemas be converted per attempt and never
 * hoisted above failover. **Investigated 2026-11-13 and the defect is not
 * present**: the Registry never converts tools at all. Each adapter converts
 * inside its own call, from the definitions the Registry passed it, and no
 * adapter memoizes the result.
 *
 * That makes this a regression test rather than a fix. The property it pins is
 * the one the item is really about: **what reaches attempt two is the caller's
 * `ToolDefinition`, not an artifact shaped for attempt one.** A provider's
 * schema dialect is its own, so a converted schema hoisted above the chain
 * would reach the second provider in the first provider's format, and the
 * symptom would be a model that misreads its own tools rather than an error.
 *
 * Written because the property is invisible: nothing in the Registry mentions
 * tools, so it holds by omission, and an omission is exactly what a later
 * optimisation removes. The item's original report came from the public issue
 * queue and is not in this repository, so if it described something other than
 * this, this test does not cover it. Recorded in
 * `TD-LLMPORTS-ITEM-9-ORIGINAL-REPORT-NOT-IN-THE-REPOSITORY`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRegistryFromEnv,
  wrapProviderError,
  type AdapterRegistration,
  type LLMPort,
  type RunAgentOptions,
  type ToolDefinition,
} from "../src/index.js";

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** Records the tool definitions each attempt was handed. */
function recordingPort(alias: string, seen: RunAgentOptions[], fail: boolean): LLMPort {
  return {
    async runAgent(options: RunAgentOptions) {
      seen.push(options);
      if (fail) {
        throw wrapProviderError(alias, Object.assign(new Error("HTTP 503"), { status: 503 }));
      }
      return {
        text: "ok",
        messages: [],
        toolCalls: [],
        usage: USAGE,
        modelId: "m",
        providerAlias: alias,
        latencyMs: 1,
        stepsTaken: 1,
        terminationReason: "completed" as const,
      };
    },
  } as unknown as LLMPort;
}

function adapter(name: string, port: LLMPort): AdapterRegistration {
  return { name, pricing: { m: { inputPer1M: 1, outputPer1M: 1 } }, createLLMPort: () => port };
}

describe("tool definitions reach every attempt in the chain", () => {
  it("hands the second provider the caller's definitions, not the first provider's conversion", async () => {
    const seenByFirst: RunAgentOptions[] = [];
    const seenBySecond: RunAgentOptions[] = [];

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FIRST: "alpha|m|req:100/hour",
        LLM_PROVIDER_SECOND: "beta|m|req:100/hour",
        LLM_TASK_ROUTE_ASSIST: "first,second",
      },
      adapters: {
        alpha: adapter("alpha", recordingPort("first", seenByFirst, true)),
        beta: adapter("beta", recordingPort("second", seenBySecond, false)),
      },
    });

    const inputSchema = z.object({ id: z.string() });
    const tools: Record<string, ToolDefinition> = {
      lookup_invoice: {
        name: "lookup_invoice",
        description: "Look up an invoice by id",
        inputSchema,
        execute: async () => ({ ok: true }),
      },
    };

    await registry.getPort().runAgent({
      taskType: "assist",
      instructions: "be helpful",
      messages: [{ role: "user", content: "look it up" }],
      tools,
    });

    // Both were attempted, which is what makes the rest meaningful.
    expect(seenByFirst).toHaveLength(1);
    expect(seenBySecond).toHaveLength(1);

    // Identity, not equality. A converted artifact would be a different
    // object, and so would a defensive copy that dropped a Zod refinement.
    // Asserting identity is what catches a future hoist, because a hoisted
    // conversion cannot produce the caller's own object twice.
    expect(seenByFirst[0]!.tools.lookup_invoice!.inputSchema).toBe(inputSchema);
    expect(seenBySecond[0]!.tools.lookup_invoice!.inputSchema).toBe(inputSchema);
    expect(seenBySecond[0]!.tools).toBe(tools);
  });

  it("carries a JSON Schema tool to the second provider too", async () => {
    // The form added in 1.0.0-rc.36 travels the same path, and a hoist would
    // break it the same way.
    const seenByFirst: RunAgentOptions[] = [];
    const seenBySecond: RunAgentOptions[] = [];

    const registry = createRegistryFromEnv({
      env: {
        LLM_PROVIDER_FIRST: "alpha|m|req:100/hour",
        LLM_PROVIDER_SECOND: "beta|m|req:100/hour",
        LLM_TASK_ROUTE_ASSIST: "first,second",
      },
      adapters: {
        alpha: adapter("alpha", recordingPort("first", seenByFirst, true)),
        beta: adapter("beta", recordingPort("second", seenBySecond, false)),
      },
    });

    const inputJsonSchema = { type: "object", properties: { id: { type: "string" } } };

    await registry.getPort().runAgent({
      taskType: "assist",
      instructions: "be helpful",
      messages: [{ role: "user", content: "look it up" }],
      tools: {
        lookup_invoice: {
          name: "lookup_invoice",
          description: "Look up an invoice by id",
          inputJsonSchema,
          execute: async () => ({ ok: true }),
        },
      },
    });

    expect(seenBySecond[0]!.tools.lookup_invoice!.inputJsonSchema).toBe(inputJsonSchema);
  });
});
