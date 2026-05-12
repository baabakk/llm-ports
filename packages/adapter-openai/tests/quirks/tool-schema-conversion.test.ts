/**
 * Closes #1. Verifies that ToolDefinition.inputSchema gets converted
 * to real JSON Schema before being sent to the model — not the
 * `{ type: "object", properties: {} }` stub it used to be.
 *
 * Strategy: mock the SDK, run a runAgent step, capture the request
 * the adapter passed to the SDK, inspect the `tools[].function.parameters`
 * shape.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenAIChatResponse,
  mockChatCompletionsCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { _resetLearnedConstraints } from "../../src/capabilities.js";
import { createOpenAIAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
  _resetLearnedConstraints();
});

describe("#1 — Zod tool input schemas are converted to real JSON Schema", () => {
  it("flat object schema produces properties + required fields the model can read", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    await port.runAgent({
      taskType: "t",
      instructions: "x",
      messages: [{ role: "user", content: "go" }],
      tools: {
        lookupOrder: {
          name: "lookupOrder",
          description: "Look up an order by ID",
          inputSchema: z.object({
            orderId: z.string(),
            includeShipping: z.boolean().optional(),
          }),
          execute: async () => "result",
        },
      },
      maxSteps: 1,
      maxOutputTokens: 50,
    });

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
    const req = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      tools: Array<{
        type: "function";
        function: {
          name: string;
          description: string;
          parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
          };
        };
      }>;
    };
    const params = req.tools[0]!.function.parameters;

    // The fix: properties must contain the actual field names + types
    expect(params.type).toBe("object");
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining(["orderId", "includeShipping"]),
    );
    // orderId is a plain string
    const orderIdType = (params.properties["orderId"] as { type: unknown }).type;
    expect(orderIdType).toBe("string");
    // includeShipping is z.boolean().optional() — under target:"openAi" this becomes
    // a nullable boolean ({ type: ["boolean","null"] }) because OpenAI strict mode
    // requires every property in `required` and uses nullability to model optional.
    const incShipType = (
      params.properties["includeShipping"] as { type: unknown }
    ).type;
    expect(
      incShipType === "boolean" ||
        (Array.isArray(incShipType) && incShipType.includes("boolean")),
    ).toBe(true);
    // orderId must be in required. (Under target:"openAi", includeShipping may also
    // be in required because optional fields are modeled as nullable, not omitted.)
    expect(params.required).toContain("orderId");
  });

  it("nested object schema preserves nesting", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    await port.runAgent({
      taskType: "t",
      instructions: "x",
      messages: [{ role: "user", content: "go" }],
      tools: {
        createCustomer: {
          name: "createCustomer",
          description: "Create a customer record",
          inputSchema: z.object({
            name: z.string(),
            address: z.object({
              street: z.string(),
              city: z.string(),
              zip: z.string(),
            }),
          }),
          execute: async () => "created",
        },
      },
      maxSteps: 1,
      maxOutputTokens: 50,
    });

    const req = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      tools: Array<{
        function: {
          parameters: {
            properties: Record<string, unknown>;
          };
        };
      }>;
    };
    const params = req.tools[0]!.function.parameters;
    const addressProp = params.properties["address"] as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(addressProp.type).toBe("object");
    expect(Object.keys(addressProp.properties)).toEqual(
      expect.arrayContaining(["street", "city", "zip"]),
    );
  });

  it("non-Zod input falls back to the safe {} shape without crashing", async () => {
    const adapter = createOpenAIAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("gpt-4o", "live");

    mockChatCompletionsCreate.mockResolvedValueOnce(
      buildOpenAIChatResponse({
        text: "done",
        promptTokens: 10,
        completionTokens: 5,
      }),
    );

    await port.runAgent({
      taskType: "t",
      instructions: "x",
      messages: [{ role: "user", content: "go" }],
      tools: {
        weirdTool: {
          name: "weirdTool",
          description: "Tool with non-Zod schema",
          // Intentionally not a Zod schema — defensive fallback path
          inputSchema: { not: "a zod schema" } as never,
          execute: async () => "ok",
        },
      },
      maxSteps: 1,
      maxOutputTokens: 50,
    });

    // Should not crash; should fall back to the safe shape
    const req = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      tools: Array<{ function: { parameters: { type: string } } }>;
    };
    expect(req.tools[0]!.function.parameters.type).toBe("object");
  });
});
