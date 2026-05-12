/**
 * Closes #1 (Anthropic half). Verifies that ToolDefinition.inputSchema gets
 * converted to real JSON Schema before being sent to the Messages API — not
 * the `{ type: "object", properties: {} }` stub it used to be.
 *
 * Strategy: mock the SDK, run a runAgent step, capture the request the
 * adapter passed to messages.create, inspect the `tools[].input_schema` shape.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildAnthropicResponse,
  mockCreate,
  resetMocks,
} from "../helpers/mock-sdk.js";
import { createAnthropicAdapter } from "../../src/index.js";

beforeEach(() => {
  resetMocks();
});

describe("#1 — Zod tool input schemas are converted to real JSON Schema", () => {
  it("flat object schema produces properties + required fields the model can read", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("claude-haiku-4-5", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["done"],
        inputTokens: 10,
        outputTokens: 5,
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

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const req = mockCreate.mock.calls[0]?.[0] as {
      tools: Array<{
        name: string;
        description?: string;
        input_schema: {
          type: "object";
          properties: Record<string, unknown>;
          required?: string[];
        };
      }>;
    };
    const inputSchema = req.tools[0]!.input_schema;

    expect(inputSchema.type).toBe("object");
    expect(Object.keys(inputSchema.properties)).toEqual(
      expect.arrayContaining(["orderId", "includeShipping"]),
    );
    expect((inputSchema.properties["orderId"] as { type: string }).type).toBe(
      "string",
    );
    expect(
      (inputSchema.properties["includeShipping"] as { type: string }).type,
    ).toBe("boolean");
    // orderId is required, includeShipping is not (standard JSON Schema for Anthropic)
    expect(inputSchema.required).toEqual(["orderId"]);
  });

  it("nested object schema preserves nesting", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("claude-haiku-4-5", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["done"],
        inputTokens: 10,
        outputTokens: 5,
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

    const req = mockCreate.mock.calls[0]?.[0] as {
      tools: Array<{
        input_schema: {
          properties: Record<string, unknown>;
        };
      }>;
    };
    const inputSchema = req.tools[0]!.input_schema;
    const addressProp = inputSchema.properties["address"] as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(addressProp.type).toBe("object");
    expect(Object.keys(addressProp.properties)).toEqual(
      expect.arrayContaining(["street", "city", "zip"]),
    );
  });

  it("non-Zod input falls back to the safe {} shape without crashing", async () => {
    const adapter = createAnthropicAdapter({ apiKey: "test" });
    const port = adapter.createLLMPort("claude-haiku-4-5", "live");

    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse({
        textBlocks: ["done"],
        inputTokens: 10,
        outputTokens: 5,
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
          inputSchema: { not: "a zod schema" } as never,
          execute: async () => "ok",
        },
      },
      maxSteps: 1,
      maxOutputTokens: 50,
    });

    const req = mockCreate.mock.calls[0]?.[0] as {
      tools: Array<{ input_schema: { type: string } }>;
    };
    expect(req.tools[0]!.input_schema.type).toBe("object");
  });
});
