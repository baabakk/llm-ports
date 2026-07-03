---
"@llm-ports/capabilities": patch
---

Fix: migrate the 7 factory implementations in `@llm-ports/capabilities` to use the canonical `messages: LLMMessage[]` shape internally.

**The gap.** The alpha.26 ship marked `{instructions, prompt}` deprecated on the port interface but left `@llm-ports/capabilities` calling the port with the deprecated shape internally. That worked at runtime (the Registry's dual-population synthesized `messages` from the legacy fields) but would have failed to compile against `@llm-ports/core@alpha.27` once the legacy fields are removed. Every downstream consumer using `createExtractor` / `createClassifier` / `createScorer` / `createSummarizer` / `createDrafter` / `createAnalyzer` / `createPlanner` would have broken at that point.

**The fix.** All 7 factory implementations now build a `messages: LLMMessage[]` array via `toMessages(system, userPrompt)` and pass it to the port instead of the deprecated shape.

Files updated:
- `src/understanding/classify.ts`
- `src/understanding/extract.ts`
- `src/understanding/score.ts`
- `src/reasoning/analyze.ts`
- `src/reasoning/plan.ts`
- `src/generation/draft.ts`
- `src/compression/summarize.ts`

**Regression guard.** New test suite `tests/legacy-shape-guard.test.ts` uses a recording spy port that asserts every factory calls `.generateStructured` / `.generateText` with `messages` set and NEITHER `instructions` nor `prompt` set. A future PR that reintroduces the legacy shape in an internal port call trips this test before publish.

**Test coverage.** 888 tests pass across the workspace (was 881 at alpha.26; +7 new guard tests; 0 regressions).

**Backwards compatibility.** Zero API changes. The wrapper input types (`DraftInput.instructions`, etc.) remain unchanged — that's BEPA's consumer surface, not the port surface. Only the internal port call shape changed.

**Consumer impact.** Nothing to do. Bump `@llm-ports/capabilities` from `alpha.26` to `alpha.26.1` (or leave `^alpha` and let npm resolve). The bump silently unblocks the alpha.27 upgrade.
