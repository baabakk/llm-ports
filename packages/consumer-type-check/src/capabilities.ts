/**
 * Sample-use: capability factory inputs include the alpha.19.1 cacheControl
 * field. If a factory drops it, this file fails to typecheck.
 */

import { z } from "zod";
import {
  createClassifier,
  createDrafter,
  createSummarizer,
  type ClassifyInput,
  type DraftInput,
  type SummarizeInput,
} from "@llm-ports/capabilities";

declare const fakePort: import("@llm-ports/core").LLMPort;

const classify = createClassifier({
  port: fakePort,
  schema: z.object({ intent: z.string() }),
  schemaName: "intent",
});

const draft = createDrafter({
  port: fakePort,
  persona: "concise tester",
});

const summarize = createSummarizer({ port: fakePort });

const classifyInput: ClassifyInput = {
  content: "hello",
  cacheControl: { mode: "auto" },
};

const draftInput: DraftInput = {
  instructions: "say hi",
  cacheControl: { mode: "manual", breakpoints: [{ at: "system" }] },
};

const summarizeInput: SummarizeInput = {
  content: "long content",
  cacheControl: { mode: "off" },
};

void classify;
void draft;
void summarize;
void classifyInput;
void draftInput;
void summarizeInput;
