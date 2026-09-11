# @llm-ports/capabilities v0.1.0-alpha.26.1 — Internal migration hotfix

**Released 2026-07-03.** Install: `pnpm add @llm-ports/capabilities@alpha`

Hotfix for a gap in the alpha.26 ship. **Consumer impact: zero API changes**; upgrade silently unblocks the alpha.27 path.

## The gap

The alpha.26 ship marked `{instructions, prompt}` deprecated on the port interface but left `@llm-ports/capabilities` calling the port with the deprecated shape internally. That worked at runtime (the Registry's dual-population synthesized `messages` from the legacy fields) but would have failed to compile against `@llm-ports/core@alpha.27` once the legacy fields are removed.

**Every downstream consumer using `createExtractor` / `createClassifier` / `createScorer` / `createSummarizer` / `createDrafter` / `createAnalyzer` / `createPlanner` would have broken at alpha.27.**

Caught during a downstream migration review by a consumer paying attention to the upstream call sites. Filed immediately.

## The fix

All 7 factory implementations now build `messages: LLMMessage[]` via `toMessages(system, userPrompt)` and pass that to the port instead of `{instructions, prompt}`.

Files updated:
- `src/understanding/classify.ts`
- `src/understanding/extract.ts`
- `src/understanding/score.ts`
- `src/reasoning/analyze.ts`
- `src/reasoning/plan.ts`
- `src/generation/draft.ts`
- `src/compression/summarize.ts`

## Regression guard

New test suite `tests/legacy-shape-guard.test.ts` uses a recording spy port that asserts every factory calls `.generateStructured` / `.generateText` with `messages` set and NEITHER `instructions` nor `prompt` set. A future PR reintroducing the legacy shape in an internal port call trips this test before publish.

## Test coverage

- 7 new legacy-shape-guard tests (one per factory)
- 4 existing test files updated to read from `messages` via new `getSystemContent()` / `getUserContent()` helpers instead of the removed `options.prompt` / `options.instructions` fields
- **888 tests pass across the workspace (was 881 at alpha.26; +7 new; 0 regressions)**

## Consumer impact

- **Zero API changes.** Wrapper input types (`DraftInput.instructions`, `ClassifyInput.contextOverride`, etc.) remain unchanged. That's BEPA-facing consumer surface, not the port surface.
- **Only the internal port call shape changed.** Consumers using the factories continue to work exactly as before.
- **Upgrade path.** Bump `@llm-ports/capabilities` from `alpha.26` to `alpha.26.1` (or leave `^alpha` and let npm resolve). No code changes required.

## Why alpha.26.1 (not alpha.27)

Alpha.27 is reserved for the coordinated removal of the deprecated `instructions` / `prompt` fields from `@llm-ports/core` and all adapters (planned for ~2026-07-16). This is a hotfix on the alpha.26 line to unblock that coordinated ship. Only `@llm-ports/capabilities` bumps to `alpha.26.1`; the other 6 packages stay on `alpha.26`.

## Credit

Thanks to the BEPA migration reviewer (2026-07-03) for catching the upstream factory quirk during their alpha.20.1 → alpha.26 audit and calling it out before it became a ship-blocker.

---

[Full release notes](https://github.com/baabakk/llm-ports/releases/tag/%40llm-ports%2Fcapabilities%400.1.0-alpha.26.1) | [alpha.25 → alpha.26 migration guide](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md)
