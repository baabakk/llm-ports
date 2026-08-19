/**
 * AuthBackend — pluggable storage for "which provider aliases have ever
 * authenticated successfully".
 *
 * Alpha.30 introduced this state to distinguish two authentication failures
 * that need opposite handling:
 *
 *   - An alias that has NEVER authenticated fails with a dead key at
 *     chain-open. The right move is to walk to the next provider.
 *   - An alias that HAS authenticated, then fails, means something changed
 *     underneath the process (key revoked, plan downgraded, account
 *     suspended). The right move is to abort loudly rather than quietly
 *     degrade onto a fallback.
 *
 * Alpha.30 stored that set as a private field on each Registry instance, so
 * two Registry instances held two independent copies and could reach opposite
 * verdicts on the same credential depending on which authenticated first.
 * Alpha.31.1 makes the store injectable, matching the treatment `BudgetBackend`
 * and `CostBackend` already had, so instances that should share a view can.
 *
 * ## Why this interface is synchronous
 *
 * `BudgetBackend` and `CostBackend` are async because they gate on counters
 * that a durable store may need I/O to read. This one is deliberately sync:
 * `Registry.hasEverAuthenticated()` is a public synchronous method, and the
 * value is read inside error classification (`shouldFallback`), which is a
 * synchronous decision path. Making it async would be a breaking API change
 * and would push `await` into error handling for a set-membership test.
 *
 * The practical consequence is a real scope limit, stated plainly: a sync
 * backend can share state between Registry instances **in one process**,
 * which is the case the defect was reported against. It cannot by itself
 * perform blocking cross-process reads. A deployment that wants a view shared
 * across processes can still implement this interface over a locally-cached
 * snapshot that some other mechanism refreshes, but the refresh is that
 * implementation's concern, not this interface's. A genuinely async variant
 * remains open work.
 */
export interface AuthBackend {
  /**
   * True if this provider alias has completed at least one successful
   * attempt within this backend's scope.
   */
  hasEverAuthenticated(providerAlias: string): boolean;

  /**
   * Record that this provider alias authenticated successfully. Called by the
   * Registry on every successful attempt. Implementations should treat this
   * as idempotent; the Registry does not deduplicate before calling.
   */
  markAuthenticated(providerAlias: string): void;
}
