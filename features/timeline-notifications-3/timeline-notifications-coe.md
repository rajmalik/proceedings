## Timeline and Notifications Enhancements — Change of Employer (COE)

## Overview
Fourth parallel analysis in this series (`timeline-notifications-ead.md`,
`timeline-notifications-h1b.md`, `timeline-notifications-485.md`), requested
after discovering during the I-485/AOS implementation that
`change-of-employer-COE`/`COE` has the **identical structural shape** to the
`adjustment-of-status-AOS`/`AOS` duplicate that was just retired.

## Task
1. Inventory what tags exist for change of employer.
2. Evaluate redundancy between `COE` (1.3 abbreviation) and
   `change-of-employer-COE` (1.10 standalone tag).
3. Recommend action.

---

> **STATUS: SUPERSEDED — implemented, opposite of the original §5
> recommendation.** The original recommendation below (§5, "leave both as
> they are") assumed there might be already-published content at stake. A
> follow-up live-data check (TestClient facet search, same methodology as
> the EAD/AOS fixes) confirmed **zero published usage of either `COE` or
> `change-of-employer-COE`** — nothing was actually at risk. With that
> uncertainty resolved, `COE` (1.3) has been retired in favor of
> `change-of-employer-COE` (1.10), consistent with §3's live-tagging
> evidence (the model never once selected bare `COE`, including when the
> query text used the literal acronym).
>
> **What changed:** `COE` row removed from `1.3-abbreviations.csv`. Zero
> code dependencies existed (confirmed in §2), so no equivalent of
> `_AOS_TAGS` needed updating. `docs/tagging/us_immigration_tag_specification.md`
> §9's table updated to reflect the current state of all three original
> "abbreviation exception" pairs. Regression tests added
> (`test_profile_vocab.py` T9-T10, `test_posting_tagging.py` E85-E86).
>
> **The accepted tradeoff, discussed explicitly before implementing:**
> `COE`'s `alternate_tag`-based search-index bridging
> (`search_client.py`'s `_facet_registry()`, `cc772e1`) is now gone — a
> future bare-`"COE"` strict-mode search will silently fall through to
> balanced/semantic mode rather than resolving via an exact facet match (the
> compound tag's own indexing only matches the full 4-word phrase, not the
> bare acronym — traced precisely via `extract_filters()`'s
> `\bterm\b` regex matching, not assumed). Accepted as a reasonable,
> low-probability-impact tradeoff for cleaner future tagging, given zero
> live content depends on it today.
>
> **Also found, NOT addressed (out of scope for this doc):** `COS`
> (`change-of-status-COS`) and `DOA` (`date-of-admission-DOA`) in
> `1.3-abbreviations.csv` have the identical duplicate-tag shape and were
> never evaluated — flagged for a future pass if this class of cleanup is
> revisited.

---

## 1. Current state — tag inventory

**Abbreviation (1.3)** — `COE`, alternate_tag: `change-of-employer-COE`.
Description: "Process of changing employer while on a work visa."

**Standalone topic tag (1.10)** — `change-of-employer-COE`. Description:
"Process of changing employer on a work visa." Same duplicate shape as
`adjustment-of-status-AOS` was: a separately-selectable 1.10 tag sharing the
literal string that `COE`'s own alternate_tag column already cross-references.

**Related, but not the same concept** — `h1b-transfer` (1.6, Visa/Form:
H-1B): "Change of employer for an H-1B worker (new I-129 with new
employer)." This is **H-1B-specific** — unlike `COE`/`change-of-employer-COE`,
which are meant to be generic across any work visa. No equivalent tag exists
for a non-H-1B employer change (e.g. L-1, O-1).

**No form (1.5) exists for this** — there's no dedicated USCIS form solely
for "change of employer"; it's typically accomplished via a new I-129 filing
(referenced in `h1b-transfer`'s own description), not a form of its own.

## 2. Code-dependency check — even lighter than the AOS case

Zero references to `COE` or `change-of-employer-COE` anywhere in
`backend/`, `mobile/`, or `website/` source or test files — no equivalent of
`_AOS_TAGS` exists for this concept, no test fixtures, no mobile onboarding
entries. (Two documentation-only mentions exist —
`docs/tagging/us_immigration_tag_specification.md:335` and
`docs/tagging/LLM-EXTRACTION-PROMPT.md:336` — **neither is live-consumed**;
confirmed `LLM-EXTRACTION-PROMPT.md` despite its own claim to be "the
production system prompt" has zero overlap with the actual `_SYSTEM_PROMPT`
string in `posting.py` — it's a stale/aspirational planning doc, not
executed code. Flagging as a separate, minor documentation-debt item, out of
scope for this analysis.)

## 3. Live verification — the opposite result from every other case in this series

Ran `_extract()` against synthetic posts covering explicit "COE" acronym
usage, spelled-out employer-change language, an H-1B-transfer framing, a
non-H-1B (L-1) employer change, and a post using the bare "COE" acronym
directly in the text. Read-only, no CSV changes, no publish.

| Test post | Tags returned |
|---|---|
| "Doing a COE for my H-1B, new employer is filing..." | `change-of-employer-COE`, `h1b-petition` |
| "I'm changing my employer while on H-1B status..." (no acronym used) | `h1b-petition`, `h1b-transfer`, `change-of-employer-COE` |
| "My H-1B transfer to a new employer was just filed..." | `h1b-transfer` only (no COE-family tag — `h1b-transfer` alone was judged sufficient) |
| "I'm on L-1 status and my new employer wants to sponsor my transfer..." | *(no tags at all — too indirect/vague to trigger anything)* |
| "Can someone explain the **COE** process timeline?..." (literal acronym in text) | `change-of-employer-COE` |

**Findings — directly contradicting the naive assumption that this should
get the same fix as AOS:**
- **`COE` (the bare 1.3 abbreviation) was never selected once, across 5
  varied tests — including the one that used the literal acronym "COE" in
  the post text.** `change-of-employer-COE` (the 1.10 "duplicate") is the
  tag the model reliably reaches for instead, regardless of whether the
  input used the abbreviation or the spelled-out phrase.
- This is the **opposite preference direction** from every other case in
  this series: POE beat port-of-entry, `ead-filing` beat `i765-filing`,
  `aos-filing`/`aos-approval` beat their `i485-*` counterparts — in every
  one of those, the *abbreviation/friendly-name* side won and the
  *form-number/duplicate* side was the dead one. Here, the *1.10 "duplicate"*
  is the one doing real work, and the *abbreviation* looks closer to unused.
- Sample size is smaller here (5 tests vs. 6 for EAD) — this is a real
  empirical signal, not certainty, but it's consistent and includes the one
  test specifically designed to give the abbreviation its best chance
  (literal "COE" in the text) and it still didn't get selected.

## 4. Why the AOS playbook does NOT transfer cleanly here

Two structural reasons this isn't a safe "just repeat the AOS fix, in
whichever direction the evidence points" situation:

1. **Retiring `COE` (1.3) — the empirically "losing" side — would also
   remove the alternate_tag-based search-index bridging mechanism**
   (`search_client.py`'s `_facet_registry()`, `cc772e1`) that only exists on
   **1.3 rows**, not 1.10 rows. When the AOS fix retired the 1.10 duplicate,
   that bridging mechanism was *never at risk* — it lives on the `AOS` (1.3)
   row, which stayed untouched. Retiring `COE` here would be structurally
   different: it would remove the very row that provides "COE" ↔ "change of
   employer" search-synonym bridging, with no equivalent replacement (1.10
   tags don't have an alternate_tag/Full Name column to carry it).
2. **Retiring `change-of-employer-COE` (1.10) — the empirically "winning"
   side — would remove signal the model demonstrably relies on today**,
   unlike `i765-filing`/`adjustment-of-status-AOS`, which were confirmed to
   have near-zero/zero actual selection even when available.

Combined with `docs/tagging/us_immigration_tag_specification.md` §9
explicitly listing this exact pair as one of three intentional
"tag with abbreviation" exceptions (§9/§10 of that doc, discussed at length
in `timeline-notifications-485.md`'s updated status) — there isn't a
confidently-safe direction to consolidate in, unlike the AOS case.

## 5. Recommendation

**Leave both `COE` and `change-of-employer-COE` as-is. No tags removed or
renamed.** Unlike the EAD/I-485 fixes:
- Live evidence doesn't point to a safe, low-risk removal candidate in
  either direction — it actually argues against removing the side that
  looks redundant at first glance.
- Zero code dependencies exist either way, so there's no correctness or
  maintainability pressure forcing a decision now.
- The one asymmetry worth a human decision, if this is ever revisited: is
  it acceptable that `COE` (1.3) is apparently rarely/never selected in
  practice? If so, no action is needed (the 1.10 tag covers the concept
  fine on its own, and the search bridging still nominally exists via the
  unused abbreviation row). If broader/non-H-1B change-of-employer coverage
  is a priority, the more promising direction is closing the **actual**
  gap found in §1 — no L-1/O-1-equivalent of `h1b-transfer` exists — rather
  than touching the COE/change-of-employer-COE pair at all.
