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
