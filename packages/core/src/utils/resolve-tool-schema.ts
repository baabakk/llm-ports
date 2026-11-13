/**
 * Which schema form a tool definition describes its parameters with.
 *
 * The sibling of `resolveStructuredSchema`, and deliberately the same shape:
 * exactly one form, both refused, neither refused, an explicitly undefined
 * field read as absent. Four adapters ask this rather than each deciding for
 * itself, which is the point. Four near-identical checks are four chances to
 * disagree about what "both" means.
 *
 * Added for `1.0.0-rc.36`. The ask came from a gateway that cannot pass its
 * own clients' tools through, because those arrive as JSON Schema and this
 * library accepted only Zod. See `TD-LLMPORTS-TOOLS-ARE-ZOD-ONLY`.
 */

import { z } from "zod";
import { ConfigError } from "../errors.js";

/** A tool's parameters, as the caller described them. */
export type ResolvedToolSchema =
  | { kind: "zod"; zod: z.ZodTypeAny }
  | { kind: "json-schema"; jsonSchema: Record<string, unknown> };

/**
 * Resolve a tool definition's parameter schema.
 *
 * @param toolName - named in the error, because a call carrying several tools
 * gives the caller nothing to act on otherwise.
 */
export function resolveToolSchema(
  tool: { inputSchema?: z.ZodTypeAny; inputJsonSchema?: Record<string, unknown> },
  toolName: string,
): ResolvedToolSchema {
  const hasZod = tool.inputSchema !== undefined;
  const hasJsonSchema = tool.inputJsonSchema !== undefined;

  if (hasZod && hasJsonSchema) {
    throw new ConfigError(
      `Tool "${toolName}" supplied both "inputSchema" and "inputJsonSchema". Supply exactly one: ` +
        '"inputSchema" for a Zod schema, or "inputJsonSchema" for a JSON Schema object received ' +
        "from somewhere else.",
    );
  }
  if (hasZod) return { kind: "zod", zod: tool.inputSchema! };
  if (hasJsonSchema) return { kind: "json-schema", jsonSchema: tool.inputJsonSchema! };

  throw new ConfigError(
    `Tool "${toolName}" describes no parameters. Pass "inputSchema" (a Zod schema, preferred) or ` +
      '"inputJsonSchema" (a JSON Schema object). For a tool that takes no arguments, pass an ' +
      'empty object schema rather than omitting both, so the model is told so explicitly.',
  );
}
