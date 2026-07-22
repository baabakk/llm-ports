/**
 * Deterministic programmatic repair for Zod validation failures.
 *
 * Inspects a `ZodError`'s issues and applies type-coercion / null-deletion
 * fixes BEFORE the validation-strategy fires a retry-with-feedback round-trip
 * against the LLM. Each repair pattern represents a known LLM quirk that an
 * LLM round-trip is overkill to fix.
 *
 * The 8 patterns this catches (each one avoids ~1 LLM retry):
 *
 *   1. `null` where a non-null type is expected → delete key
 *      (lets `.optional()` schemas accept the absence)
 *   2. string `"9"` where `number` is expected → `Number("9")` → `9`
 *   3. string `"true"` / `"false"` where `boolean` is expected → real booleans
 *   4. number `9` where `string` is expected → `String(9)` → `"9"`
 *   5. enum value with case / whitespace / markdown drift
 *      (`"HIGH"`, `"**low**"`, `'"medium"'`, "Low ") →
 *      strip wrappers + `.toLowerCase().trim()`
 *   6. `null` inside an optional union (`z.string().nullable().optional()`) →
 *      delete key
 *   7. (alpha.13+) stringified JSON where object/array expected:
 *      `'{"a":1}'` → `JSON.parse(...)` → `{a: 1}` when the string starts/ends
 *      with `{}` or `[]`. Catches the "model double-encodes nested objects"
 *      quirk seen on some compat providers (e.g. MiniMax returns
 *      `reasoning: "{\"experience\": ...}"` for an object-typed field).
 *   8. (alpha.13+) array where object expected with a single-element array
 *      containing an object: `[{...}]` → `{...}`. Catches "model wrapped a
 *      singular field as an array" misreads of the schema.
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
      // Pattern 7 (alpha.13): stringified JSON where object/array expected.
      // Some compat providers double-encode nested fields; if the string
      // looks like JSON (`{...}` or `[...]`), try parsing once. Only
      // assign back if parse succeeds AND the parsed shape matches the
      // expected category — otherwise we'd risk replacing a legitimate
      // string with parsed junk.
      if (
        (expected === "object" || expected === "array") &&
        typeof current === "string"
      ) {
        const trimmed = current.trim();
        const looksLikeObject =
          expected === "object" && trimmed.startsWith("{") && trimmed.endsWith("}");
        const looksLikeArray =
          expected === "array" && trimmed.startsWith("[") && trimmed.endsWith("]");
        if (looksLikeObject || looksLikeArray) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            const matchesShape =
              (expected === "object" &&
                parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)) ||
              (expected === "array" && Array.isArray(parsed));
            if (matchesShape) {
              obj[key] = parsed;
            }
          } catch {
            // Not valid JSON; leave as-is so retry-with-feedback can ask
            // the model to fix it.
          }
        }
        break;
      }
      // Pattern 8 (alpha.13): array-with-single-object where object expected.
      // Common when the model misreads the schema for a singular field and
      // wraps the answer in an array.
      if (
        expected === "object" &&
        Array.isArray(current) &&
        current.length === 1 &&
        current[0] !== null &&
        typeof current[0] === "object" &&
        !Array.isArray(current[0])
      ) {
        obj[key] = current[0];
        break;
      }
      break;
    }

    case "invalid_enum_value":
    case "invalid_value":
      // Case + whitespace + markdown / quote-wrapper normalization for enum
      // / literal mismatches. Catches:
      //   "HIGH" / "Low " → "high" / "low"
      //   "**low**"       → "low"  (markdown wrap)
      //   '"medium"'      → "medium"  (model quoted the value)
      //   "`low`"         → "low"  (model code-fenced it)
      //   "shared‑lib"    → "shared-lib"  (U+2011 non-breaking hyphen → ASCII;
      //                    added alpha.28 pre-work TD-LLMP-18)
      if (typeof current === "string") {
        obj[key] = stripEnumDecorators(normalizeUnicodeConfusables(current));
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

/**
 * Normalize Unicode confusables of ASCII delimiter characters used in
 * enum literals. Models occasionally emit typographic variants
 * (U+2011 non-breaking hyphen instead of U+002D ASCII hyphen-minus,
 * curly quotes instead of straight, non-breaking spaces instead of
 * ASCII spaces, fullwidth punctuation on Chinese-tuned models) that
 * break Zod's byte-exact enum matching without any semantic
 * difference to the caller's intent.
 *
 * Content-preserving: only fires inside the `invalid_enum_value` /
 * `invalid_value` repair branch, so free-text `z.string()` fields
 * where an em dash or curly quote is deliberate are never touched.
 *
 * Added in alpha.28 pre-work (TD-LLMP-18) after ADW production
 * observed U+2011 non-breaking hyphen in `"shared-lib"` breaking
 * their guardrails Zod enum validation. BEPA has three parallel
 * exposures (venture / interaction-type / call-triage-category
 * enums with hyphenated values).
 */
function normalizeUnicodeConfusables(s: string): string {
  return s
    // Hyphens / dashes: U+2010..U+2015 (hyphen through horizontal bar) +
    // U+2212 minus sign + U+FF0D fullwidth hyphen-minus → ASCII '-'
    .replace(/[‐‑‒–—―−－]/g, "-")
    // Single quotes: U+2018 left / U+2019 right → ASCII apostrophe
    .replace(/[‘’]/g, "'")
    // Double quotes: U+201C left / U+201D right → ASCII quote
    .replace(/[“”]/g, '"')
    // Spaces: U+00A0 non-breaking + U+2007 figure + U+2008 punctuation +
    // U+2009 thin + U+202F narrow-no-break + U+205F medium-math + U+3000
    // ideographic → ASCII space
    .replace(/[      　]/g, " ");
}

/**
 * Strip common LLM-output decorators from a candidate enum value before
 * normalizing. Loops the strip pipeline until no further changes, then
 * lowercases. Handles compound cases like `'**LOW**.'` (trailing punct
 * outside the markdown wrap) and `'"**low**"'` (quoted-then-bolded).
 */
function stripEnumDecorators(s: string): string {
  let v = s.trim();
  for (let i = 0; i < 4; i++) {
    const before = v;
    // Strip trailing punctuation first so it doesn't block a wrapper match.
    v = v.replace(/[.,;!?]+$/, "").trim();
    // Strip surrounding markdown bold / italic
    if (v.startsWith("**") && v.endsWith("**") && v.length >= 4) {
      v = v.slice(2, -2);
    } else if (v.startsWith("__") && v.endsWith("__") && v.length >= 4) {
      v = v.slice(2, -2);
    } else if (
      (v.startsWith("*") && v.endsWith("*") && v.length >= 2) ||
      (v.startsWith("_") && v.endsWith("_") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    // Strip surrounding code-fence backticks
    if (v.startsWith("`") && v.endsWith("`") && v.length >= 2) {
      v = v.slice(1, -1);
    }
    // Strip surrounding quotes
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    v = v.trim();
    if (v === before) break;
  }
  return v.toLowerCase();
}

function resolvePath(obj: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}
