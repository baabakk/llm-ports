# @llm-ports/migrate

Codemods for moving consumer code across `@llm-ports/*` alpha releases.

Each codemod is conservative: it rewrites only patterns where the fix is unambiguous, prints a manual-review notice for ambiguous matches, and defaults to dry-run. Always review the diff before committing.

## Install + run

```bash
# Preview the diff (dry-run is the default):
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20

# Apply the rewrites in place:
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 --write

# Scan a specific directory (default: current working directory):
npx @llm-ports/migrate@alpha alpha-19-to-alpha-20 ./apps/web --write

# List all available migrations:
npx @llm-ports/migrate@alpha --list
```

## Available migrations

### `alpha-19-to-alpha-20`

Rewrites reads of `<expr>.budgetLimit.requestsPerHour` to add `?? Infinity`, closing the strict-mode TypeScript breakage introduced by alpha.20 (the field went from required to optional). Conservative: skips matches already followed by `?` (optional chaining or nullish coalescing), skips assignments, flags matches inside `if (` conditions and on assignment LHS as manual-review.

Example:

```diff
- const rph = entry.budgetLimit.requestsPerHour;
+ const rph = (entry.budgetLimit.requestsPerHour ?? Infinity);
```

See [docs/migration/alpha-19-to-alpha-20.md](https://github.com/baabakk/llm-ports/blob/main/docs/migration/alpha-19-to-alpha-20.md) for the full migration page.

## Programmatic use

```ts
import { runMigration, listMigrations } from "@llm-ports/migrate";

const report = await runMigration("alpha-19-to-alpha-20", {
  root: "./src",
  write: true,
});

console.log(report);
// { filesScanned: 42, filesChanged: 3, rewritesApplied: 5, manualReviewSites: [] }
```

## License

MIT.
