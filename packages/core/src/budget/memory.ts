/**
 * In-memory implementations of BudgetBackend and CostBackend.
 *
 * Default for development and single-process deployments. For multi-process
 * deployments, swap in a Redis-backed implementation (separate package).
 *
 * The implementations use a simple hourly bucket scheme: each provider alias
 * gets a Map of bucket-timestamp -> count/cost. Old buckets are pruned lazily
 * when checked.
 */

import type {
  BudgetBackend,
  BudgetCheckResult,
  BudgetLimit,
  CostBackend,
  CostCheckResult,
  CostLimit,
} from "./types.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

function currentHourBucket(now: number = Date.now()): number {
  return Math.floor(now / ONE_HOUR_MS);
}

// ─── Budget backend (request count per hour) ─────────────────────────

export class InMemoryBudget implements BudgetBackend {
  private counters = new Map<string, Map<number, number>>();

  async recordRequest(alias: string): Promise<void> {
    const bucket = currentHourBucket();
    const buckets = this.counters.get(alias) ?? new Map<number, number>();
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    this.counters.set(alias, buckets);
    this.prune(buckets, bucket - 1);
  }

  async check(alias: string, limit: BudgetLimit): Promise<BudgetCheckResult> {
    if (limit.kind === "unlimited") {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const bucket = currentHourBucket();
    const current = this.counters.get(alias)?.get(bucket) ?? 0;
    if (current >= limit.requestsPerHour) {
      return {
        allowed: false,
        current,
        limit: limit.requestsPerHour,
        reason: `Request budget exceeded for "${alias}": ${current} >= ${limit.requestsPerHour}/hour`,
      };
    }
    return { allowed: true, current, limit: limit.requestsPerHour };
  }

  private prune(buckets: Map<number, number>, oldestKept: number): void {
    for (const k of buckets.keys()) {
      if (k < oldestKept) buckets.delete(k);
    }
  }
}

// ─── Cost backend (USD per hour/day/month) ───────────────────────────

interface CostEntry {
  timestamp: number;
  usd: number;
}

export class InMemoryCost implements CostBackend {
  private spends = new Map<string, CostEntry[]>();

  async recordCost(alias: string, usd: number): Promise<void> {
    const arr = this.spends.get(alias) ?? [];
    arr.push({ timestamp: Date.now(), usd });
    this.spends.set(alias, arr);
    this.prune(arr);
  }

  async check(alias: string, limit: CostLimit): Promise<CostCheckResult> {
    if (limit.kind === "unlimited") {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const arr = this.spends.get(alias) ?? [];
    const now = Date.now();
    const ceilings: Array<{ window: number; cap: number; label: string }> = [];
    if (limit.perHour !== undefined) ceilings.push({ window: ONE_HOUR_MS, cap: limit.perHour, label: "hour" });
    if (limit.perDay !== undefined) ceilings.push({ window: ONE_DAY_MS, cap: limit.perDay, label: "day" });
    if (limit.perMonth !== undefined) ceilings.push({ window: ONE_MONTH_MS, cap: limit.perMonth, label: "month" });

    for (const ceiling of ceilings) {
      const cutoff = now - ceiling.window;
      const spent = arr.reduce((sum, e) => (e.timestamp >= cutoff ? sum + e.usd : sum), 0);
      if (spent >= ceiling.cap) {
        return {
          allowed: false,
          current: spent,
          limit: ceiling.cap,
          reason: `Cost cap exceeded for "${alias}" per ${ceiling.label}: $${spent.toFixed(4)} >= $${ceiling.cap}`,
        };
      }
    }

    // Return the most-restrictive window's current usage for visibility
    if (ceilings.length === 0) {
      return { allowed: true, current: 0, limit: Infinity };
    }
    const tightest = ceilings.reduce((a, b) => (a.cap < b.cap ? a : b));
    const cutoff = now - tightest.window;
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
