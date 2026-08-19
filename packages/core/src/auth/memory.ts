/**
 * In-memory implementation of AuthBackend.
 *
 * This is the Registry's default, and it reproduces alpha.30's behavior
 * exactly: a plain Set, never reset, scoped to whatever holds it. A Registry
 * constructed without an explicit `auth` option gets its own instance, so
 * nothing changes for consumers who do not opt in.
 *
 * To share one authentication view across several Registry instances in the
 * same process, construct one of these and pass it to each Registry:
 *
 * ```ts
 * const auth = new InMemoryAuth();
 * const fast = createRegistryFromEnv({ adapters, auth });
 * const heavy = createRegistryFromEnv({ adapters, auth });
 * // A successful auth on `fast` is now visible to `heavy`, so both classify
 * // a later failure on that alias the same way.
 * ```
 */
import type { AuthBackend } from "./types.js";

export class InMemoryAuth implements AuthBackend {
  /**
   * Aliases that have completed at least one successful attempt. Never
   * reset — a provider that authenticated once is trusted for the lifetime
   * of this backend. Process restart is what re-verifies.
   */
  private readonly authenticated: Set<string> = new Set();

  hasEverAuthenticated(providerAlias: string): boolean {
    return this.authenticated.has(providerAlias);
  }

  markAuthenticated(providerAlias: string): void {
    this.authenticated.add(providerAlias);
  }
}
