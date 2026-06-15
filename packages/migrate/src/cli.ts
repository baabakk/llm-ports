/**
 * CLI entry point for @llm-ports/migrate.
 *
 * Usage:
 *   llm-ports-migrate <migration> [paths...] [--write] [--dry-run] [--quiet]
 *   llm-ports-migrate --list
 *   llm-ports-migrate --help
 */

import { listMigrations, runMigration } from "./index.js";

const HELP = `\
@llm-ports/migrate — codemods for @llm-ports/* alpha upgrades

Usage:
  llm-ports-migrate <migration> [root-path]            (preview / dry-run, default)
  llm-ports-migrate <migration> [root-path] --write    (apply rewrites in place)

Flags:
  --write          Apply changes in place. Default is dry-run.
  --dry-run        Force dry-run (default; explicit override).
  --quiet          Suppress per-file progress logs.
  --list           List available migrations.
  --help           Show this message.

Available migrations:
${listMigrations().map((n) => `  - ${n}`).join("\n") || "  (none registered)"}
`;

interface ParsedArgs {
  migration?: string;
  root?: string;
  write: boolean;
  quiet: boolean;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { write: false, quiet: false, list: false, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--list") out.list = true;
    else if (a === "--write") out.write = true;
    else if (a === "--dry-run") out.write = false;
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (a.startsWith("--")) {
      // eslint-disable-next-line no-console
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (!out.migration) out.migration = a;
    else if (!out.root) out.root = a;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.migration && !args.list)) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.list) {
    process.stdout.write((listMigrations().join("\n") || "(none registered)") + "\n");
    process.exit(0);
  }
  if (!args.migration) {
    process.stderr.write("Missing migration name. Use --help.\n");
    process.exit(2);
  }
  try {
    const report = await runMigration(args.migration, {
      root: args.root,
      write: args.write,
      quiet: args.quiet,
    });
    const tag = args.write ? "Applied" : "Dry-run";
    process.stdout.write(
      `${tag}: ${report.rewritesApplied} rewrite(s) across ${report.filesChanged}/${report.filesScanned} file(s)\n`,
    );
    if (report.manualReviewSites.length > 0) {
      process.stdout.write(`Manual-review sites (${report.manualReviewSites.length}):\n`);
      for (const m of report.manualReviewSites) {
        process.stdout.write(`  ${m.file}:${m.line} — ${m.reason}\n`);
      }
    }
    if (!args.write && (report.rewritesApplied > 0 || report.manualReviewSites.length > 0)) {
      process.stdout.write(`\nThis was a dry-run. Re-run with --write to apply.\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
