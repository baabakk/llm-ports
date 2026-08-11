/**
 * Deprecation-warning emitter with dedup + suppression + custom handler.
 *
 * A generic surface consumers and library authors reuse whenever a
 * public field, method, or configuration is deprecated on an active
 * release line. Every unique deprecation "where" produces at most one
 * warning per Registry instance; suppression is per-Registry;
 * structured logging routes through the optional `handler`.
 *
 * Renamed and generalized in `0.1.0-alpha.27` from the field-specific
 * `warnDeprecatedLegacyInput(state, method)` shipped in alpha.26. The
 * runtime behavior (method-only dedup, suppression, handler routing)
 * is identical; the new signature accepts a details object instead of
 * just a method name.
 */

/** Per-Registry deprecation-warning state. */
export interface WarningState {
  /** When true, no warnings fire regardless of the dedup set. */
  suppressed: boolean;
  /** Set of `where` keys already warned for. */
  warned: Set<string>;
  /**
   * Optional replacement for `console.warn`. Consumers wanting structured
   * logging can supply a function that receives the warning message.
   * Defaults to `console.warn`.
   */
  handler?: (message: string) => void;
}

/** Fresh warning state for a Registry instance. */
export function createWarningState(opts?: {
  suppressed?: boolean;
  handler?: (message: string) => void;
}): WarningState {
  const state: WarningState = {
    suppressed: !!opts?.suppressed,
    warned: new Set<string>(),
  };
  if (opts?.handler) state.handler = opts.handler;
  return state;
}

/**
 * Descriptor for a deprecation warning. `where` is the dedup key; every
 * unique `where` produces at most one warning per WarningState. Consumers
 * of the library and library authors both use this surface.
 */
export interface DeprecationDetails {
  /**
   * Human-readable name of the deprecated surface. E.g.
   * `"'onMissing' as a function callback"` or
   * `"'perAttemptTimeoutMs' option"`.
   */
  what: string;
  /**
   * Dedup key AND display location. E.g. `"createVersionedStore"` or
   * `"streamText"`. Every unique `where` value produces at most one
   * warning per WarningState.
   */
  where: string;
  /**
   * Version the deprecated surface will be removed in. E.g.
   * `"alpha.35"`. Optional but recommended for consumer planning.
   */
  removalVersion?: string;
  /**
   * URL to the migration guide for this specific deprecation. Optional
   * but recommended.
   */
  migrationUrl?: string;
}

/**
 * Emit a deprecation warning through the shared WarningState. Cheap on
 * repeat calls: only the O(1) Set lookup runs after the first warning
 * per unique `where`. Respects `suppressed` and routes through the
 * optional `handler` (default `console.warn`).
 *
 * Consumers of `@llm-ports/core` who need to fire deprecation warnings
 * from custom code paths (adapter authors, downstream wrapper
 * libraries) can call this with a WarningState acquired from the
 * Registry: `warnDeprecated(registry.warningState, { what, where, ... })`.
 *
 * Generalized in `0.1.0-alpha.27` from the field-specific
 * `warnDeprecatedLegacyInput` that shipped in alpha.26.
 */
export function warnDeprecated(state: WarningState, details: DeprecationDetails): void {
  if (state.suppressed) return;
  if (state.warned.has(details.where)) return;
  state.warned.add(details.where);
  const parts = [`[llm-ports] DEPRECATED: ${details.what} on ${details.where}`];
  if (details.removalVersion) {
    parts.push(`will be removed in ${details.removalVersion}.`);
  } else {
    parts.push(`is deprecated.`);
  }
  if (details.migrationUrl) parts.push(`See ${details.migrationUrl}.`);
  (state.handler ?? console.warn.bind(console))(parts.join(" "));
}

/**
 * Fire a generic warn-once message through a shared WarningState.
 *
 * Sister function to `warnDeprecated`, sharing the same dedup +
 * suppression + handler infrastructure but without the DEPRECATED
 * framing. Use for non-deprecation runtime warnings the library
 * wants to surface exactly once per unique `key` per WarningState.
 *
 * Introduced in alpha.29 for the Registry's unknown-task-type
 * fallback warning (SalesCoach TD-LLM-TASKTYPE-CASE-MISMATCH-SILENT-
 * GENERAL-FALLBACK). The `key` is the dedup handle; the `message`
 * is the fully-formatted body written to the handler.
 */
export function warnOnce(state: WarningState, key: string, message: string): void {
  if (state.suppressed) return;
  if (state.warned.has(key)) return;
  state.warned.add(key);
  (state.handler ?? console.warn.bind(console))(message);
}
