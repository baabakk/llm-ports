---
"@llm-ports/adapter-google": patch
---

**Documentation corrected against the source, plus a new page on configuring the registry.**

A reconciliation of every published page against the code found eleven claims describing a version of this library that no longer exists, most of them understating what ships. Corrected:

- **The Vercel adapter page** said its agent loop was single-turn, that multimodal content degraded to `[image content]` placeholders, that you had to supply all pricing yourself, and that a typed empty-response error was still to come. All four shipped in `0.1.0-alpha.8` or since: the loop is multi-turn and bounded by `maxSteps`, images, audio and documents pass through as real content parts, a bundled pricing table covers the common models with your entries merging over it, and `EmptyResponseError` is thrown today. The page now also states the genuine limits, which are different ones: reasoning budgets are rescued after a starved call rather than anticipated before it, audio by URL is refused because Vercel routes audio as file data, and a tool-role message is flattened to user text.
- **The Google adapter's own file header** claimed prompted JSON with native `responseSchema` still to come, and a single-turn agent shim. Both have shipped: structured output is constrained by `responseSchema`, falling back to prompted JSON only when a Zod schema uses a feature the schema language cannot express, and the agent loop is real and bounded by `maxSteps`.
- **The adapter feature matrix and the content-block table** carried the same stale Vercel cells.
- **The homepage** advertised 17 capability factories where 7 ship, its own detail line listing the 7, and 4 adapters where 7 exist. Both now state the shipped count.
- **The status page** listed the `pricing: "free"` sentinel as withdrawn on the same page that records it shipping in `alpha.34`.
- **The cost-gating guide** now says plainly that persistent budget counters need nothing from us: `BudgetBackend` and `CostBackend` are public interfaces the registry accepts, and the package still to come will add a tested implementation rather than the ability to supply one. Two consumers had recorded the seam itself as missing.

**New: [Configuration](/concepts/configuration).** Where a provider alias comes from in each of the two configuration forms, why an alias derived from an environment variable name cannot contain the slashes and dots that real model ids carry, what the object form requires that the environment form fills in for you, and what the registry does when a route names a provider that does not exist.

No runtime change in any package. The version bump exists to carry the adapter header correction.
