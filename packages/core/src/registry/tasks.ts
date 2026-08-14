/**
 * declareTasks<T>() — opt-in type safety for task definitions.
 *
 * TaskType is intentionally `string` at the LLMPort surface so the library
 * does not constrain users' task vocabularies. The cost is loose typing at
 * call sites. declareTasks() recovers most of the safety with autocomplete
 * and typo protection.
 *
 * Stated as "open with opt-in typing," not "better than enum."
 *
 * See implementation plan v3 §6.4 and decision 17.
 */

import type { LLMPriority } from "../ports/llm-port.js";

export interface TaskConfig {
  priority?: LLMPriority;
  defaultTemperature?: number;
  defaultMaxOutputTokens?: number;
  description?: string;
  /**
   * Alpha.30+: per-task default per-attempt timeout, milliseconds. When
   * set, overrides the Registry-level `RegistryOptions.perAttemptTimeoutMs`
   * for calls whose `taskType` matches this declared task. Overridden
   * in turn by the per-call `perAttemptTimeoutMs` on generation-method
   * options.
   *
   * Precedence (first non-undefined wins): call → task → Registry →
   * undefined (no timeout).
   *
   * Addresses SalesCoach's `TD-CALLPLAN-CHAIN-TIMEOUT-STARVATION`
   * (2026-08-14): a single Registry-level timeout starves any provider
   * whose legitimate latency exceeds the global cap. Per-task defaults
   * let a slow-but-necessary task (structured-output on a reasoning
   * model) declare more headroom without loosening the cap that
   * protects the fast tasks.
   */
  defaultPerAttemptTimeoutMs?: number;
}

/**
 * Returns a typed map of task-name keys to their literal-string task type.
 *
 * @example
 * const tasks = declareTasks({
 *   triage: { priority: 1, defaultTemperature: 0 },
 *   draft:  { priority: 2, defaultTemperature: 0.4 },
 * });
 *
 * llm.generateText({ taskType: tasks.triage, prompt: "..." });
 * //                          ^^^^^^^^^^^^^ autocomplete + typo-safe
 *
 * The runtime value of `tasks.triage` is the literal string "triage";
 * the type is also the literal "triage", not the wider `string`.
 */
export function declareTasks<T extends Record<string, TaskConfig>>(
  config: T,
): { [K in keyof T]: K & string } & { __meta: T } {
  const result: Record<string, string> = {};
  for (const key of Object.keys(config)) {
    result[key] = key;
  }
  // Attach the original config under a metadata key so callers (e.g. registry)
  // can read defaults without recomputing them.
  Object.defineProperty(result, "__meta", {
    value: config,
    enumerable: false,
    writable: false,
  });
  return result as { [K in keyof T]: K & string } & { __meta: T };
}

/** Read the original TaskConfig back from a declareTasks() result. */
export function getTaskConfig<T extends Record<string, TaskConfig>>(
  declared: { [K in keyof T]: K & string } & { __meta: T },
  taskName: keyof T,
): TaskConfig | undefined {
  return declared.__meta[taskName];
}

/**
 * Canonicalize a caller-supplied `taskType` for lookup.
 *
 * The env-var parser (`loadRegistryConfig`) lowercases and hyphenates
 * task names (`LLM_TASK_ROUTE_STRUCTURED_OUTPUT` → key `structured-output`).
 * The Registry uses this same transform on the caller-supplied `taskType`
 * before the table lookup so `"STRUCTURED_OUTPUT"`, `"Structured_Output"`,
 * `"structured-output"` all resolve to the same route.
 *
 * Without this, callers passing SCREAMING_SNAKE fell silently through
 * to the `"general"` chain — a footgun surfaced by SalesCoach in
 * `TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-GENERAL-FALLBACK` (2026-08-10).
 *
 * Idempotent: `normalizeTaskType(normalizeTaskType(x)) === normalizeTaskType(x)`.
 */
export function normalizeTaskType(taskType: string): string {
  return taskType.toLowerCase().replace(/_/g, "-");
}
