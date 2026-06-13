/**
 * In-memory implementations of BudgetBackend and CostBackend.
 *
 * Default for development and single-process deployments. For multi-process
 * deployments, swap in a Redis-backed implementation (separate package).
 *
 * Storage keys are arbitrary strings — the Registry composes them as
 * `${alias}` or `${alias}|${scope}:${scopeId}` (alpha.20+) to make gating
 * per-alias or per-scope. The backends don't need to know the schema.
 */

import type {
  BudgetBackend,
  BudgetCheckResult,
  BudgetLimit,
  CostBackend,
  CostCheckResult,
  CostLimit,
} from "./types.js";

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

// ─── Budget backend (request count per window) ───────────────────────

/**
 * In-memory implementation. Stores per-key arrays of request timestamps and
 * counts windowed views from them lazily. Supports per-minute, per-hour, and
 * legacy `requestsPerHour` (alpha.19 backwards compat).
 *
 * `perSession` from BudgetLimit is intentionally ignored here — session-scope
 * enforcement lives in CostSession (which is the only thing that knows
 * "this is the same session"). The backend exists for per-alias / per-scope
 * windowed enforcement.
 */
export class InMemoryBudget implements BudgetBackend {
  private requests = new Map<string, number[]>();

  async recordRequest(key: string): Promise<void> {
    const arr = this.requests.get(key) ?? [];
    arr.push(Date.now());
    this.requests.set(key, arr);
    this.prune(arr);
  }

  async check(key: string, limit: BudgetLimit): Promise<BudgetCheckResult> {
    if (limit.kind === "unlimited") {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const arr = this.requests.get(key) ?? [];
    const now = Date.now();

    // Build the configured window ceilings. perSession is enforced by
    // CostSession, not the windowed backend, so it's skipped here.
    const ceilings: Array<{ windowMs: number; cap: number; label: string }> = [];
    if (limit.perMinute !== undefined) {
      ceilings.push({ windowMs: ONE_MINUTE_MS, cap: limit.perMinute, label: "minute" });
    }
    const perHour = limit.perHour ?? limit.requestsPerHour;
    if (perHour !== undefined) {
      ceilings.push({ windowMs: ONE_HOUR_MS, cap: perHour, label: "hour" });
    }

    for (const ceiling of ceilings) {
      const cutoff = now - ceiling.windowMs;
      const current = arr.reduce((n, t) => (t >= cutoff ? n + 1 : n), 0);
      if (current >= ceiling.cap) {
        return {
          allowed: false,
          current,
          limit: ceiling.cap,
          reason: `Request budget exceeded for "${key}": ${current} >= ${ceiling.cap}/${ceiling.label}`,
        };
      }
    }

    if (ceilings.length === 0) {
      return { allowed: true, current: 0, limit: Infinity };
    }
    // Surface the tightest configured window's current usage for visibility.
    const tightest = ceilings.reduce((a, b) => (a.cap < b.cap ? a : b));
    const cutoff = now - tightest.windowMs;
    const current = arr.reduce((n, t) => (t >= cutoff ? n + 1 : n), 0);
    return { allowed: true, current, limit: tightest.cap };
  }

  private prune(arr: number[]): void {
    // Keep at most the last hour of timestamps — adequate for hour-grained
    // windowed checks, which is the longest window the backend enforces.
    const cutoff = Date.now() - ONE_HOUR_MS;
    while (arr.length > 0 && arr[0]! < cutoff) {
      arr.shift();
    }
  }
}

// ─── Cost backend (USD per minute/hour/day/month) ────────────────────

interface CostEntry {
  timestamp: number;
  usd: number;
}

export class InMemoryCost implements CostBackend {
  private spends = new Map<string, CostEntry[]>();

  async recordCost(key: string, usd: number): Promise<void> {
    const arr = this.spends.get(key) ?? [];
    arr.push({ timestamp: Date.now(), usd });
    this.spends.set(key, arr);
    this.prune(arr);
  }

  async check(key: string, limit: CostLimit): Promise<CostCheckResult> {
    if (limit.kind === "unlimited") {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const arr = this.spends.get(key) ?? [];
    const now = Date.now();
    const ceilings: Array<{ windowMs: number; cap: number; label: string }> = [];
    if (limit.perMinute !== undefined) ceilings.push({ windowMs: ONE_MINUTE_MS, cap: limit.perMinute, label: "minute" });
    if (limit.perHour !== undefined) ceilings.push({ windowMs: ONE_HOUR_MS, cap: limit.perHour, label: "hour" });
    if (limit.perDay !== undefined) ceilings.push({ windowMs: ONE_DAY_MS, cap: limit.perDay, label: "day" });
    if (limit.perMonth !== undefined) ceilings.push({ windowMs: ONE_MONTH_MS, cap: limit.perMonth, label: "month" });
    // perSession is enforced by CostSession; skipped here.

    for (const ceiling of ceilings) {
      const cutoff = now - ceiling.windowMs;
      const spent = arr.reduce((sum, e) => (e.timestamp >= cutoff ? sum + e.usd : sum), 0);
      if (spent >= ceiling.cap) {
        return {
          allowed: false,
          current: spent,
          limit: ceiling.cap,
          reason: `Cost cap exceeded for "${key}" per ${ceiling.label}: $${spent.toFixed(4)} >= $${ceiling.cap}`,
        };
      }
    }

    if (ceilings.length === 0) {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const tightest = ceilings.reduce((a, b) => (a.cap < b.cap ? a : b));
    const cutoff = now - tightest.windowMs;
    const spent = arr.reduce((sum, e) => (e.timestamp >= cutoff ? sum + e.usd : sum), 0);
    return { allowed: true, current: spent, limit: tightest.cap };
  }

  private prune(arr: CostEntry[]): void {
    const cutoff = Date.now() - ONE_MONTH_MS;
    while (arr.length > 0 && arr[0]!.timestamp < cutoff) {
      arr.shift();
    }
  }
}
