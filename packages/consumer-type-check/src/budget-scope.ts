/**
 * Sample-use: alpha.20 BudgetScope + budgetScope per-call field on every
 * request option type. If a future release drops or renames any of these,
 * this file fails to typecheck.
 *
 * Also exercises the alpha.19.1 → alpha.20 BudgetLimit shape change. The
 * "requestsPerHour optional" change is the breaking item the migration
 * page calls out — this file proves the new shape compiles cleanly and
 * the `?? Infinity` pattern works.
 */

import type {
  BudgetGate,
  BudgetLimit,
  BudgetScope,
  BudgetScopeRef,
  CostLimit,
  GenerateStructuredOptions,
  GenerateTextOptions,
  LLMPort,
  RunAgentOptions,
  SessionGrainLimits,
  StreamStructuredOptions,
  StreamTextOptions,
} from "@llm-ports/core";

// Scope values exercised explicitly so a rename catches.
const scopes: BudgetScope[] = ["tenant", "customer", "user", "agent", "session"];

const ref: BudgetScopeRef = { scope: "tenant", scopeId: "acme" };

const gate: BudgetGate = {
  scope: "session",
  scopeId: "cs-001",
  limitUsd: 1.0,
  window: "session",
  onExceed: "throw",
};

// BudgetLimit (alpha.20 shape).
const limitMinute: BudgetLimit = { kind: "requests", perMinute: 30 };
const limitHour: BudgetLimit = { kind: "requests", perHour: 500, requestsPerHour: 500 };
const limitSession: BudgetLimit = { kind: "requests", perSession: 50 };
const limitUnlimited: BudgetLimit = { kind: "unlimited" };

// CostLimit (alpha.20 shape).
const costMinute: CostLimit = { kind: "usd", perMinute: 0.5 };
const costSession: CostLimit = { kind: "usd", perSession: 1.0 };

// SessionGrainLimits.
const grain: SessionGrainLimits = {
  totalTokensPerSession: 50_000,
  toolCallsPerSession: 8,
};

// The breaking thing the migration page covers: requestsPerHour is now
// optional. The strict-mode-friendly read is via `??`.
function readRph(limit: BudgetLimit): number {
  if (limit.kind === "unlimited") return Infinity;
  return limit.requestsPerHour ?? Infinity;
}

// Per-call budgetScope on every request option type.
declare const port: LLMPort;

async function callEvery(): Promise<void> {
  const textOpts: GenerateTextOptions = {
    taskType: "triage",
    prompt: "hi",
    budgetScope: ref,
  };
  const structOpts: GenerateStructuredOptions<{ ok: boolean }> = {
    taskType: "triage",
    prompt: "hi",
    schema: { _output: { ok: true } } as unknown as GenerateStructuredOptions<{ ok: boolean }>["schema"],
    budgetScope: { scope: "session", scopeId: "cs-001" },
  };
  const streamTextOpts: StreamTextOptions = {
    taskType: "x",
    prompt: "hi",
    budgetScope: { scope: "agent", scopeId: "research-agent-7" },
  };
  const streamStructOpts: StreamStructuredOptions<{ ok: boolean }> = {
    taskType: "x",
    prompt: "hi",
    schema: structOpts.schema,
    budgetScope: { scope: "customer", scopeId: "cust-42" },
  };
  const agentOpts: RunAgentOptions = {
    taskType: "x",
    instructions: "go",
    messages: [],
    tools: {},
    budgetScope: { scope: "user", scopeId: "babak" },
  };

  await port.generateText(textOpts);
  await port.generateStructured(structOpts);
  void port.streamText(streamTextOpts);
  void port.streamStructured(streamStructOpts);
  await port.runAgent(agentOpts);
}

void scopes;
void ref;
void gate;
void limitMinute;
void limitHour;
void limitSession;
void limitUnlimited;
void costMinute;
void costSession;
void grain;
void readRph;
void callEvery;
