/**
 * @llm-ports/migrate — codemods for moving consumer code across alpha releases.
 *
 * Public surface:
 *   - `runMigration(name, options)` — programmatic entry point.
 *   - `listMigrations()` — names of available migrations.
 *   - The CLI in `./cli.ts` wraps this.
 *
 * Codemods are conservative. They rewrite only patterns where the fix is
 * unambiguous, print a `manual-review` notice for ambiguous matches, and
 * default to `--dry-run`. Always review the diff before committing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { walk } from "./helpers/walk.js";

export interface MigrationOptions {
  /** Root path to scan. Defaults to current working directory. */
  root?: string;
  /** Apply changes in place. Default: false (dry-run). */
  write?: boolean;
  /** Suppress per-file progress logs. Default: false. */
  quiet?: boolean;
}

export interface MigrationReport {
  filesScanned: number;
  filesChanged: number;
  rewritesApplied: number;
  manualReviewSites: Array<{ file: string; line: number; reason: string }>;
}

export interface Migration {
  name: string;
  description: string;
  /** File extensions this migration scans. */
  extensions: string[];
  /** Scan + rewrite a single source string. Returns the new source + counts. */
  rewriteSource: (source: string, filename: string) => {
    next: string;
    rewrites: number;
    manualReview: Array<{ line: number; reason: string }>;
  };
}

const MIGRATIONS: Record<string, Migration> = {};

export function registerMigration(m: Migration): void {
  MIGRATIONS[m.name] = m;
}

export function listMigrations(): string[] {
  return Object.keys(MIGRATIONS);
}

export async function runMigration(
  name: string,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const migration = MIGRATIONS[name];
  if (!migration) {
    throw new Error(
      `Unknown migration "${name}". Available: ${listMigrations().join(", ") || "(none registered)"}`,
    );
  }
  const root = options.root ?? process.cwd();
  const report: MigrationReport = {
    filesScanned: 0,
    filesChanged: 0,
    rewritesApplied: 0,
    manualReviewSites: [],
  };
  for await (const file of walk(root, migration.extensions)) {
    report.filesScanned++;
    const source = await readFile(file, "utf8");
    const { next, rewrites, manualReview } = migration.rewriteSource(source, file);
    if (rewrites > 0 || manualReview.length > 0) {
      const rel = relative(root, file);
      if (!options.quiet) {
        const tag = options.write ? "[rewrite]" : "[dry-run]";
        // eslint-disable-next-line no-console
        console.log(`${tag} ${rel}: ${rewrites} rewrite${rewrites === 1 ? "" : "s"}${manualReview.length ? `, ${manualReview.length} manual-review` : ""}`);
      }
      if (rewrites > 0) {
        report.rewritesApplied += rewrites;
        if (options.write) {
          await writeFile(file, next, "utf8");
        }
        if (next !== source) report.filesChanged++;
      }
      for (const m of manualReview) {
        report.manualReviewSites.push({ file: relative(root, file), line: m.line, reason: m.reason });
      }
    }
  }
  return report;
}

// ─── Migration: alpha-19-to-alpha-20 ─────────────────────────────────

/**
 * Rewrites `*.budgetLimit.requestsPerHour` reads to add `?? Infinity`.
 *
 * Conservative match: looks for `<dotted-path>.requestsPerHour` where the
 * left side contains `budgetLimit` (the parsed-config path). Skips matches
 * already followed by `?` (optional chaining or nullish coalescing already
 * present) and matches inside an `if (` condition (where TypeScript's
 * narrowing already handles the optional). Flags ambiguous patterns
 * (assignment LHS, computed-property access) as manual-review.
 */
registerMigration({
  name: "alpha-19-to-alpha-20",
  description:
    "Add `?? Infinity` to reads of `.budgetLimit.requestsPerHour`. Closes the alpha.19.1 → alpha.20 strict-mode breakage at consumer sites.",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  rewriteSource(source) {
    const manualReview: Array<{ line: number; reason: string }> = [];
    let rewrites = 0;

    // Match: any dotted expression ending in `budgetLimit.requestsPerHour`,
    // not already followed by `?` or `!` (we don't double-guard).
    // Assignment LHS and `if (` conditions are detected in the callback so
    // they can be flagged as manual-review.
    const pattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.budgetLimit\.requestsPerHour)(?!\s*[?!])/g;
    const lines = source.split(/\r?\n/);
    const lineStartIndex: number[] = [0];
    for (let i = 0; i < lines.length - 1; i++) {
      const prev = lineStartIndex[i] ?? 0;
      lineStartIndex.push(prev + (lines[i]?.length ?? 0) + 1);
    }
    function lineOf(idx: number): number {
      let lo = 0;
      let hi = lineStartIndex.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStartIndex[mid] ?? 0) <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    }

    const next = source.replace(pattern, (_full, expr: string, offset: number) => {
      // Skip if the match is inside an `if (` condition on the same line —
      // the conditional narrowing handles it.
      const ln = lineOf(offset);
      const line = lines[ln - 1] ?? "";
      const beforeOnLine = line.slice(0, offset - (lineStartIndex[ln - 1] ?? 0));
      if (/\bif\s*\([^)]*$/.test(beforeOnLine)) {
        manualReview.push({ line: ln, reason: "inside `if (` condition — review whether the guard is sufficient" });
        return expr;
      }
      // Skip if used as an assignment LHS.
      const afterOffset = offset + expr.length;
      const afterOnLine = source.slice(afterOffset, afterOffset + 20);
      if (/^\s*=[^=]/.test(afterOnLine)) {
        manualReview.push({ line: ln, reason: "assignment LHS — review intent" });
        return expr;
      }
      rewrites++;
      return `(${expr} ?? Infinity)`;
    });

    return { next, rewrites, manualReview };
  },
});
