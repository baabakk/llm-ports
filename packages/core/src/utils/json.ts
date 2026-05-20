/**
 * JSON helpers used by adapters for structured-output and streaming-structured
 * paths.
 *
 *   - `extractJSON(raw)`: parses a string that may include markdown fences
 *     and surrounding prose into a JavaScript value. Throws on parse failure
 *     (callers handle the failure via the retry-with-feedback validation
 *     strategy upstream).
 *
 *   - `tryParsePartialJSON(buffer)`: best-effort parse of an in-progress
 *     streaming buffer. Returns `null` if no JSON can yet be recovered;
 *     returns the parsed value if balancing the buffer's open braces /
 *     brackets and trimming trailing commas produces a valid parse.
 *
 * Hoisted from per-adapter copies in alpha.3. Every adapter that previously
 * wrote its own `extractJSON` / `tryParsePartialJSON` now imports these.
 */

/**
 * Parse a JSON value out of a string that may be wrapped in markdown fences
 * or have leading/trailing prose. Throws on parse failure.
 *
 * Strategy:
 *   1. If wrapped in a ```json ... ``` or ``` ... ``` fence, extract the
 *      inner content.
 *   2. Find the first `{` and the last `}`. If both exist and `{` precedes
 *      `}`, parse the slice.
 *   3. Otherwise fall back to parsing the candidate as-is (lets the caller
 *      see the SyntaxError from JSON.parse).
 */
export function extractJSON(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return JSON.parse(candidate);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Best-effort parse of an in-progress streaming JSON buffer.
 *
 * Returns the parsed value if either:
 *   - The buffer is already complete and parses cleanly, OR
 *   - Balancing the buffer's open `{`/`[` against close `}`/`]` and trimming
 *     trailing commas produces a valid parse.
 *
 * Returns `null` if no `{` is present yet, or if no balancing strategy
 * recovers a valid JSON value. Adapters call this on every streaming chunk
 * append; the result is yielded as a `Partial<T>` to consumers.
 */
export function tryParsePartialJSON(buffer: string): unknown | null {
  try {
    const start = buffer.indexOf("{");
    if (start === -1) return null;
    return JSON.parse(buffer.slice(start));
  } catch {
    // Build a stack of expected closing brackets while scanning, so we close
    // in the correct reverse order. Track string boundaries so `{`/`[`/`}`/`]`
    // inside a string literal don't perturb the stack.
    //
    // Note: this fix corrects a bug from the per-adapter implementations that
    // simply counted braces and brackets independently and appended `}` then `]`.
    // That broke on inputs like `{"items": [1, 2, 3` where the correct close
    // order is `]` then `}`.
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    for (const ch of buffer) {
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }

    let attempt = buffer;
    if (inString) attempt += '"';
    while (stack.length > 0) {
      attempt += stack.pop();
    }
    attempt = attempt.replace(/,\s*([}\]])/g, "$1");

    try {
      const start = attempt.indexOf("{");
      if (start === -1) return null;
      return JSON.parse(attempt.slice(start));
    } catch {
      return null;
    }
  }
}
