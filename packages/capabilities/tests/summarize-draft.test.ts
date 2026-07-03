import { describe, expect, it } from "vitest";
import { createDrafter, createSummarizer } from "../src/index.js";
import { createFakePort, getSystemContent, getUserContent } from "./helpers/fake-port.js";

describe("createSummarizer", () => {
  it("returns the summarized text", async () => {
    const fake = createFakePort();
    fake.enqueueText("- key point 1\n- key point 2");
    const summarize = createSummarizer({ port: fake.port });
    const result = await summarize({ content: "long input text..." });
    expect(result).toBe("- key point 1\n- key point 2");
  });

  it("uses default temperature 0.2", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const summarize = createSummarizer({ port: fake.port });
    await summarize({ content: "x" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0.2 });
  });

  it("uses taskType 'summarize' by default", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const summarize = createSummarizer({ port: fake.port });
    await summarize({ content: "x" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "summarize" });
  });

  it("includes targetWords in the system prompt", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const summarize = createSummarizer({ port: fake.port, targetWords: 50 });
    await summarize({ content: "x" });
    const opts = fake.calls[0]!.options;
    expect(getSystemContent(opts)).toContain("about 50 words");
  });
});

describe("createDrafter", () => {
  it("returns the generated text", async () => {
    const fake = createFakePort();
    fake.enqueueText("Hi Alice, ...");
    const draft = createDrafter({
      port: fake.port,
      persona: "Friendly professional. Direct, warm, no filler.",
    });
    const result = await draft({ instructions: "Reply to Alice asking for a meeting." });
    expect(result).toBe("Hi Alice, ...");
  });

  it("uses default temperature 0.4", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const draft = createDrafter({ port: fake.port, persona: "writer" });
    await draft({ instructions: "go" });
    expect(fake.calls[0]?.options).toMatchObject({ temperature: 0.4 });
  });

  it("uses taskType 'draft' by default", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const draft = createDrafter({ port: fake.port, persona: "writer" });
    await draft({ instructions: "go" });
    expect(fake.calls[0]?.options).toMatchObject({ taskType: "draft" });
  });

  it("includes the persona, channel constraint, and anti-patterns in the system prompt", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const draft = createDrafter({
      port: fake.port,
      persona: "concise warm",
      channelConstraint: "SMS, max 160 chars",
      antiPatterns: "never say 'reach out'",
    });
    await draft({ instructions: "go" });
    const opts = fake.calls[0]!.options;
    expect(getSystemContent(opts)).toContain("concise warm");
    expect(getSystemContent(opts)).toContain("SMS, max 160 chars");
    expect(getSystemContent(opts)).toContain("never say 'reach out'");
  });

  it("truncates output when maxLength is exceeded", async () => {
    const fake = createFakePort();
    fake.enqueueText("a".repeat(500));
    const draft = createDrafter({
      port: fake.port,
      persona: "writer",
      maxLength: 100,
    });
    const result = await draft({ instructions: "go" });
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("includes thread history wrapped in a thread tag", async () => {
    const fake = createFakePort();
    fake.enqueueText("ok");
    const draft = createDrafter({ port: fake.port, persona: "writer" });
    await draft({
      instructions: "reply",
      threadHistory: "Previous: hello\nMe: hi",
    });
    const opts = fake.calls[0]!.options;
    expect(getUserContent(opts)).toContain("<thread>");
    expect(getUserContent(opts)).toContain("Previous: hello");
  });
});
