/**
 * AbortSignal entry-time check helper for adapter port methods.
 *
 * Each adapter calls `throwIfAborted(signal)` at the top of every port
 * method that accepts a `signal?: AbortSignal`. This avoids the boilerplate
 * of "if (signal?.aborted) throw signal.reason ?? new Error(...)" repeated
 * at every entry, and ensures consistent error shape across adapters.
 *
 * When the signal is undefined or not yet aborted, this is a no-op.
 *
 * The mid-flight cancellation (the more important half of the contract)
 * happens by passing `signal` to the underlying SDK call. This helper only
 * covers the entry-time fast-path.
 */

/**
 * Throw if the given AbortSignal has already been aborted. No-op when
 * `signal` is undefined or not yet aborted.
 *
 * Honors `signal.reason` when present (modern AbortController convention);
 * falls back to a generic `AbortError`-shaped error otherwise.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    // signal.reason was added to the spec in 2022; widely available in
    // Node 18+ and all modern browsers. Fall back to a sane default if
    // the runtime predates it.
    const reason =
      (signal as { reason?: unknown }).reason ??
      new DOMException("The operation was aborted.", "AbortError");
    throw reason;
  }
}
