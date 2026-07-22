/**
 * adapter-aider tests. Uses process.execPath (node) as a stand-in
 * for the aider CLI to verify happy-path shape without depending on
 * a real aider install; a real integration test would live in
 * a separate opt-in suite.
 */

import { tmpdir } from "node:os";
import { AdapterInternalError } from "@llm-ports/core";
import { createCollectingSink } from "@llm-ports/observability-contract";
import { describe, expect, it, beforeAll } from "vitest";
import { createAiderAdapter, type AiderAdapter } from "../src/index.js";

const workingDirectory = tmpdir();

describe("createAiderAdapter (Shape A)", () => {
  it("exposes name = 'aider'", () => {
    const adapter = createAiderAdapter();
    expect(adapter.name).toBe("aider");
  });

  it("creates an LLMPort with runAgent + 4 unsupported methods", () => {
    const adapter = createAiderAdapter();
    const port = adapter.createLLMPort();
    expect(typeof port.runAgent).toBe("function");
    expect(typeof port.generateText).toBe("function");
    expect(typeof port.generateStructured).toBe("function");
    expect(typeof port.streamText).toBe("function");
    expect(typeof port.streamStructured).toBe("function");
  });

  describe("Unsupported methods throw AdapterInternalError", () => {
    let port: ReturnType<AiderAdapter["createLLMPort"]>;

    beforeAll(() => {
      port = createAiderAdapter().createLLMPort();
    });

    it("generateText throws with a helpful message", async () => {
      await expect(port.generateText({ taskType: "x", messages: [] })).rejects.toBeInstanceOf(
        AdapterInternalError,
      );
    });

    it("generateStructured throws with a helpful message", async () => {
      await expect(
        port.generateStructured({ taskType: "x", messages: [], schema: undefined as never }),
      ).rejects.toBeInstanceOf(AdapterInternalError);
    });

    it("streamText throws when consumed", async () => {
      const stream = port.streamText({ taskType: "x", messages: [] });
      const iterate = async () => {
        for await (const _ of stream) break;
      };
      await expect(iterate()).rejects.toBeInstanceOf(AdapterInternalError);
    });
  });

  describe("runAgent requires providerExtras.aider.workingDirectory", () => {
    it("throws AdapterInternalError when workingDirectory is missing", async () => {
      const port = createAiderAdapter().createLLMPort();
      await expect(
        port.runAgent({
          taskType: "code-edit",
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        }),
      ).rejects.toBeInstanceOf(AdapterInternalError);
    });

    it("throws AdapterInternalError when messages array has no user message", async () => {
      const port = createAiderAdapter().createLLMPort();
      await expect(
        port.runAgent({
          taskType: "code-edit",
          messages: [],
          tools: {},
          providerExtras: { aider: { workingDirectory } },
        } as never),
      ).rejects.toBeInstanceOf(AdapterInternalError);
    });
  });

  describe("runAgent spawns the CLI and captures stdout", () => {
    it("returns a well-formed AgentResult even when the CLI is a stand-in", async () => {
      const adapter = createAiderAdapter({
        cliPath: process.execPath, // node
      });

      const port = adapter.createLLMPort();

      const result = await port.runAgent({
        taskType: "code-edit",
        messages: [{ role: "user", content: "Do the thing" }],
        tools: {},
        providerExtras: {
          aider: { workingDirectory },
        },
      } as never);

      // node was called with aider-shaped args it doesn't understand;
      // it'll exit nonzero. The adapter's success path still returns
      // a well-formed shape.
      expect(result).toBeDefined();
      expect(result.providerAlias).toBe("aider");
      expect(typeof result.text).toBe("string");
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(result.terminationReason).toBe("completed");
    });
  });

  describe("Observability emission", () => {
    it("emits llm.operation.started and llm.attempt.started when observability is wired", async () => {
      const sink = createCollectingSink();
      const adapter = createAiderAdapter({
        cliPath: process.execPath,
        observability: {
          sink,
          source: { library: "test", library_version: "0.0.0" },
        },
      });
      const port = adapter.createLLMPort();

      try {
        await port.runAgent({
          taskType: "code-edit",
          messages: [{ role: "user", content: "test" }],
          tools: {},
          providerExtras: { aider: { workingDirectory } },
        } as never);
      } catch {
        // node stand-in may or may not fail; started events still fire.
      }

      const startedEvents = sink.events.filter((e) => e.event_type === "llm.operation.started");
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      const attemptStartedEvents = sink.events.filter((e) => e.event_type === "llm.attempt.started");
      expect(attemptStartedEvents.length).toBeGreaterThanOrEqual(1);

      const operationIds = new Set(sink.events.map((e) => e.operation_id));
      expect(operationIds.size).toBe(1);
    });
  });

  describe("Options passthrough", () => {
    it("accepts defaultModel in adapter options", () => {
      const adapter = createAiderAdapter({ defaultModel: "gpt-4o" });
      expect(adapter.name).toBe("aider");
    });

    it("accepts defaultEditFormat in adapter options", () => {
      const adapter = createAiderAdapter({ defaultEditFormat: "diff" });
      expect(adapter.name).toBe("aider");
    });

    it("accepts env overrides in adapter options", () => {
      const adapter = createAiderAdapter({ env: { OPENAI_API_KEY: "sk-test" } });
      expect(adapter.name).toBe("aider");
    });
  });
});
