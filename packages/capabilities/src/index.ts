/**
 * @llm-ports/capabilities — public API.
 *
 * Seven cognitive operation factories. Each takes a config (port, schema,
 * prompt fragments, hooks) at definition time and returns a typed function
 * the caller invokes per-input.
 *
 * Configure once, call many times. Hooks wire up at definition time, not
 * at call time. Reading the call site shows what is bound and what is
 * varying — that is the design (decision 19).
 *
 * The seven extracted from BEPA's production system:
 *   - createClassifier   pick one of N categories
 *   - createScorer       rate against rubric
 *   - createExtractor    pull structured fields
 *   - createSummarizer   compress meaning-preserving
 *   - createDrafter      generate text in a persona
 *   - createPlanner      decompose into steps
 *   - createAnalyzer     evaluate / critique / compare
 */

// Understanding (text in → structured out)
export {
  createClassifier,
  type ClassifyInput,
  type CreateClassifierConfig,
} from "./understanding/classify.js";
export {
  createScorer,
  type ScoreInput,
  type CreateScorerConfig,
} from "./understanding/score.js";
export {
  createExtractor,
  type ExtractInput,
  type CreateExtractorConfig,
} from "./understanding/extract.js";

// Compression
export {
  createSummarizer,
  type SummarizeInput,
  type CreateSummarizerConfig,
} from "./compression/summarize.js";

// Generation
export {
  createDrafter,
  type DraftInput,
  type CreateDrafterConfig,
} from "./generation/draft.js";

// Reasoning
export {
  createPlanner,
  type PlanInput,
  type CreatePlannerConfig,
} from "./reasoning/plan.js";
export {
  createAnalyzer,
  type AnalyzeInput,
  type CreateAnalyzerConfig,
} from "./reasoning/analyze.js";

// Shared types users may need (event shape, resolvable config fields)
export type { CapabilityEvent, Resolvable } from "./shared.js";
