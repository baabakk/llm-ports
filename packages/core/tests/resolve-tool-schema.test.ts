/**
 * The shared decision about how a tool describes its parameters.
 *
 * Four adapters ask this helper rather than each deciding for itself, which is
 * the whole point: four near-identical checks are four chances to disagree
 * about what "both" and "neither" mean. Its sibling,
 * `resolveStructuredSchema`, shipped in `alpha.35` without a test of its own
 * until the same release nearly ended, so this one arrives with the code.
 *
 * Added in `1.0.0-rc.36`, from `TD-LLMPORTS-TOOLS-ARE-ZOD-ONLY`: a gateway
 * could not pass its own clients' tools through, because they arrive as JSON
 * Schema and this library accepted only Zod.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, resolveToolSchema } from "../src/index.js";

const Zod = z.object({ id: z.string() });
const JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string" } },
};

describe("resolveToolSchema", () => {
  it("reports the Zod form, carrying the schema through untouched", () => {
    const resolved = resolveToolSchema({ inputSchema: Zod }, "lookup");
    expect(resolved.kind).toBe("zod");
    // Identity, not equality: an adapter converts this object, and a copy
    // would drop a custom refinement or a branded type.
    if (resolved.kind === "zod") expect(resolved.zod).toBe(Zod);
  });

  it("reports the JSON Schema form, carrying the object through untouched", () => {
    const resolved = resolveToolSchema({ inputJsonSchema: JSON_SCHEMA }, "lookup");
    expect(resolved.kind).toBe("json-schema");
    // The caller's own object reaches the provider. Converting it through Zod
    // and back is exactly what this option exists to remove.
    if (resolved.kind === "json-schema") expect(resolved.jsonSchema).toBe(JSON_SCHEMA);
  });

  it("refuses both forms rather than picking one", () => {
    // Precedence would be the tempting answer and the wrong one: a tool
    // carrying both describes two different shapes, and honouring one makes
    // the other a bug nobody can see.
    expect(() =>
      resolveToolSchema({ inputSchema: Zod, inputJsonSchema: JSON_SCHEMA }, "lookup"),
    ).toThrow(ConfigError);
  });

  it("refuses neither form", () => {
    expect(() => resolveToolSchema({}, "lookup")).toThrow(ConfigError);
  });

  it("names the tool in both refusals, since a call carries several", () => {
    // Without the name, an agent call with eight tools tells the caller only
    // that one of them is wrong.
    for (const bad of [
      () => resolveToolSchema({ inputSchema: Zod, inputJsonSchema: JSON_SCHEMA }, "lookup_invoice"),
      () => resolveToolSchema({}, "lookup_invoice"),
    ]) {
      try {
        bad();
        expect.unreachable("expected a ConfigError");
      } catch (err) {
        expect((err as Error).message).toContain("lookup_invoice");
      }
    }
  });

  it("says which field to use in both refusals, since the message is the whole fix", () => {
    for (const bad of [
      () => resolveToolSchema({ inputSchema: Zod, inputJsonSchema: JSON_SCHEMA }, "t"),
      () => resolveToolSchema({}, "t"),
    ]) {
      try {
        bad();
        expect.unreachable("expected a ConfigError");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("inputSchema");
        expect(message).toContain("inputJsonSchema");
      }
    }
  });

  it("treats an explicitly undefined field as absent, not as supplied", () => {
    // A caller spreading optional config lands here routinely. Reading that as
    // "both" would reject a tool that supplied exactly one.
    expect(resolveToolSchema({ inputSchema: Zod, inputJsonSchema: undefined }, "t").kind).toBe(
      "zod",
    );
    expect(resolveToolSchema({ inputSchema: undefined, inputJsonSchema: JSON_SCHEMA }, "t").kind).toBe(
      "json-schema",
    );
    expect(() => resolveToolSchema({ inputSchema: undefined, inputJsonSchema: undefined }, "t")).toThrow(
      ConfigError,
    );
  });

  it("refuses a tool that describes no parameters, rather than sending an empty shape", () => {
    // A tool genuinely taking no arguments says so with an empty object
    // schema. Omitting both fields is indistinguishable from forgetting, and
    // the model would be told the tool takes anything.
    try {
      resolveToolSchema({}, "ping");
      expect.unreachable("expected a ConfigError");
    } catch (err) {
      expect((err as Error).message).toContain("empty object schema");
    }
  });
});
