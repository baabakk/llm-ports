/**
 * Streaming chat server example.
 *
 * Three Express routes that cover the most common LLM UX patterns:
 *
 *   POST /chat                — one-shot generateText
 *   POST /chat/stream         — Server-Sent Events streamText
 *   POST /chat/agent          — tool-augmented runAgent
 *
 * Each route accepts:
 *   { messages: [{ role: "user" | "assistant", content: string }, ...] }
 *
 * The Express bits are 30 lines of glue. The interesting code is the
 * three handler functions, each ~10 lines. That's the point: a
 * production chat backend is mostly LLM plumbing, and llm-ports keeps
 * the plumbing thin.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @llm-ports/example-streaming-chat start
 *
 * Then in another terminal:
 *
 *   # one-shot
 *   curl -X POST http://localhost:3000/chat \
 *     -H "Content-Type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'
 *
 *   # streaming (Server-Sent Events)
 *   curl -N -X POST http://localhost:3000/chat/stream \
 *     -H "Content-Type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"Count from 1 to 10."}]}'
 *
 *   # tool-augmented agent (calls the lookupOrder tool)
 *   curl -X POST http://localhost:3000/chat/agent \
 *     -H "Content-Type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"Where is order ORD-1234?"}]}'
 */

import express, { type Request, type Response } from "express";
import { z } from "zod";
import {
  createRegistryFromEnv,
  type LLMMessage,
  type ToolDefinition,
} from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createOpenAIAdapter } from "@llm-ports/adapter-openai";

// ─── Adapter wiring ───────────────────────────────────────────────

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const openaiKey = process.env["OPENAI_API_KEY"];

if (!anthropicKey && !openaiKey) {
  console.error("Set at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY before running.");
  process.exit(1);
}

const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:10/day",
    LLM_PROVIDER_BACKUP: "openai|gpt-4o-mini|cost:20/day",
    LLM_TASK_ROUTE_CHAT: "primary,backup",
    LLM_TASK_ROUTE_AGENT: "primary,backup",
  },
  adapters: {
    ...(anthropicKey
      ? { anthropic: createAnthropicAdapter({ apiKey: anthropicKey }) }
      : {}),
    ...(openaiKey ? { openai: createOpenAIAdapter({ apiKey: openaiKey }) } : {}),
  },
});

const llm = registry.getPort();

// ─── Tools for the agent route ───────────────────────────────────

// Fake order lookup. In production this would hit your DB. Read-only,
// so no `destructive` flag and no `requiresConfirmation` flag — the
// agent can call it freely.
const lookupOrder: ToolDefinition = {
  name: "lookupOrder",
  description: "Look up an order by its ID. Returns status and shipping info.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => {
    // Pretend database
    const orders: Record<string, { status: string; eta: string }> = {
      "ORD-1234": { status: "shipped", eta: "2026-05-08" },
      "ORD-5555": { status: "processing", eta: "2026-05-12" },
    };
    return orders[orderId] ?? { error: `Order ${orderId} not found` };
  },
};

// ─── Request validation ──────────────────────────────────────────

const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
});

// ─── Express server ──────────────────────────────────────────────

const app = express();
app.use(express.json());

const SYSTEM = `You are a helpful customer support assistant for Acme Inc.
Be concise. If asked about specific orders, use the lookupOrder tool when available.`;

// Route 1: one-shot chat (non-streaming)
app.post("/chat", async (req: Request, res: Response) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  // Last user message becomes the prompt; prior messages are context. For
  // multi-turn, you'd send the full history through `messages` instead and
  // use runAgent (see /chat/agent below) which natively understands turns.
  const lastUser = parsed.data.messages[parsed.data.messages.length - 1];
  if (!lastUser || lastUser.role !== "user") {
    return res.status(400).json({ error: "Last message must be from the user" });
  }
  try {
    const result = await llm.generateText({
      taskType: "chat",
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: lastUser.content }],
      maxOutputTokens: 500,
    });
    return res.json({
      content: result.text,
      usage: result.usage,
      cost: result.cost.totalUSD,
      provider: result.providerAlias,
      model: result.modelId,
    });
  } catch (err) {
    console.error("[/chat] error:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// Route 2: streaming chat (Server-Sent Events)
app.post("/chat/stream", async (req: Request, res: Response) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const lastUser = parsed.data.messages[parsed.data.messages.length - 1];
  if (!lastUser || lastUser.role !== "user") {
    return res.status(400).json({ error: "Last message must be from the user" });
  }

  // SSE response headers. Browsers and curl -N both understand this format.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // bypass nginx buffering if proxied
  });

  try {
    for await (const chunk of llm.streamText({
      taskType: "chat",
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: lastUser.content }],
      maxOutputTokens: 500,
    })) {
      // SSE format: data: <payload>\n\n
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
    }
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  } catch (err) {
    console.error("[/chat/stream] error:", err);
    res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    res.end();
  }
});

// Route 3: tool-augmented agent (multi-turn, can call tools)
app.post("/chat/agent", async (req: Request, res: Response) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  // The agent route takes the FULL conversation history, including any
  // prior assistant turns and tool results. The runAgent loop will continue
  // calling tools until the model decides it's done or maxSteps is hit.
  const messages: LLMMessage[] = parsed.data.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const result = await llm.runAgent({
      taskType: "agent",
      instructions: SYSTEM,
      messages,
      tools: { lookupOrder },
      maxSteps: 5,
      maxOutputTokens: 1000,
    });
    return res.json({
      content: result.text,
      toolCalls: result.toolCalls,
      stepsTaken: result.stepsTaken,
      terminationReason: result.terminationReason,
      usage: result.usage,
      cost: result.cost.totalUSD,
      provider: result.providerAlias,
    });
  } catch (err) {
    console.error("[/chat/agent] error:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = Number(process.env["PORT"] ?? 3000);
app.listen(PORT, () => {
  console.log(`Streaming chat example listening on http://localhost:${PORT}`);
  console.log(`  POST /chat            — one-shot text`);
  console.log(`  POST /chat/stream     — Server-Sent Events`);
  console.log(`  POST /chat/agent      — tool-augmented agent`);
});
