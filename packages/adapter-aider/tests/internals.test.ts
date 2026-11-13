/**
 * adapter-aider — unit tests for the pure internal helpers that
 * make up the CLI-arg contract. Tests hit `../src/adapter.js`
 * directly (not the package index), so these helpers stay
 * unpublished but still exercised.
 *
 * Motivation: the top-level adapter.test.ts covers shape and error
 * paths; without these, `buildAiderArgs` would be completely
 * untested. If aider ever renames a flag or reorders its arg
 * conventions, these tests fail fast rather than silently ship
 * a broken subprocess invocation.
 */

import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AdapterInternalError } from "@llm-ports/core";
import { createCollectingSink } from "@llm-ports/observability-contract";
import {
  buildAiderArgs,
  createAiderAdapter,
  extractPromptFromMessages,
  assertToolsUnsupported,
} from "../src/adapter.js";

describe("buildAiderArgs — CLI arg contract", () => {
  it("minimal invocation (no model, no editFormat, yesAlways=true, verbose=false)", () => {
    const args = buildAiderArgs({
      prompt: "hello",
      files: [],
      yesAlways: true,
      verbose: false,
    });
    expect(args).toEqual(["--no-stream", "--yes-always", "--message", "hello"]);
  });

  it("yesAlways: false → --yes-always is omitted", () => {
    const args = buildAiderArgs({
      prompt: "p",
      files: [],
      yesAlways: false,
      verbose: false,
    });
    expect(args).not.toContain("--yes-always");
    // --no-stream still leads.
    expect(args[0]).toBe("--no-stream");
  });

  it("verbose: true → --verbose appears before --message", () => {
    const args = buildAiderArgs({
      prompt: "p",
      files: [],
      yesAlways: true,
      verbose: true,
    });
    expect(args).toContain("--verbose");
    const verboseIndex = args.indexOf("--verbose");
    const messageIndex = args.indexOf("--message");
    expect(verboseIndex).toBeLessThan(messageIndex);
  });

  it("model → --model MODEL appears in the arg vector", () => {
    const args = buildAiderArgs({
      prompt: "p",
      files: [],
      model: "gpt-4o",
      yesAlways: true,
      verbose: false,
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-4o");
  });

  it("editFormat → --edit-format FMT appears in the arg vector", () => {
    const args = buildAiderArgs({
      prompt: "p",
      files: [],
      editFormat: "diff",
      yesAlways: true,
      verbose: false,
    });
    expect(args).toContain("--edit-format");
    expect(args[args.indexOf("--edit-format") + 1]).toBe("diff");
  });

  it("mapTokens → --map-tokens N (integer serialized as string)", () => {
    const args = buildAiderArgs({
      prompt: "p",
      files: [],
      mapTokens: 4096,
      yesAlways: true,
      verbose: false,
    });
    expect(args).toContain("--map-tokens");
    expect(args[args.indexOf("--map-tokens") + 1]).toBe("4096");
  });

  it("files are positional args appended AFTER --message PROMPT", () => {
    const args = buildAiderArgs({
      prompt: "P",
      files: ["src/a.py", "src/b.py"],
      yesAlways: true,
      verbose: false,
    });
    // --message must come before positional files.
    const messageIndex = args.indexOf("--message");
    const firstFileIndex = args.indexOf("src/a.py");
    const secondFileIndex = args.indexOf("src/b.py");
    expect(messageIndex).toBeLessThan(firstFileIndex);
    expect(firstFileIndex).toBeLessThan(secondFileIndex);
    // Files come at the tail.
    expect(args[args.length - 2]).toBe("src/a.py");
    expect(args[args.length - 1]).toBe("src/b.py");
  });

  it("prompt is always the value paired with --message", () => {
    const args = buildAiderArgs({
      prompt: "the-actual-prompt",
      files: ["src/a.py"],
      yesAlways: true,
      verbose: true,
      model: "gpt-4o",
      editFormat: "diff",
      mapTokens: 4096,
    });
    expect(args[args.indexOf("--message") + 1]).toBe("the-actual-prompt");
  });

  it("no files → --message PROMPT is the trailing pair", () => {
    const args = buildAiderArgs({
      prompt: "P",
      files: [],
      yesAlways: true,
      verbose: false,
    });
    expect(args[args.length - 2]).toBe("--message");
    expect(args[args.length - 1]).toBe("P");
  });
});

describe("extractPromptFromMessages — every part of the call reaches the prompt", () => {
  // Inverted 2026-11-13. The cases these replace specified the defect: one was
  // named "ignores non-user roles entirely", which is the role prompt and every
  // assistant turn being discarded, pinned by a passing test. The Codex adapter
  // carried the identical defect under the identical test name, so this was
  // duplicated rather than overlooked.
  const base = { taskType: "x", instructions: "", tools: {} };

  it("carries every role, in order, labelled", () => {
    const prompt = extractPromptFromMessages({
      ...base,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });
    expect(prompt).toContain("user: first");
    expect(prompt).toContain("assistant: reply");
    expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("reply"));
    expect(prompt.indexOf("reply")).toBeLessThan(prompt.indexOf("second"));
  });

  it("carries system and assistant roles rather than discarding them", () => {
    const prompt = extractPromptFromMessages({
      ...base,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
    });
    expect(prompt).toContain("SYS");
    expect(prompt).toContain("A");
  });

  it("puts the instructions ahead of the transcript", () => {
    const prompt = extractPromptFromMessages({
      ...base,
      instructions: "YOU-REFACTOR-CAREFULLY",
      messages: [{ role: "user", content: "rename the handler" }],
    });
    expect(prompt).toContain("YOU-REFACTOR-CAREFULLY");
    expect(prompt.indexOf("YOU-REFACTOR-CAREFULLY")).toBeLessThan(
      prompt.indexOf("rename the handler"),
    );
  });

  it("stringifies non-string content", () => {
    const prompt = extractPromptFromMessages({
      ...base,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] as unknown as string }],
    });
    expect(prompt).toContain("hi");
  });

  it("accepts a history with no user message, because an assistant turn is still context", () => {
    const prompt = extractPromptFromMessages({
      ...base,
      messages: [{ role: "assistant", content: "only-assistant" }],
    });
    expect(prompt).toContain("only-assistant");
  });

  it("throws when there are no messages at all", () => {
    expect(() => extractPromptFromMessages({ ...base, messages: [] })).toThrow(
      AdapterInternalError,
    );
  });
});

describe("assertToolsUnsupported — a refusal that names what it refused", () => {
  it("passes a call with no tools", () => {
    expect(() =>
      assertToolsUnsupported({
        taskType: "x",
        instructions: "",
        messages: [{ role: "user", content: "hi" }],
        tools: {},
      }),
    ).not.toThrow();
  });

  it("refuses tools and names them, rather than dropping them silently", () => {
    let message = "";
    try {
      assertToolsUnsupported({
        taskType: "x",
        instructions: "",
        messages: [{ role: "user", content: "hi" }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: { run_tests: { name: "run_tests" } as any },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("tools");
    expect(message).toContain("run_tests");
  });
});

describe("Failure-lifecycle events fire on spawn error", () => {
  it("emits attempt.failed and operation.failed when the CLI cannot be spawned", async () => {
    const sink = createCollectingSink();
    const adapter = createAiderAdapter({
      cliPath: "/definitely-not-a-real-binary-xyzzy-12345",
      observability: {
        sink,
        source: { library: "test", library_version: "0.0.0" },
      },
    });
    const port = adapter.createLLMPort();

    await expect(
      port.runAgent({
        taskType: "code-edit",
        messages: [{ role: "user", content: "test" }],
        tools: {},
        providerExtras: { aider: { workingDirectory: tmpdir() } },
      } as never),
    ).rejects.toBeDefined();

    const failedAttempts = sink.events.filter((e) => e.event_type === "llm.attempt.failed");
    const failedOps = sink.events.filter((e) => e.event_type === "llm.operation.failed");
    expect(failedAttempts.length).toBe(1);
    expect(failedOps.length).toBe(1);

    // Failed events carry an ErrorInfo with cause_category == "port_internal".
    const attemptData = failedAttempts[0]!.data as { error: { cause_category: string } };
    expect(attemptData.error.cause_category).toBe("port_internal");
  });
});
