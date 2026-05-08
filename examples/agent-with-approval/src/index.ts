/**
 * Tool-use agent with security primitives.
 *
 * The story: a "customer ops" agent helping a human operator handle
 * tickets. It can do three classes of action:
 *
 *   READ-ONLY (executes freely):
 *     - lookupOrder        — fetch order status
 *     - lookupCustomer     — fetch customer profile
 *
 *   DESTRUCTIVE (executes, but flagged):
 *     - cancelOrder        — cancels a pending order
 *
 *   DESTRUCTIVE + REQUIRES CONFIRMATION (executes only after approval):
 *     - issueRefund        — refunds USD to a customer's card
 *
 * The destructive flag is metadata: callers can use it to tag tool
 * invocations in audit logs, mark them as risky in observability,
 * or (as this example does) route them through an approval gate.
 *
 * The requiresConfirmation flag is what makes the security model
 * actually safe: the example wraps every tool call in a gate that
 * blocks-and-asks-for-approval on tools with that flag, regardless
 * of what the model decided. A prompt-injection attack that tricks
 * the model into refunding everyone still hits the approval gate
 * and stops there.
 *
 * Run: ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @llm-ports/example-agent-with-approval start
 */

import { z } from "zod";
import {
  createRegistryFromEnv,
  type ToolDefinition,
  type LLMMessage,
} from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";

// ─── Adapter wiring ───────────────────────────────────────────────

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY before running this example.");
  process.exit(1);
}

const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",
    LLM_TASK_ROUTE_OPS_AGENT: "primary",
  },
  adapters: { anthropic: createAnthropicAdapter({ apiKey }) },
});

const llm = registry.getPort();

// ─── Mock backend for the demo ────────────────────────────────────

const ORDERS: Record<string, { customerId: string; total: number; status: string }> = {
  "ORD-1234": { customerId: "CUST-A", total: 49.99, status: "shipped" },
  "ORD-5678": { customerId: "CUST-B", total: 199.99, status: "processing" },
};
const CUSTOMERS: Record<string, { name: string; email: string; tier: string }> = {
  "CUST-A": { name: "Alice Brown", email: "alice@example.com", tier: "standard" },
  "CUST-B": { name: "Bob Lee", email: "bob@startup.io", tier: "enterprise" },
};

// ─── Tool definitions with security flags ────────────────────────

const lookupOrder: ToolDefinition = {
  name: "lookupOrder",
  description: "Fetch an order's customer, total, and current status.",
  inputSchema: z.object({ orderId: z.string() }),
  // No destructive flag → executes freely. No approval needed for reads.
  execute: async ({ orderId }) => {
    const order = ORDERS[orderId];
    return order ?? { error: `Order ${orderId} not found` };
  },
};

const lookupCustomer: ToolDefinition = {
  name: "lookupCustomer",
  description: "Fetch customer profile by ID. Read-only.",
  inputSchema: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => {
    const cust = CUSTOMERS[customerId];
    return cust ?? { error: `Customer ${customerId} not found` };
  },
};

const cancelOrder: ToolDefinition = {
  name: "cancelOrder",
  description: "Cancel an order. Only works if status is 'processing' or 'pending'.",
  inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
  destructive: true, // ← flag: this writes / deletes state
  // No requiresConfirmation flag here — the agent can autonomously cancel
  // in-progress orders. Adjust per your risk tolerance.
  execute: async ({ orderId, reason }) => {
    const order = ORDERS[orderId];
    if (!order) return { error: `Order ${orderId} not found` };
    if (order.status === "shipped") {
      return { error: "Order has shipped; refund instead of cancel" };
    }
    order.status = "cancelled";
    return { orderId, cancelled: true, reason };
  },
  maxOutputBytes: 500, // truncate any tool output that exceeds 500 bytes
};

const issueRefund: ToolDefinition = {
  name: "issueRefund",
  description:
    "Refund USD to the customer's payment method. Only call this when the operator has confirmed the amount and customer.",
  inputSchema: z.object({
    customerId: z.string(),
    amountUSD: z.number().positive(),
    reason: z.string(),
  }),
  destructive: true,
  requiresConfirmation: true, // ← the key flag: human must approve before this fires
  execute: async ({ customerId, amountUSD, reason }) => {
    // In production, this would hit your payments API. Here we just
    // log and pretend it succeeded.
    console.log(
      `   💳 [Stripe stub] refunded $${amountUSD.toFixed(2)} to ${customerId} for: ${reason}`,
    );
    return { customerId, refundedUSD: amountUSD, refundId: `RF-${Date.now()}`, reason };
  },
  maxOutputBytes: 500,
};

// ─── Wrap the tool dictionary in an approval gate ─────────────────

/**
 * Wraps each tool in a guard:
 *   - Tools without `requiresConfirmation`: execute as normal
 *   - Tools with `requiresConfirmation`: block, ask the operator (here
 *     simulated with auto-approve after a printed prompt), then execute
 *     only if approved
 *
 * In a real ops dashboard this would surface a UI prompt; in a Slack
 * bot it would post a message with Approve/Deny buttons; in a CLI it
 * would prompt the operator interactively. This example just prints
 * the request and auto-approves for demo purposes.
 */
function wrapWithApprovalGate(
  tools: Record<string, ToolDefinition>,
  approve: (req: { name: string; input: unknown }) => Promise<boolean>,
): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {};
  for (const [name, def] of Object.entries(tools)) {
    if (def.requiresConfirmation !== true) {
      out[name] = def;
      continue;
    }
    out[name] = {
      ...def,
      execute: async (input: unknown) => {
        console.log(`\n   🛑 APPROVAL REQUIRED: ${name}(${JSON.stringify(input)})`);
        const approved = await approve({ name, input });
        if (!approved) {
          console.log(`   🚫 DENIED — tool not executed`);
          return { error: `Action ${name} was denied by the operator` };
        }
        console.log(`   ✓ approved by operator, executing...`);
        return await def.execute(input as never);
      },
    };
  }
  return out;
}

// Auto-approve for the demo. Real systems block here for human input.
const wrappedTools = wrapWithApprovalGate(
  { lookupOrder, lookupCustomer, cancelOrder, issueRefund },
  async () => true,
);

// ─── Run the agent ────────────────────────────────────────────────

const SYSTEM = `You are a customer-operations assistant. Help the operator handle tickets.

When you need information, use the lookup tools first.
When taking destructive actions (cancel, refund), call the appropriate tool.
Tools marked as requiring confirmation will be reviewed by the human operator before execution; you don't need to ask the user — just call the tool with appropriate arguments and the operator will see the approval request.

Be concise. Don't apologize for asking clarifying questions.`;

interface Scenario {
  description: string;
  userPrompt: string;
}

const scenarios: Scenario[] = [
  {
    description: "Read-only lookup",
    userPrompt: "What's the status of order ORD-1234, and who placed it?",
  },
  {
    description: "Destructive but no confirmation needed",
    userPrompt: "Cancel order ORD-5678 — customer changed their mind.",
  },
  {
    description: "Destructive + requires confirmation",
    userPrompt:
      "The customer for order ORD-1234 reports the item never arrived. Issue them a full refund of $49.99.",
  },
];

console.log("Running customer-ops agent over 3 scenarios...\n");

for (const scenario of scenarios) {
  console.log(`━━━ Scenario: ${scenario.description} ━━━`);
  console.log(`Operator: ${scenario.userPrompt}\n`);

  const messages: LLMMessage[] = [{ role: "user", content: scenario.userPrompt }];

  const result = await llm.runAgent({
    taskType: "ops-agent",
    instructions: SYSTEM,
    messages,
    tools: wrappedTools,
    maxSteps: 5,
    maxOutputTokens: 500,
  });

  console.log(`\n   Agent: ${result.text}`);
  console.log(`   → tool calls: ${result.toolCalls.length}, steps: ${result.stepsTaken}, finished: ${result.terminationReason}, cost: $${result.cost.totalUSD.toFixed(6)}\n`);
}

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("The takeaway: every destructive tool is flagged in metadata,");
console.log("and tools requiring confirmation route through the approval");
console.log("gate. A prompt-injection attack that convinces the model to");
console.log("'refund everyone' still hits the gate and stops there.");
