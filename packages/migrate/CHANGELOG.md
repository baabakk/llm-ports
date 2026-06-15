# @llm-ports/migrate

## 0.1.0-alpha.20.1

### Initial release

- `alpha-19-to-alpha-20` codemod that rewrites reads of `<expr>.budgetLimit.requestsPerHour` to add `?? Infinity`. Closes the strict-mode TypeScript breakage introduced by the alpha.20 `BudgetLimit` field change.
- Conservative: skips matches already followed by `?`, skips assignment LHS, flags matches inside `if (` conditions as manual-review.
- Defaults to dry-run; `--write` applies rewrites in place.
- CLI binary: `llm-ports-migrate`.
- Programmatic API: `import { runMigration, listMigrations } from "@llm-ports/migrate"`.
- 8 tests in `tests/alpha-19-to-alpha-20.test.ts`.
