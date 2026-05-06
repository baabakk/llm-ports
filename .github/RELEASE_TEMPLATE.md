<!--
Manual release-notes template. Copy this into the GitHub Release body
when tagging a stable release (it complements the auto-generated PR
list from .github/release.yml — that one is mechanical; this one tells
the story).

For pre-release tags (alpha/beta/rc) the auto-generated body alone is
usually fine. Use this template for `latest`-tag releases.
-->

# v0.X.0

## What changed

<!--
1-3 sentences describing the theme of this release. Examples:
- "First stable release. The alpha API is now frozen for v0.x; breaking changes will be deferred to v1.x."
- "Brings observability to first-class status: every adapter retry, validation attempt, and budget gate fires a hook."
- "New adapter for [provider]; expanded fallback semantics; capability factories now accept async hooks."
-->

## New

<!-- New packages, capabilities, adapters, public-API surface. Link to docs. -->

## Changed

<!-- Behavior changes (breaking and non-breaking). For breaking, link to migration notes below. -->

## Fixed

<!-- Bug fixes notable enough for the release notes. Link to closed issues. -->

## Migration notes

<!--
For breaking changes only. One subsection per breaking change:

### Renamed `X` to `Y`

Old:
\`\`\`ts
// before
\`\`\`

New:
\`\`\`ts
// after
\`\`\`
-->

## Known limitations

<!--
Carry-overs from the README's "Known Limitations" section that this
release didn't fix. Link to tracking issues.
-->

## Thanks

<!--
@-mention contributors. Include people who filed bug reports or feature
requests that drove changes here, not just code authors. Pull from the
auto-generated section below for the PR-author list.
-->

---

<!-- Auto-generated PR list will land here when you click "Generate release notes". -->
