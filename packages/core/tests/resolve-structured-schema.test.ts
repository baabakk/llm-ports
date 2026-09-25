/**
 * The shared decision about which schema form a structured call wants.
 *
 * Five adapters ask this helper rather than each deciding for itself, which is
 * the whole point: five near-identical checks are five chances to disagree
 * about what "neither" and "both" mean. That makes this helper's behaviour a
 * contract rather than an implementation detail, and it had no test of its own
 * until now, which is how the release nearly shipped a shared rule verified in
 * exactly one of its five consumers.
 *
 * Added in `0.1.0-alpha.35`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, resolveStructuredSchema } from "../src/index.js";

const Zod = z.object({ intent: z.string() });
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: { intent: { type: "string" } },
} as const;

function asJsonSchema(): Record<string, unknown> {
  return JSON_SCHEMA as unknown as Record<string, unknown>;
}

describe("resolveStructuredSchema", () => {
  it("reports the Zod form, carrying the schema through untouched", () => {
    const resolved = resolveStructuredSchema({ schema: Zod });
    expect(resolved.kind).toBe("zod");
    // Identity, not equality: an adapter validates with this object and a copy
    // would break a caller relying on a custom refinement or a branded type.
    if (resolved.kind === "zod") expect(resolved.zod).toBe(Zod);
  });

  it("reports the JSON Schema form, carrying the object through untouched", () => {
    const supplied = asJsonSchema();
    const resolved = resolveStructuredSchema({ jsonSchema: supplied });
    expect(resolved.kind).toBe("json-schema");
    // The caller's own object reaches the provider. Converting it through Zod
    // and back is exactly what this option exists to remove.
    if (resolved.kind === "json-schema") expect(resolved.jsonSchema).toBe(supplied);
  });

  it("refuses both forms rather than picking one", () => {
    // Precedence would be the tempting answer and the wrong one: a call with
    // both carries two intentions, and silently honouring one makes the other
    // a bug nobody can see, since the request enforces one shape while the
    // code reads as if it enforced the other.
    expect(() => resolveStructuredSchema({ schema: Zod, jsonSchema: asJsonSchema() })).toThrow(
      ConfigError,
    );
  });

  it("refuses neither form", () => {
    expect(() => resolveStructuredSchema({})).toThrow(ConfigError);
  });

  it("says which field to use in both refusals, since the message is the whole fix", () => {
    const both = (): unknown =>
      resolveStructuredSchema({ schema: Zod, jsonSchema: asJsonSchema() });
    const neither = (): unknown => resolveStructuredSchema({});

    for (const call of [both, neither]) {
      try {
        call();
        expect.unreachable("expected a ConfigError");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("schema");
        expect(message).toContain("jsonSchema");
      }
    }
  });

  it("treats an explicitly undefined field as absent, not as supplied", () => {
    // A caller spreading optional config lands here routinely, as
    // `{ schema, jsonSchema: maybeUndefined }`. Reading that as "both" would
    // reject a call that supplied exactly one.
    const resolved = resolveStructuredSchema({ schema: Zod, jsonSchema: undefined });
    expect(resolved.kind).toBe("zod");

    const other = resolveStructuredSchema({ schema: undefined, jsonSchema: asJsonSchema() });
    expect(other.kind).toBe("json-schema");

    expect(() => resolveStructuredSchema({ schema: undefined, jsonSchema: undefined })).toThrow(
      ConfigError,
    );
  });
});
