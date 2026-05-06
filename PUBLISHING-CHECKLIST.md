# Publishing checklist

The blocking and non-blocking work between today and the public alpha announcement. Pre-launch items at the top, post-launch reactivation at the bottom.

## Phase 0 — pre-launch (must be done before announcing)

### Repository surface

- [x] Public repo created: https://github.com/baabakk/llm-ports
- [x] Repo description set
- [x] Topics applied (15 keywords for GitHub-native search)
- [x] License (MIT) committed
- [x] Homepage URL points at GitHub Pages: https://baabakk.github.io/llm-ports/
- [x] CI (lint + typecheck + test on Node 18/20/22 + build) green
- [x] Pages docs site auto-deploys on every push to `main`
- [ ] **Social preview image** — `assets/social-preview.png` is in the repo. **GitHub's API doesn't allow setting this programmatically.** Upload manually: Settings → Social preview → Edit → upload `assets/social-preview.png`.
- [ ] **GitHub Discussions** enabled — Settings → Features → Discussions. Cold readers expect to see discussion threads, not just issues.
- [ ] **Issue templates** — `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `adapter_request.yml`. Without them every new issue is a blank page.
- [ ] **Pinned issues** — pin a "v0.1 roadmap" issue and a "good first issue" tracker once any are filed.

### Examples (npm-search expectation)

- [x] `/examples/basic` — single-provider end-to-end with one capability call
- [x] `/examples/multi-provider` — fallback chain + cost gating + capability factory
- [ ] `/examples/local-to-cloud` — Ollama in dev → Anthropic/OpenAI in prod by env flip (planned per README roadmap; nice-to-have for v0.1, must-have before reactivation Week 5)
- [ ] `/examples/cost-control` — budget exhaustion + recovery flow (nice-to-have for reactivation Week 3)

### npm package metadata

- [x] All 6 packages have a `description` (~150-200 chars each)
- [x] All 6 packages have keywords (20-30 each, covers high-volume LLM searches)
- [x] All 6 packages have `repository` pointing at the public repo
- [x] All 6 packages have `homepage` (root README or per-package README anchor)
- [x] All 6 packages have `bugs.url` (the repo's issue tracker)
- [x] All 6 packages have `license: "MIT"`
- [x] All 6 packages declare `peerDependencies.zod = ">=3.24.0 <5"` (TD-LLMP-14 fix)

### npm publish gate (Phase 5 of TEST-PLAN)

- [x] `npm whoami` returns the maintainer's account
- [x] Versions bumped to `0.1.0-alpha.0` via `pnpm changeset version`
- [x] Changeset alpha pre-mode active (`.changeset/pre.json` present)
- [x] All 6 packages dry-run cleanly (`npm publish --dry-run`)
- [ ] **`pnpm release`** to publish under the `alpha` tag — single one-shot command
- [ ] Verify each package shows up at `npmjs.com/package/@llm-ports/*` under `@alpha`
- [ ] Smoke-install in a fresh `/tmp` project from `npm install @llm-ports/core@alpha` (not local tarball)

## Phase 1 — soft launch (after publish succeeds)

### Story arc

- [ ] Medium article published with three GitHub-link anchors (top, after architecture section, end)
- [ ] LinkedIn pain-framing post (post 1 — see marketing plan)
- [ ] X thread (post 1 — see marketing plan)
- [ ] DEV.to short version with canonical URL pointing at Medium
- [ ] Hashnode short version

### Rule: no link asks for an empty thing

The Medium / LinkedIn / X CTAs all link to GitHub. Every link must hit a page that delivers value within 10 seconds:
- README's first screen (problem + solution + 60-sec setup) covers this
- `examples/basic` README is the second-most-clicked URL after the root README — make sure it works

## Phase 2 — developer-community launch (after at least 1 week of soft-launch feedback)

- [ ] Show HN with technical-substance first comment
- [ ] r/typescript + r/node + r/opensource posts (one at a time, not the same day)
- [ ] DEV / Hashnode tagged for SEO

### Show HN gate

The Show HN guidelines explicitly say "the work should be ready for users to try". The Phase 0 checklist above is exactly that gate. Don't post Show HN until every Phase 0 box is checked.

## Phase 3 — Product launch platforms

- [ ] Product Hunt scheduled (up to 1 month in advance per their docs)
- [ ] npm v0.1 promoted from `@alpha` to `@latest` (after at least one week of alpha with no critical issues)

## Phase 4 — reactivation cadence (post-announcement)

| Week | Angle | Artifact |
|---|---|---|
| 1 | Architecture | Medium main + LinkedIn + X |
| 2 | Capabilities | `/docs/capabilities.md` polished |
| 3 | Cost control | `/examples/cost-control` (currently missing) |
| 4 | Migration | `/docs/migration/from-vercel-ai.md` polished |
| 5 | Local-to-cloud | `/examples/local-to-cloud` (currently missing) |
| 6 | Show HN / Product Hunt | Only if Phase 0 still green |

## Star and download targets (per marketing plan)

| Milestone | Stars | npm downloads | External engagement |
|---|---|---|---|
| Pre-v0.1 | 50 | 0 (not published yet) | 5-10 issues |
| v0.1 launch month | 100-250 | 100-500 | 1 external example or PR |
| Strong signal | — | — | "How do I migrate from X?" issue, adapter request, or comparison post to LangChain/Vercel AI/LiteLLM/Portkey |

## Tech debt that should be visible to early adopters

These are open in [`TECH-DEBT.md`](./TECH-DEBT.md). Cold readers will hit them; the README + per-adapter docs should call them out so users aren't surprised:

- **TD-LLMP-05** Medium — `zodToParameters` is a stub. Tools in `runAgent` are typeless to the model. Wire `zod-to-json-schema` before announcing `runAgent` as a flagship feature.
- **TD-LLMP-06** Medium — no `onRetry` hook. Production users can't see capability-fallback / transient-401 / reasoning-starved retries.
- **TD-LLMP-11** Medium — Vercel adapter has no reasoning-model handling.
- **TD-LLMP-12** Medium — Vercel adapter throws confusing `SyntaxError` on empty structured response.

These aren't blockers for alpha (alpha = "for testers, not production"), but they should be on the v0.1 punch list before promoting to `@latest`.
