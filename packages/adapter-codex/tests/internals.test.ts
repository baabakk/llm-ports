/**
 * adapter-codex — unit tests for the pure internal helpers that
 * make up the CLI-arg contract and the codex --json parse path.
 * Tests hit `../src/adapter.js` directly (not the package index),
 * so these helpers stay unpublished but still exercised.
 *
 * Motivation: the top-level adapter.test.ts covers shape and error
 * paths; without these, `buildCodexArgs` and the parse/derive helpers
 * would be completely untested. If codex ever changes its `--json`
 * event shape or its CLI flag surface, we need these tests to fail
 * fast rather than silently drop to zero tokens.
 */

import { describe, expect, it } from "vitest";
import { AdapterInternalError } from "@llm-ports/core";
import { createCollectingSink } from "@llm-ports/observability-contract";
import {
  buildCodexArgs,
  createCodexAdapter,
  deriveFinalText,
  deriveModelId,
  deriveUsage,
  extractPromptFromMessages,
  parseCodexJsonLines,
  type CodexJsonEvent,
} from "../src/adapter.js";

const WD = "E:/tmp/scratch";

describe("buildCodexArgs — CLI arg contract", () => {
  it("minimal invocation (no model, no autoApprove, no images)", () => {
    const args = buildCodexArgs({
      prompt: "hello",
      workingDirectory: WD,
      sandbox: "workspace-write",
      autoApprove: false,
    });
    expect(args).toEqual(["exec", "--json", "--cd", WD, "-s", "workspace-write", "hello"]);
  });

  it("with model → -m appears between --cd and -s", () => {
    const args = buildCodexArgs({
      prompt: "hi",
      workingDirectory: WD,
      model: "gpt-5-codex",
      sandbox: "workspace-write",
      autoApprove: false,
    });
    expect(args).toEqual([
      "exec",
      "--json",
      "--cd",
      WD,
      "-m",
      "gpt-5-codex",
      "-s",
      "workspace-write",
      "hi",
    ]);
  });

  it("sandbox override reaches the arg vector verbatim", () => {
    const args = buildCodexArgs({
      prompt: "p",
      workingDirectory: WD,
      sandbox: "read-only",
      autoApprove: false,
    });
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
  });

  it("autoApprove: true → --dangerously-bypass-approvals-and-sandbox present", () => {
    const args = buildCodexArgs({
      prompt: "p",
      workingDirectory: WD,
      sandbox: "danger-full-access",
      autoApprove: true,
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("autoApprove: false → --dangerously-bypass-approvals-and-sandbox omitted", () => {
    const args = buildCodexArgs({
      prompt: "p",
      workingDirectory: WD,
      sandbox: "workspace-write",
      autoApprove: false,
    });
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("imageFiles → -i file1 -i file2 (one -i per file)", () => {
    const args = buildCodexArgs({
      prompt: "p",
      workingDirectory: WD,
      sandbox: "workspace-write",
      autoApprove: false,
      imageFiles: ["/tmp/a.png", "/tmp/b.png"],
    });
    const iFlagCount = args.filter((a) => a === "-i").length;
    expect(iFlagCount).toBe(2);
    // -i /tmp/a.png -i /tmp/b.png must appear in order, in front of the trailing prompt.
    const iIndex = args.indexOf("-i");
    expect(args[iIndex + 1]).toBe("/tmp/a.png");
    expect(args[iIndex + 2]).toBe("-i");
    expect(args[iIndex + 3]).toBe("/tmp/b.png");
  });

  it("prompt is ALWAYS the final positional arg", () => {
    const args = buildCodexArgs({
      prompt: "the-actual-prompt",
      workingDirectory: WD,
      model: "gpt-5-codex",
      sandbox: "workspace-write",
      autoApprove: true,
      imageFiles: ["/tmp/a.png"],
    });
    expect(args[args.length - 1]).toBe("the-actual-prompt");
  });
});

describe("parseCodexJsonLines — NDJSON parsing", () => {
  it("parses one JSON object per line", () => {
    const input = `{"type":"a","x":1}\n{"type":"b","x":2}\n{"type":"c","x":3}\n`;
    const events = parseCodexJsonLines(input);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "a", x: 1 });
    expect(events[1]).toMatchObject({ type: "b", x: 2 });
    expect(events[2]).toMatchObject({ type: "c", x: 3 });
  });

  it("tolerates blank lines", () => {
    const input = `\n{"type":"a"}\n\n{"type":"b"}\n\n`;
    const events = parseCodexJsonLines(input);
    expect(events).toHaveLength(2);
  });

  it("tolerates CRLF line endings", () => {
    const input = `{"type":"a"}\r\n{"type":"b"}\r\n`;
    const events = parseCodexJsonLines(input);
    expect(events).toHaveLength(2);
  });

  it("silently drops non-JSON lines rather than throwing", () => {
    const input = `{"type":"a"}\nnot json\n{"type":"b"}\n`;
    const events = parseCodexJsonLines(input);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "a" });
    expect(events[1]).toMatchObject({ type: "b" });
  });

  it("returns [] on empty input", () => {
    expect(parseCodexJsonLines("")).toEqual([]);
    expect(parseCodexJsonLines("\n\n\n")).toEqual([]);
  });
});

describe("deriveUsage — token-count extraction", () => {
  it("returns zeros when no event carries usage", () => {
    const events: CodexJsonEvent[] = [{ type: "started" }, { type: "step" }];
    expect(deriveUsage(events)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("finds usage on the LAST event that carries it (not first)", () => {
    const events: CodexJsonEvent[] = [
      { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      { type: "step" },
      { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    ];
    expect(deriveUsage(events)).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("computes total_tokens as input + output when omitted", () => {
    const events: CodexJsonEvent[] = [{ usage: { input_tokens: 10, output_tokens: 20 } }];
    expect(deriveUsage(events)).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("returns zeros when usage is present but its shape is unexpected", () => {
    // usage is not an object; adapter should return zeros without throwing.
    const events: CodexJsonEvent[] = [{ usage: "not-an-object" as unknown as never }];
    expect(deriveUsage(events)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe("deriveFinalText — extract assistant output", () => {
  it("prefers `text` over `content`", () => {
    const events: CodexJsonEvent[] = [{ text: "T", content: "C" }];
    expect(deriveFinalText(events)).toBe("T");
  });

  it("falls through to `content` when `text` is absent", () => {
    const events: CodexJsonEvent[] = [{ content: "just-content" }];
    expect(deriveFinalText(events)).toBe("just-content");
  });

  it("walks backward — the LAST event's text wins", () => {
    const events: CodexJsonEvent[] = [{ text: "early" }, { type: "middle" }, { text: "final" }];
    expect(deriveFinalText(events)).toBe("final");
  });

  it("returns null when no event carries text or content", () => {
    const events: CodexJsonEvent[] = [{ type: "started" }, { type: "step" }];
    expect(deriveFinalText(events)).toBeNull();
  });
});

describe("deriveModelId — extract effective model", () => {
  it("finds `model` on any event, walking backward", () => {
    const events: CodexJsonEvent[] = [{ model: "gpt-5-codex" }, { type: "step" }];
    expect(deriveModelId(events)).toBe("gpt-5-codex");
  });

  it("prefers the LAST event's model when multiple carry it", () => {
    const events: CodexJsonEvent[] = [{ model: "old" }, { model: "new" }];
    expect(deriveModelId(events)).toBe("new");
  });

  it("returns null when no event carries `model`", () => {
    expect(deriveModelId([{ type: "step" }])).toBeNull();
  });

  it("returns null for empty-string model rather than treating it as a value", () => {
    expect(deriveModelId([{ model: "" }])).toBeNull();
  });
});

describe("extractPromptFromMessages — user-message concatenation", () => {
  it("joins multiple user messages with a blank line", () => {
    const prompt = extractPromptFromMessages({
      taskType: "x",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
      tools: {},
    });
    expect(prompt).toBe("first\n\nsecond");
  });

  it("ignores non-user roles entirely", () => {
    const prompt = extractPromptFromMessages({
      taskType: "x",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
      tools: {},
    });
    expect(prompt).toBe("U");
  });

  it("stringifies non-string content", () => {
    const prompt = extractPromptFromMessages({
      taskType: "x",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] as unknown as string },
      ],
      tools: {},
    });
    expect(prompt).toContain("hi");
  });

  it("throws AdapterInternalError when no user message", () => {
    expect(() =>
      extractPromptFromMessages({
        taskType: "x",
        messages: [{ role: "assistant", content: "only-assistant" }],
        tools: {},
      }),
    ).toThrow(AdapterInternalError);
  });
});

describe("Failure-lifecycle events fire on spawn error", () => {
  it("emits attempt.failed and operation.failed when the CLI cannot be spawned", async () => {
    const sink = createCollectingSink();
    const adapter = createCodexAdapter({
      cliPath: "/definitely-not-a-real-binary-xyzzy-12345",
      observability: {
        sink,
        source: { library: "test", library_version: "0.0.0" },
      },
    });
    const port = adapter.createLLMPort();

    await expect(
      port.runAgent({
        taskType: "code-review",
        messages: [{ role: "user", content: "test" }],
        tools: {},
        providerExtras: { codex: { workingDirectory: WD } },
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
