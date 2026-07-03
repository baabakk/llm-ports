import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnalyzer, createPlanner } from "../src/index.js";
import { createFakePort, getSystemContent, getUserContent } from "./helpers/fake-port.js";

describe("createPlanner", () => {
  const PlanSchema = z.object({
    steps: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()).default([]),
      }),
    ),
  });

  it("returns the validated plan", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      steps: [
        { id: "s1", description: "fetch contact", dependsOn: [] },
        { id: "s2", description: "draft reply", dependsOn: ["s1"] },
      ],
    });
    const plan = createPlanner({
      port: fake.port,
      schema: PlanSchema,
      schemaName: "email-reply-plan",
    });
    const result = await plan({ goal: "reply to Alice's email" });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.dependsOn).toEqual(["s1"]);
  });

  it("uses default temperature 0.2", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ steps: [] });
    const plan = createPlanner({
      port: fake.port,
      schema: PlanSchema,
      schemaName: "x",
    });
    await plan({ goal: "x" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0.2 });
  });

  it("uses taskType 'plan' by default", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ steps: [] });
    const plan = createPlanner({
      port: fake.port,
      schema: PlanSchema,
      schemaName: "x",
    });
    await plan({ goal: "x" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "plan" });
  });

  it("includes tool catalog in the system prompt", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ steps: [] });
    const plan = createPlanner({
      port: fake.port,
      schema: PlanSchema,
      schemaName: "x",
      toolCatalog: "fetchEmail, draftReply, sendEmail",
    });
    await plan({ goal: "x" });
    const opts = fake.calls[0]!.options;
    expect(getSystemContent(opts)).toContain("fetchEmail, draftReply, sendEmail");
  });
});

describe("createAnalyzer", () => {
  const SwotSchema = z.object({
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    opportunities: z.array(z.string()),
    threats: z.array(z.string()),
    recommendation: z.string(),
  });

  it("returns the validated analysis", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      strengths: ["clear value prop"],
      weaknesses: ["small team"],
      opportunities: ["growing market"],
      threats: ["incumbent giants"],
      recommendation: "focus on niche",
    });
    const analyze = createAnalyzer({
      port: fake.port,
      schema: SwotSchema,
      schemaName: "swot",
      framework: "SWOT (strengths/weaknesses/opportunities/threats), then a one-sentence recommendation",
    });
    const result = await analyze({ content: "startup idea: ..." });
    expect(result.strengths).toContain("clear value prop");
    expect(result.recommendation).toBe("focus on niche");
  });

  it("uses default temperature 0.3", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: [],
      recommendation: "",
    });
    const analyze = createAnalyzer({
      port: fake.port,
      schema: SwotSchema,
      schemaName: "x",
      framework: "SWOT",
    });
    await analyze({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0.3 });
  });

  it("uses taskType 'analyze' by default", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: [],
      recommendation: "",
    });
    const analyze = createAnalyzer({
      port: fake.port,
      schema: SwotSchema,
      schemaName: "x",
      framework: "SWOT",
    });
    await analyze({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "analyze" });
  });

  it("appends the question when provided", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      strengths: [],
      weaknesses: [],
      opportunities: [],
      threats: [],
      recommendation: "",
    });
    const analyze = createAnalyzer({
      port: fake.port,
      schema: SwotSchema,
      schemaName: "x",
      framework: "SWOT",
    });
    await analyze({ content: "biz", question: "Should we proceed?" });
    const opts = fake.calls[0]!.options;
    expect(getUserContent(opts)).toContain("Should we proceed?");
  });
});
