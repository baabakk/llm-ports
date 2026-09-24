/**
 * Resolve which shape a `generateStructured` call wants enforced.
 *
 * Since alpha.35 a caller supplies either a Zod schema or a JSON Schema
 * object. Every adapter has to answer the same three questions about that
 * choice, so they ask here rather than each deciding for itself: five
 * near-identical checks is five chances to disagree about what "neither" or
 * "both" means.
 *
 * The two forms are not equivalent and this helper is where the difference is
 * made explicit. A Zod schema can be validated locally, so it drives
 * retry-with-feedback. A JSON Schema object cannot, because this library
 * carries no JSON Schema validator, so the provider's strict mode is the only
 * enforcement and the decoded response is returned unchecked.
 */

import { ConfigError } from "../errors.js";
import type { z } from "zod";

/** What the caller asked for, in a form an adapter can branch on once. */
export type ResolvedStructuredSchema<T> =
  | {
      kind: "zod";
      /** Validate with this, and retry with feedback when it fails. */
      zod: z.ZodType<T>;
    }
  | {
      kind: "json-schema";
      /**
       * Send this to the provider verbatim. **Nothing validates the response
       * against it locally**, so an adapter must not pretend to: return the
       * decoded value and report one validation attempt.
       */
      jsonSchema: Record<string, unknown>;
    };

/**
 * @throws {ConfigError} when neither form is supplied, or both are.
 *
 * Both is rejected rather than resolved by precedence. A caller who passes
 * both has two different intentions in one call, and picking one silently is
 * how the other becomes a bug nobody can see: the request would enforce one
 * shape while the code reads as if it enforced the other.
 */
export function resolveStructuredSchema<T>(options: {
  schema?: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
}): ResolvedStructuredSchema<T> {
  const hasZod = options.schema !== undefined;
  const hasJsonSchema = options.jsonSchema !== undefined;

  if (hasZod && hasJsonSchema) {
    throw new ConfigError(
      'generateStructured received both "schema" and "jsonSchema". Supply exactly one: ' +
        '"schema" for a Zod schema, which is validated locally and retried with feedback, ' +
        'or "jsonSchema" for a JSON Schema object, which is enforced only by the provider.',
    );
  }
  if (hasZod) return { kind: "zod", zod: options.schema! };
  if (hasJsonSchema) return { kind: "json-schema", jsonSchema: options.jsonSchema! };

  throw new ConfigError(
    'generateStructured requires a shape to enforce: pass "schema" (a Zod schema, preferred) ' +
      'or "jsonSchema" (a JSON Schema object). Neither was supplied.',
  );
}
