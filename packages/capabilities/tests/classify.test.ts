import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClassifier, type CapabilityEvent } from "../src/index.js";
import { createFakePort } from "./helpers/fake-port.js";

const Schema = z.object({
  intent: z.enum(["question", "request", "complaint"]),
  reasoning: z.string(),
});

describe("createClassifier", () => {
  it("returns the validated typed result", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "request", reasoning: "implies action" });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      rubric: "question, request, complaint",
    });
    const result = await classify({ content: "Can I get a refund?" });
    expect(result).toEqual({ intent: "request", reasoning: "implies action" });
  });

  it("uses taskType 'classify' by default", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "question", reasoning: "asking" });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
    });
    await classify({ content: "what is the policy?" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "classify" });
  });

  it("respects taskType override", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "question", reasoning: "asking" });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      taskType: "triage",
    });
    await classify({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "triage" });
  });

  it("invokes onBeforeCall, onResult, and never re-throws hook errors", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "complaint", reasoning: "neg" });
    const onBefore = vi.fn();
    const onResult = vi.fn(() => {
      throw new Error("hook should not break the call");
    });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      onBeforeCall: onBefore,
      onResult,
    });
    const result = await classify({ content: "this is broken" });
    expect(result.intent).toBe("complaint");
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("invokes onError with the error and re-throws", async () => {
    const fake = createFakePort();
    fake.enqueueError(new Error("boom"));
    const onError = vi.fn();
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      onError,
    });
    await expect(classify({ content: "?" })).rejects.toThrow(/boom/);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("resolves async rubric and systemContext", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "question", reasoning: "ok" });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      rubric: async () => "dynamic rubric",
      systemContext: async (input) => `len=${(input.content as string).length}`,
    });
    await classify({ content: "hi" });
    const opts = fake.calls[0]!.options as { instructions: string };
    expect(opts.instructions).toContain("dynamic rubric");
    expect(opts.instructions).toContain("len=2");
  });

  it("merges systemContext with per-call contextOverride", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ intent: "question", reasoning: "" });
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      systemContext: "global ctx",
    });
    await classify({ content: "?", contextOverride: "per-call override" });
    const opts = fake.calls[0]!.options as { instructions: string };
    expect(opts.instructions).toContain("global ctx");
    expect(opts.instructions).toContain("per-call override");
  });

  it("emits a CapabilityEvent with usage, cost, and validation attempts", async () => {
    const fake = createFakePort("test-alias", "test-model");
    fake.enqueueStructured(
      { intent: "request", reasoning: "x" },
      { usage: { inputTokens: 50, outputTokens: 10 } },
    );
    let captured: CapabilityEvent<unknown> | null = null;
    const classify = createClassifier({
      port: fake.port,
      schema: Schema,
      schemaName: "user-intent",
      onResult: (e) => {
        captured = e;
      },
    });
    await classify({ content: "?" });
    expect(captured).not.toBeNull();
    expect(captured!.providerAlias).toBe("test-alias");
    expect(captured!.modelId).toBe("test-model");
    expect(captured!.usage.totalTokens).toBe(60);
    expect(captured!.cost.totalUSD).toBeGreaterThan(0);
    expect(captured!.capability).toBe("classify");
    expect(captured!.validationAttempts).toBe(1);
  });
});
