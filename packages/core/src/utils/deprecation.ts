/**
 * Deprecation-warning emitter with fingerprint-based dedup.
 *
 * When the Registry synthesizes `messages` from the deprecated `{instructions,
 * prompt}` shape, it emits a one-line `console.warn` per unique (method,
 * call-site) tuple per Registry instance. Callers with 50 legacy call sites
 * see at most 50 warnings across the runtime lifetime; repeated calls from
 * the same site are silenced after the first.
 *
 * The fingerprint is computed lazily: only when a warning would fire and
 * the (method, first-frame) pair hasn't been seen yet. When the pair has
 * already been seen, no stack capture happens. This keeps the hot path
 * cheap — the O(1) Set lookup runs on every legacy call, but the O(stack)
 * capture runs at most once per unique site.
 *
 * A `WarningState` object holds the dedup Set and a suppression flag; each
 * Registry constructs one at instantiation and threads it into every
 * legacy-path emit call. Reset by discarding the Registry.
 *
 * Added in `0.1.0-alpha.26` (issue #TBD).
 */

/** Per-Registry deprecation-warning state. */
export interface WarningState {
  /** When true, no warnings fire regardless of the fingerprint set. */
  suppressed: boolean;
  /** Set of (method, first-frame-hash) pairs already warned for. */
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
 * Emit a deprecation warning for the legacy `{instructions, prompt}` path,
 * deduplicated by method per Registry. Cheap on repeat calls: only the
 * O(1) Set lookup runs after the first warning per method.
 *
 * The dedup grain is deliberately coarse (method-only, not per-call-site).
 * Rationale: async stack traces make per-site fingerprinting unreliable
 * (V8 async continuations produce slightly different traces across
 * invocations of the same site), and one warning per unique method per
 * Registry is sufficient to alert the consumer. A consumer with 50 legacy
 * call sites gets 4 warnings (one per method) — enough signal to trigger
 * a migration audit without flooding logs.
 *
 * If per-site granularity is needed later, `WarningState.warned` can be
 * refined with a caller-supplied fingerprint function.
 */
export function warnDeprecatedLegacyInput(
  state: WarningState,
  method: string,
): void {
  if (state.suppressed) return;
  const key = method;
  if (state.warned.has(key)) return;
  state.warned.add(key);
  const message =
    `[llm-ports] DEPRECATED: 'instructions'/'prompt' fields on ${method} ` +
    `will be removed in alpha.27. Use 'messages: LLMMessage[]' instead. ` +
    `See https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-25-to-alpha-26.md.`;
  const handler = state.handler ?? console.warn.bind(console);
  handler(message);
}
