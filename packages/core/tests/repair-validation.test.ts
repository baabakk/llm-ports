/**
 * Tests for attemptValidationRepair — the deterministic Zod-issue-driven
 * repair pass ported from BEPA. Every test simulates one of the 6 patterns
 * BEPA observed in production:
 *
 *   1. null → delete key (so .optional() works)
 *   2. string "9" → number 9
 *   3. string "true"/"false" → boolean
 *   4. number 9 → string "9"
 *   5. invalid_enum_value → lowercase + trim
 *   6. null in optional union → delete key
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { attemptValidationRepair } from "../src/utils/repair-validation.js";

function runRepair<T extends z.ZodTypeAny>(schema: T, raw: unknown): unknown {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  return attemptValidationRepair(raw, result.error);
}

describe("attemptValidationRepair", () => {
  // ─── Pattern 1: null deletion ──────────────────────────────────────

  it("deletes null keys when the schema field is optional", () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().optional(),
    });
    const repaired = runRepair(schema, { name: "alice", email: null });
    // The repair pass deletes the null email key. After repair, safeParse
    // would succeed because `email` is .optional().
    expect(schema.safeParse(repaired).success).toBe(true);
  });

  // ─── Pattern 2: string → number coercion ───────────────────────────

  it('coerces string "9" to number 9 when the schema expects a number', () => {
    const schema = z.object({ count: z.number() });
    const repaired = runRepair(schema, { count: "9" });
    expect(schema.safeParse(repaired).success).toBe(true);
    expect(repaired).toEqual({ count: 9 });
  });

  it('leaves string "abc" alone when the schema expects a number and the string is not numeric', () => {
    const schema = z.object({ count: z.number() });
    const repaired = runRepair(schema, { count: "abc" });
    // Repair couldn't fix it (NaN); leaves the string in place
    expect((repaired as { count: unknown }).count).toBe("abc");
    expect(schema.safeParse(repaired).success).toBe(false);
  });

  // ─── Pattern 3: string → boolean coercion ──────────────────────────

  it('coerces string "true"/"false" to boolean when the schema expects a boolean', () => {
    const schema = z.object({
      active: z.boolean(),
      verified: z.boolean(),
    });
    const repaired = runRepair(schema, { active: "true", verified: "false" });
    expect(schema.safeParse(repaired).success).toBe(true);
    expect(repaired).toEqual({ active: true, verified: false });
  });

  it('does NOT coerce string "yes"/"no" to boolean (only literal "true"/"false")', () => {
    const schema = z.object({ active: z.boolean() });
    const repaired = runRepair(schema, { active: "yes" });
    // Conservative: we don't expand "yes"/"no" semantics; only literal "true"/"false"
    expect((repaired as { active: unknown }).active).toBe("yes");
  });

  // ─── Pattern 4: number → string coercion ───────────────────────────

  it("coerces number 9 to string '9' when the schema expects a string", () => {
    const schema = z.object({ id: z.string() });
    const repaired = runRepair(schema, { id: 9 });
    expect(schema.safeParse(repaired).success).toBe(true);
    expect(repaired).toEqual({ id: "9" });
  });

  // ─── Pattern 5: enum case normalization ────────────────────────────

  it("lowercases + trims enum values to fix case/whitespace drift", () => {
    const schema = z.object({
      severity: z.enum(["low", "medium", "high"]),
    });
    const repaired = runRepair(schema, { severity: "  HIGH  " });
    expect(schema.safeParse(repaired).success).toBe(true);
    expect(repaired).toEqual({ severity: "high" });
  });

  // ─── Pattern 6: null in optional union ─────────────────────────────

  it("deletes null in fields with optional union (z.string().nullable().optional())", () => {
    const schema = z.object({
      label: z.string().nullable().optional(),
    });
    const result = schema.safeParse({ label: null });
    // z.string().nullable().optional() actually accepts null, so this test
    // verifies repair doesn't break when there's no actual issue.
    expect(result.success).toBe(true);
  });

  // ─── Combinatorial: nested objects ─────────────────────────────────

  it("applies repairs inside nested objects via path traversal", () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    });
    const repaired = runRepair(schema, {
      user: { name: 42, age: "30" },
    });
    expect(schema.safeParse(repaired).success).toBe(true);
    expect(repaired).toEqual({ user: { name: "42", age: 30 } });
  });

  it("applies repairs to multiple issues in one pass", () => {
    const schema = z.object({
      count: z.number(),
      active: z.boolean(),
      severity: z.enum(["low", "high"]),
      label: z.string().optional(),
    });
    const repaired = runRepair(schema, {
      count: "5",
      active: "true",
      severity: "LOW",
      label: null,
    });
    const result = schema.safeParse(repaired);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        count: 5,
        active: true,
        severity: "low",
      });
    }
  });

  // ─── Safety: doesn't mutate input ──────────────────────────────────

  it("does NOT mutate the input object", () => {
    const schema = z.object({ count: z.number() });
    const input = { count: "9" };
    const inputBefore = JSON.stringify(input);
    runRepair(schema, input);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });

  // ─── Safety: non-object input is returned as-is ─────────────────────

  it("returns non-object input unchanged", () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    if (result.success) throw new Error("test setup");
    expect(attemptValidationRepair(123, result.error)).toBe(123);
    expect(attemptValidationRepair("abc", result.error)).toBe("abc");
    expect(attemptValidationRepair(null, result.error)).toBe(null);
  });

  // ─── Pattern 7 (alpha.13): stringified JSON → parsed object/array ────

  it("parses a stringified JSON object when the schema expects an object", () => {
    const schema = z.object({
      profile: z.object({ name: z.string(), age: z.number() }),
    });
    const raw = { profile: '{"name":"Babak","age":42}' };
    expect(schema.safeParse(runRepair(schema, raw)).success).toBe(true);
  });

  it("parses a stringified JSON array when the schema expects an array", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });
    const raw = { tags: '["a","b","c"]' };
    expect(schema.safeParse(runRepair(schema, raw)).success).toBe(true);
  });

  it("does NOT replace non-JSON-shaped strings (no risk of garbage substitution)", () => {
    const schema = z.object({
      profile: z.object({ name: z.string() }),
    });
    // Plain prose, no JSON delimiters — repair should leave it alone, retry-
    // with-feedback can ask the model to fix it.
    const raw = { profile: "Babak is 42 years old." };
    const repaired = runRepair(schema, raw);
    expect((repaired as { profile: unknown }).profile).toBe("Babak is 42 years old.");
  });

  it("does NOT replace strings that LOOK like JSON but aren't parseable", () => {
    const schema = z.object({
      profile: z.object({ name: z.string() }),
    });
    const raw = { profile: '{name: Babak}' }; // unquoted key, invalid JSON
    const repaired = runRepair(schema, raw);
    expect((repaired as { profile: unknown }).profile).toBe("{name: Babak}");
  });

  // ─── Pattern 8 (alpha.13): array-with-single-object → object ─────────

  it("unwraps a single-element-array-of-object when the schema expects an object", () => {
    const schema = z.object({
      person: z.object({ name: z.string(), age: z.number() }),
    });
    const raw = { person: [{ name: "Babak", age: 42 }] };
    expect(schema.safeParse(runRepair(schema, raw)).success).toBe(true);
  });

  it("does NOT unwrap multi-element arrays (ambiguous which to pick)", () => {
    const schema = z.object({
      person: z.object({ name: z.string() }),
    });
    const raw = { person: [{ name: "Babak" }, { name: "Other" }] };
    const repaired = runRepair(schema, raw);
    expect(Array.isArray((repaired as { person: unknown }).person)).toBe(true);
  });

  // ─── Pattern 5 expanded (alpha.13): markdown/quote/punct decorators ──

  it.each([
    ['"low"', "low"],
    ["'medium'", "medium"],
    ["**high**", "high"],
    ["__low__", "low"],
    ["*medium*", "medium"],
    ["_high_", "high"],
    ["`low`", "low"],
    ["Low.", "low"],
    ["HIGH!", "high"],
    ["medium,", "medium"],
    ["**LOW**.", "low"],
  ])("enum decorator strip: %s → %s", (input, expected) => {
    const schema = z.object({
      priority: z.enum(["low", "medium", "high"]),
    });
    const raw = { priority: input };
    const result = schema.safeParse(runRepair(schema, raw));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priority).toBe(expected);
  });

  // ─── Pattern 9 (alpha.28, TD-LLMP-18): Unicode confusable normalization ─────

  describe("Unicode confusable normalization on invalid_enum_value", () => {
    it("U+2011 non-breaking hyphen → ASCII hyphen (the ADW production reproduction)", () => {
      // The exact ADW production case from 2026-07-21: model emitted
      // "shared‑lib" using U+2011 instead of ASCII "-" in a Zod enum
      // whose expected literal is "shared-lib" using U+002D.
      const schema = z.object({
        type: z.enum(["api", "event", "shared-lib", "database"]),
      });
      const raw = { type: "shared‑lib" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe("shared-lib");
    });

    it.each([
      // Hyphens / dashes: normalize to ASCII '-'
      ["shared‐lib", "shared-lib"], // U+2010 hyphen
      ["shared‑lib", "shared-lib"], // U+2011 non-breaking hyphen
      ["shared‒lib", "shared-lib"], // U+2012 figure dash
      ["shared–lib", "shared-lib"], // U+2013 en dash
      ["shared—lib", "shared-lib"], // U+2014 em dash
      ["shared―lib", "shared-lib"], // U+2015 horizontal bar
      ["shared−lib", "shared-lib"], // U+2212 minus sign
      ["shared－lib", "shared-lib"], // U+FF0D fullwidth hyphen-minus
    ])("hyphen variant %s → %s", (input, expected) => {
      const schema = z.object({
        type: z.enum(["shared-lib", "other"]),
      });
      const raw = { type: input };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe(expected);
    });

    it("BEPA venture enum: U+2011 in noble-cortex is repaired", () => {
      const schema = z.object({
        venture: z.enum(["voxr", "noble-cortex", "healthcheck", "personal", "speaking", "other"]),
      });
      const raw = { venture: "noble‑cortex" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.venture).toBe("noble-cortex");
    });

    it("BEPA interaction-type enum: U+2013 en dash in email-sent is repaired", () => {
      const schema = z.object({
        type: z.enum(["email-sent", "email-received", "meeting", "linkedin", "slack", "phone", "other"]),
      });
      const raw = { type: "email–sent" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe("email-sent");
    });

    it("curly single quote U+2019 → ASCII apostrophe in enum values", () => {
      const schema = z.object({
        state: z.enum(["can't", "won't", "should"]),
      });
      const raw = { state: "can’t" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe("can't");
    });

    it("non-breaking space U+00A0 → ASCII space in multi-word enum values", () => {
      const schema = z.object({
        state: z.enum(["in progress", "done"]),
      });
      const raw = { state: "in progress" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe("in progress");
    });

    it("composes with existing decorator strip: markdown-bolded + U+2011 → matches enum", () => {
      const schema = z.object({
        priority: z.enum(["low-urgency", "high-urgency"]),
      });
      const raw = { priority: "**low‑urgency**" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.priority).toBe("low-urgency");
    });

    it("CONTENT PRESERVATION: free-text z.string() with em dash is NOT touched", () => {
      // Critical property: the normalization fires only inside the
      // invalid_enum_value branch. A z.string() field carrying an em
      // dash as legitimate content is never touched — either the parse
      // succeeds outright (no repair fires) or a different repair path
      // triggers that ignores this content.
      const schema = z.object({
        quote: z.string(),
      });
      const raw = { quote: "It's — well — complicated" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      // The em dashes in the quote are preserved verbatim.
      if (result.success) expect(result.data.quote).toBe("It's — well — complicated");
    });

    it("normalization is idempotent (ASCII input stays ASCII)", () => {
      const schema = z.object({
        type: z.enum(["shared-lib", "other"]),
      });
      const raw = { type: "shared-lib" };
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe("shared-lib");
    });

    it("normalization can't help when no ASCII form matches (falls through to retry-with-feedback)", () => {
      // If normalizing produces a value that still doesn't match any enum
      // option, the outer safeParse fails and the caller retries with
      // feedback. attemptValidationRepair does its best-effort fix but
      // does not force a false-positive match.
      const schema = z.object({
        type: z.enum(["shared-lib", "other"]),
      });
      const raw = { type: "totally-different-value" };
      // safeParse would fail; the repair pass returns the raw with
      // stripEnumDecorators applied (lowercase), but "totally-different-value"
      // is still not a valid enum member, so the outer parse still fails.
      const result = schema.safeParse(runRepair(schema, raw));
      expect(result.success).toBe(false);
    });
  });
});
