---
"@llm-ports/core": patch
---

**The public status page now says what is actually being built next.**

Its forward-looking half had drifted furthest of anything published. It described a two-release path to beta that has since been merged into one, named an `alpha.35` and an `alpha.36` whose contents are different, and carried a work queue whose top rows had shipped.

What the page says now:

- **The alpha line ends at `0.1.0-alpha.35`**, and the next release is a candidate for `1.0.0` carrying every remaining breaking change together, so it can be baked once rather than trickled out. The seven remaining shape changes are listed, along with what gates the candidate.
- **All twelve published packages settle at `1.0.0` together, and the shared version number retires there**, after which each package moves on its own. An earlier plan tiered them as settled and still-moving; that distinction cannot survive version 1, where "still moving" would mean "we may break you without warning".
- **Withdrawals are stated rather than quietly dropped**, with their reasons, including the open mind deliberately kept on the three local-runtime items and the reopened question of whether conversation history should be offered as an option.
- **The roadmap section keeps its content and loses its wrong version numbers**, since what it called v0.2 is now the additive line after `1.0.0`.

Install advice on the page is updated too, including the part that reverses at `1.0.0`: an exact pin is the right thing during a prerelease line precisely because a range cannot refuse a breaking change there, and a caret range becomes the right thing once a break has to announce itself as a major version.

No code changes.
