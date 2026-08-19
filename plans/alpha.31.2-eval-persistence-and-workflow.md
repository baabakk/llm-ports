# alpha.31.2 — evaluation persistence and evaluation-workflow tooling

**Status:** Draft, not approved.
**Date:** 2026-08-19
**Scope decision:** both halves together, by owner decision. This is the announced alpha.31 scope, displaced once, now being paid.

---

## 1. What is owed

The README announced, as alpha.31: "persistence backends beyond SQLite (Postgres, ClickHouse), and evaluation-workflow tooling." A single unrelated hotfix shipped under that number instead. This plan delivers the announced scope, with one part withdrawn on verified grounds.

**ClickHouse is withdrawn, not deferred.** The `EvaluationStore` contract requires exact idempotent writes: `write()` returns `true` for a new row and `false` for a dedup hit, and reads must reflect one row per `evaluation_id`. ClickHouse deduplicates only during background merges "at an unknown time," and its own documentation says the `FINAL` read modifier "offers eventual correctness only, it does not guarantee rows will be deduplicated, and you should not rely on it." `insert_deduplication_token` fits better and makes repeat inserts genuine no-ops, but it is bounded to a rolling window and still cannot produce `write()`'s exact boolean without a separate read. The mismatch is structural rather than a matter of effort. Recorded in `TD-LLMPORTS-ALPHA31-EVAL-BACKENDS-DEFERRED`.

---

## 2. Part A: the Postgres backend

Close to a mechanical port of `packages/eval/src/sqlite.ts`, and genuinely low-risk.

- Same thirteen columns and four indexes. `occurred_at` becomes `TIMESTAMPTZ`; score and correction stay JSON-encoded, and should use `jsonb` so future querying inside scores is possible without a migration.
- `pg` as an optional peer dependency, loaded through the same lazy-require pattern used at `sqlite.ts:173`, so a consumer who does not install it still gets the in-memory store and a helpful construction-time error rather than a publish-time failure.
- **Dedup is strictly better here than in SQLite.** `INSERT ... ON CONFLICT DO NOTHING` returns an exact `rowCount`, replacing the SQLite implementation's approach of attempting the insert and catching a unique-constraint error (`sqlite.ts:136`). The `idempotency_key` pre-check at `sqlite.ts:114` collapses into the same statement.
- Tests mirror the existing SQLite suite one-for-one, so behavioural parity across backends is demonstrated rather than asserted.

Part A has no open design questions. It could ship alone.

---

## 3. Part B: the workflow tooling, and the substrate gap it exposes

### 3.1 The working definition

Offered in the roadmap and adopted here pending correction. Four capabilities above the store:

1. Batch judge runs over recorded operations.
2. Sampling plus a review queue for human annotation.
3. A/B comparison of two providers or prompts against the same recorded inputs.
4. Regression detection across a routing or prompt change.

### 3.2 The gap, verified in source

**`@llm-ports/eval` stores evaluations. It does not store what was evaluated.**

- `EvaluationTarget` (`packages/observability-contract/src/evaluation.ts:40`) is a `{ kind, id }` pointer across seven kinds: operation, attempt, response, agent_step, trace, session, artifact. It references an operation by identifier and holds none of its content.
- The sink bridge (`packages/eval/src/sink-bridge.ts`) forwards **only** `evaluation.recorded` events to the store and, in its own words, "every other event type is silently ignored."
- The contract carries `request_fingerprint`, which is a hash. A hash cannot be replayed.

Splitting the four capabilities against that reality:

| Capability | Buildable on today's substrate? |
|---|---|
| Regression detection | **Yes.** Aggregating scores over time, grouped by evaluator, rubric, provider, or window, is pure query work over `EvaluationStore`. |
| Sampling | **Partly.** Evaluation rows can be sampled. A human reviewing one needs to see the prompt and response, which the store does not hold. |
| Batch judge runs | **No.** Requires the operations themselves. There is no operation store. |
| A/B comparison | **No.** Requires the original request. A fingerprint is not an input. |

Two of the four cannot be built as announced without something that does not exist.

### 3.3 The answer: an `OperationSource` port, not an operation store

The tempting fix is to add durable operation storage to this package. **That is the wrong move**, for two reasons.

First, consumers already have this. One stores lifecycle events in ClickHouse via a log pipeline; another will have its own. Building a second, competing store would duplicate infrastructure they run already and force a choice between two copies of the same data.

Second, it is against the architecture. This library abstracts external systems behind ports rather than becoming one.

So: define a read-only port the consumer implements over whatever they already have.

```ts
export interface OperationSource {
  /** Fetch one recorded operation by id, or undefined if unavailable. */
  get(operationId: string): Promise<RecordedOperation | undefined>;
  /** Find recorded operations matching a query, newest first. */
  find(query: OperationQuery): Promise<RecordedOperation[]>;
}
```

`RecordedOperation` carries what the workflow layer actually needs: identifiers, task type, provider alias and model, timings, usage and cost, and **optionally** the request messages and response content.

**Content is optional, and that is not a compromise.** `CapturePolicy` already governs whether content is captured at all, and defaults to strict. A source is therefore entitled to return an operation with no content, and the workflow tooling must treat that as a first-class case rather than an error: batch judging and A/B comparison degrade to "cannot evaluate, content not retained," reported honestly rather than silently skipped.

This keeps the ports story intact, avoids duplicating consumer infrastructure, and makes the capture-policy constraint explicit instead of discovered later.

### 3.4 What ships in Part B

- The `OperationSource` port and `RecordedOperation` / `OperationQuery` types.
- One reference implementation over an `EvaluationStore`-adjacent in-memory source, for tests and small workloads. **No ClickHouse or Postgres operation source**; those are consumer-side.
- **Regression detection**, which needs no source: score aggregation over an `EvaluationStore` grouped by evaluator, rubric, provider alias, model, and time window, returning deltas across a boundary.
- **Sampling**, over the store, with a documented note that reviewable content depends on the source.
- **Batch judge runs**, taking an `OperationSource`, a judge function, and a query; writing results back as `EvaluationRef` rows with `source: "llm_judge"`. Concurrency-bounded. Idempotent via `idempotency_key` so a re-run does not double-write.
- **A/B comparison**, taking an `OperationSource` and two provider aliases or prompts, replaying through the port, and writing paired evaluations sharing a comparison id.

### 3.5 Explicitly out

- Any user interface. The review queue is an API, not a screen.
- Durable operation storage inside this package, per 3.3.
- Automatic judge prompts. Consumers supply the judge; opinionated rubrics are a separate question.

---

## 4. Phasing

1. Postgres backend plus parity tests. Independently shippable, closes half the owed scope.
2. `OperationSource` port and types, with the in-memory reference implementation.
3. Regression detection and sampling, both over the store alone.
4. Batch judge runs.
5. A/B comparison.

Phases 1 through 3 have no unresolved design questions. Phases 4 and 5 depend on section 5.

---

## 5. Open questions

**5.1 Does A/B comparison replay live, or score stored outputs?** Replaying sends real requests and costs real money, and results move as providers change underneath. Scoring stored outputs is free and reproducible but can only compare what was already run, which is not an A/B test. **Recommendation: support both, defaulting to scoring stored outputs**, with live replay explicitly opted into, since a tool that silently spends money on a comparison is a bad tool.

**5.2 Should batch judge runs respect budget gating?** A judge run over ten thousand operations is a large spend. It routes through the port, so gating applies by default, but a budget refusal mid-run needs defined semantics: stop, or complete what is affordable and report the shortfall. **Recommendation: stop and report**, since a silently partial evaluation is worse than a refused one.

**5.3 Does the judge itself get evaluated?** `EvaluationRef` carries `evaluator_name` and `evaluator_version`, so judge drift is detectable in principle. Whether tooling ships for it is a scope question, not a design one.

**5.4 Is regression detection statistical or threshold-based?** Threshold comparison is trivial and noisy. Proper significance testing on small samples is a genuine problem and easy to get wrong. **Recommendation: ship deltas and counts, not verdicts**, and let the consumer decide what a meaningful change is.

---

## 6. Risk

Part B is materially larger than Part A and carries the only real uncertainty in this release. The honest sequencing note is that **Part A can ship the moment it is done**, and should not wait for Part B, because it discharges half an already-displaced commitment at near-zero risk.

The failure mode to avoid is bundling them so tightly that a design question in phase 5 delays a mechanical backend that was owed twice over.
