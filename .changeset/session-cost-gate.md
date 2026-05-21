---
"@llm-ports/core": minor
---

Session-scoped cost gating (closes issue #16).

`Registry.openCostSession({ budgetUSD })` returns a `CostSession` that wraps an LLMPort with a hard USD cap independent of the per-provider hour/day/month gates. Throws `SessionBudgetExceededError` mid-loop when the cap is reached.

```ts
const session = registry.openCostSession({ budgetUSD: 0.50 });
const llm = session.getPort();
try {
  for (const frame of screenCaptureFrames) {
    await llm.generateText({ taskType: "screen_analyze", prompt: [...] });
  }
} finally {
  console.log("session spent:", session.totalSpentUSD());
  session.close();
}
```

Bumped to high priority by alpha.4's `ImageSource.detail = "high"` characterization: continuous screen-capture sessions can burn real money if left running unattended. The per-provider gates still apply on top; session budget is a hard backstop, not a replacement.

Pre-check semantics: the check fires when `spentUSD >= budgetUSD`, so the *next* call after the budget is reached throws. One small overshoot is possible (the call that crosses the budget runs to completion before its cost is counted). For tighter precision, set the session budget slightly below your hard cap.

9 new tests in `@llm-ports/core`.
