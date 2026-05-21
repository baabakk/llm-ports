/**
 * Deterministic programmatic repair for Zod validation failures.
 *
 * Inspects a `ZodError`'s issues and applies type-coercion / null-deletion
 * fixes BEFORE the validation-strategy fires a retry-with-feedback round-trip
 * against the LLM. Each repair pattern represents a known LLM quirk that an
 * LLM round-trip is overkill to fix.
 *
 * The 6 patterns this catches (each one avoids ~1 LLM retry):
 *
 *   1. `null` where a non-null type is expected → delete key
 *      (lets `.optional()` schemas accept the absence)
 *   2. string `"9"` where `number` is expected → `Number("9")` → `9`
 *   3. string `"true"` / `"false"` where `boolean` is expected → real booleans
 *   4. number `9` where `string` is expected → `String(9)` → `"9"`
 *   5. enum value with case/whitespace drift (`"HIGH"` vs `"high"`) →
 *      `.toLowerCase().trim()`
 *   6. `null` inside an optional union (`z.string().nullable().optional()`) →
 *      delete key
 *
 * Strategy:
 *
 *   1. Run `schema.safeParse(raw)`.
 *   2. If it fails, call `attemptRepair(raw, error)` to produce a repaired
 *      candidate (does NOT mutate the input).
 *   3. Re-run `schema.safeParse(repaired)`.
 *   4. If the second parse succeeds, return it. Saves an LLM round-trip.
 *   5. If the second parse still fails, hand off to the validation strategy
 *      (retry-with-feedback OR fallback-to-next-provider, configured at port
 *      creation).
 *
 * Ported from BEPA (Babak's Executive Personal Assistant) where this repair
 * has been running in production for ~6 months. The 6 patterns are exactly
 * the ones BEPA observed across millions of LLM calls against Claude,
 * GPT, GPT-OSS, Qwen, Cerebras gpt-oss, and Ollama models.
 *
 * Note on Zod compatibility: this code reads `issue.code` and `issue.expected`
 * which are stable across Zod v3 + v4. The `invalid_enum_value` code name
 * changed to `invalid_value` in Zod v4; we match both.
 */

import type { ZodError, ZodIssue } from "zod";

/**
 * Apply deterministic repairs to `raw` based on a `ZodError`. Returns a
 * structurally-cloned, repaired copy. Does not mutate the input.
 *
 * Safe to call even if `raw` is not an object — non-object input is returned
 * as-is.
 */
export function attemptValidationRepair(raw: unknown, error: ZodError): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const data = structuredClone(raw) as Record<string, unknown>;

  for (const issue of error.issues) {
    applyFix(data, issue);
  }

  return data;
}

function applyFix(root: Record<string, unknown>, issue: ZodIssue): void {
  const path = issue.path;
  if (path.length === 0) return;

  const target = resolvePath(root, path.slice(0, -1));
  if (!target || typeof target !== "object") return;

  const key = String(path[path.length - 1]);
  const obj = target as Record<string, unknown>;
  const current = obj[key];

  // Zod v4 changed the issue code for enum/literal mismatches from
  // `invalid_enum_value` to `invalid_value`. Match both so this works
  // across the peer-dependency range `zod >=3.24.0 <5`.
  const code = issue.code as string;

  switch (code) {
    case "invalid_type": {
      const expected = (issue as { expected?: unknown }).expected;
      // null → undefined (delete key so .optional() works)
      if (current === null && expected !== "null") {
        delete obj[key];
        break;
      }
      // string → number
      if (expected === "number" && typeof current === "string") {
        const num = Number(current);
        if (!Number.isNaN(num)) obj[key] = num;
        break;
      }
      // string → boolean
      if (expected === "boolean" && typeof current === "string") {
        if (current === "true") obj[key] = true;
        else if (current === "false") obj[key] = false;
        break;
      }
      // number → string
      if (expected === "string" && typeof current === "number") {
        obj[key] = String(current);
        break;
      }
      break;
    }

    case "invalid_enum_value":
    case "invalid_value":
      // Case + whitespace normalization for enum / literal mismatches.
      if (typeof current === "string") {
        obj[key] = current.toLowerCase().trim();
      }
      break;

    case "invalid_union":
      // null inside an optional union (e.g. `z.string().nullable().optional()`)
      // → delete the key so the optional branch can succeed.
      if (current === null) {
        delete obj[key];
      }
      break;
  }
}

function resolvePath(obj: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}
