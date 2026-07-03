import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createExtractor, createScorer } from "../src/index.js";
import { createFakePort, getSystemContent, getUserContent } from "./helpers/fake-port.js";

describe("createScorer", () => {
  const Schema = z.object({
    score: z.number().min(1).max(10),
    reasoning: z.string(),
  });

  it("returns the validated typed result", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ score: 8, reasoning: "well structured" });
    const score = createScorer({
      port: fake.port,
      schema: Schema,
      schemaName: "draft-quality",
      rubric: "1=poor, 10=excellent",
    });
    const result = await score({ content: "professional and concise" });
    expect(result.score).toBe(8);
  });

  it("uses default temperature 0.1", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ score: 5, reasoning: "" });
    const score = createScorer({
      port: fake.port,
      schema: Schema,
      schemaName: "x",
      rubric: "rubric",
    });
    await score({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0.1 });
  });

  it("uses taskType 'score' by default", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ score: 1, reasoning: "" });
    const score = createScorer({
      port: fake.port,
      schema: Schema,
      schemaName: "x",
      rubric: "r",
    });
    await score({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "score" });
  });

  it("includes the rubric in the system prompt", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ score: 1, reasoning: "" });
    const score = createScorer({
      port: fake.port,
      schema: Schema,
      schemaName: "x",
      rubric: "calibrated rubric content",
    });
    await score({ content: "?" });
    const opts = fake.calls[0]!.options;
    expect(getSystemContent(opts)).toContain("calibrated rubric content");
  });
});

describe("createExtractor", () => {
  const Contact = z.object({
    name: z.string(),
    email: z.string().email().nullable(),
    company: z.string().nullable(),
  });

  it("returns the extracted typed object", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({
      name: "Alice",
      email: "alice@example.com",
      company: "Acme",
    });
    const extract = createExtractor({
      port: fake.port,
      schema: Contact,
      schemaName: "contact",
    });
    const result = await extract({ content: "Alice from Acme: alice@example.com" });
    expect(result).toEqual({
      name: "Alice",
      email: "alice@example.com",
      company: "Acme",
    });
  });

  it("uses default temperature 0", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ name: "X", email: null, company: null });
    const extract = createExtractor({
      port: fake.port,
      schema: Contact,
      schemaName: "contact",
    });
    await extract({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0 });
  });

  it("uses taskType 'extract' by default", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ name: "X", email: null, company: null });
    const extract = createExtractor({
      port: fake.port,
      schema: Contact,
      schemaName: "contact",
    });
    await extract({ content: "?" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "extract" });
  });

  it("includes the field guide as rubric", async () => {
    const fake = createFakePort();
    fake.enqueueStructured({ name: "X", email: null, company: null });
    const extract = createExtractor({
      port: fake.port,
      schema: Contact,
      schemaName: "contact",
      fieldGuide: "name: full name; email: address; company: org",
    });
    await extract({ content: "?" });
    const opts = fake.calls[0]!.options;
    expect(getSystemContent(opts)).toContain("name: full name");
  });
});
