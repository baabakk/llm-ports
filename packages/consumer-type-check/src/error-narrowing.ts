/**
 * Alpha.34: `instanceof` narrowing still works after the error taxonomy
 * gained a custom `[Symbol.hasInstance]`.
 *
 * The hook exists so an error from a duplicate copy of `@llm-ports/core` is
 * still recognised. Declaring it as a type predicate is what keeps
 * TypeScript narrowing intact. If the predicate ever degrades to plain
 * `boolean`, or infers `value is unknown`, every consumer's
 * `if (err instanceof X) err.someField` stops compiling.
 *
 * A whole-workspace typecheck does not prove this on its own: code that
 * never reads a subclass-specific field compiles either way. So each check
 * below reads a field that exists only on the narrowed class.
 */

import {
  AttemptTimeoutError,
  ContentBlockUnsupportedError,
  LLMPortError,
  NoProvidersAvailableError,
  ProviderUnavailableError,
  ServiceUnavailableError,
} from "@llm-ports/core";

declare const caught: unknown;

export function readsNarrowedFields(): Array<string | number | undefined> {
  const out: Array<string | number | undefined> = [];

  if (caught instanceof AttemptTimeoutError) {
    // Only AttemptTimeoutError has timeoutMs.
    const ms: number = caught.timeoutMs;
    out.push(ms);
  }

  if (caught instanceof ProviderUnavailableError) {
    // alias is declared on ServiceUnavailableError and inherited.
    const alias: string = caught.alias;
    out.push(alias);
  }

  if (caught instanceof ServiceUnavailableError) {
    const cause: Error | undefined = caught.cause;
    out.push(cause?.message);
  }

  if (caught instanceof NoProvidersAvailableError) {
    const reasons: Record<string, string> = caught.reasons;
    out.push(Object.keys(reasons).length);
  }

  if (caught instanceof LLMPortError) {
    const name: string = caught.name;
    out.push(name);
  }

  if (caught instanceof ContentBlockUnsupportedError) {
    const message: string = caught.message;
    out.push(message);
  }

  return out;
}

/** A subclass-specific field must NOT be readable without narrowing. */
export function doesNotNarrowWithoutTheCheck(): void {
  // @ts-expect-error `caught` is unknown until an instanceof check narrows it.
  void caught.timeoutMs;
}
