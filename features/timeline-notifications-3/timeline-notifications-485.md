## Timeline and Notifications Enhancements — I-485 / Adjustment of Status (AOS)

## Overview
Third parallel analysis in this series (`timeline-notifications-ead.md`,
`timeline-notifications-h1b.md`), requested to check redundancy between
`I-485` (the form) and `adjustment-of-status-AOS`/`AOS`-prefixed tags.

## Task
1. Inventory what tags exist for I-485 filing / Adjustment of Status.
2. Evaluate redundancy between `I-485` and `adjustment-of-status-AOS`
   (and the broader `aos-*` tag family).
3. Recommend action.

---

> **STATUS: §6's fix IMPLEMENTED.** `adjustment-of-status-AOS` retired from
> `1.10-common-misc.csv`; `_AOS_TAGS` (`posting.py:647`) updated to drop it
> and add the bare `"AOS"` abbreviation in its place (the comment there
> already described intending to cover "the bare form/abbreviation" — this
> makes that literally true). `1.2-greencard-categories.csv`'s
> `adjustment-of-status` row's cross-reference column updated from
> `adjustment-of-status-AOS` to `AOS` for consistency. Two affected tests
> (E54, E16c in `test_posting_tagging.py`) repointed to the surviving `AOS`
> tag rather than deleted — same fixture intent preserved. Mobile's composer
> `TAGS` list and `docs/ingestion/SIDECAR-METADATA-DESIGN.md`'s example
> updated in lockstep. Live-data check confirmed zero published usage before
> removal. Full backend/mobile test suites green (122/122 offline
> `test_posting_tagging.py` checks, including E54/E16c).
>
> **One important thing discovered during implementation, not in the
> original analysis**: `docs/tagging/us_immigration_tag_specification.md`
> §9 ("tag with abbreviation" exceptions) explicitly lists
> `adjustment-of-status-AOS`/`AOS` as one of three deliberate
> spelled-out-plus-abbreviation pairs (alongside `change-of-employer-COE`/
> `COE` and `employment-authorization-EAD`/`EAD`), and §10 ("Redundancy
> Exceptions") explicitly sanctions this shape of redundancy, provided
> search bridges the two names semantically. This fix remains consistent
> with that intent — `AOS`'s `alternate_tag` column already provides that
> search bridge independent of the 1.10 duplicate's existence (confirmed via
> `search_client.py`'s `_facet_registry()`, `cc772e1`) — but
> **`change-of-employer-COE`/`COE` has the identical unaddressed duplicate
> shape and was NOT touched by this fix** (out of scope — this doc only
> covers I-485/AOS). Worth a follow-up if tag cleanliness is revisited.
>
> **§7 (i485-filing/aos-filing consolidation) and §8 (date-key renaming)
> remain NOT implemented, per their own recommendation.**

---

## 1. Current state — tag inventory

This is structurally the most tangled of the three cases, because the same
underlying concept ("filing to become a permanent resident from within the
U.S.") is represented **three separate ways** in the vocabulary, not two:

**Form (1.5)**
- `I-485` — Application to Register Permanent Residence or Adjust Status
- `I-485J` — a related job-portability form (not relevant here)

**Abbreviation (1.3)**
- `AOS` — alternate_tag column value: `adjustment-of-status-AOS`. Description:
  "Process to apply for a Green Card from within the U.S. without leaving."

**Standalone topic tag (1.10)** — `adjustment-of-status-AOS` — description:
"Process of adjusting to Green Card status from within the U.S." **This is
its own independently-selectable tag, sharing the exact literal string that
also appears as `AOS`'s alternate_tag cross-reference** (see §2 for why that
matters).

**Greencard category (1.2)** — `adjustment-of-status` — the *last-resort*
category code (used only when AOS is referenced but the underlying basis —
family/employment/diversity/asylum — can't be determined). Its "Relevant
Tags" column also lists `adjustment-of-status-AOS`.

**Action tags (1.6)**
- I-485-prefixed: `i485-filing`, `i485-approval`, `i485-rfe`
- AOS-prefixed (Visa/Form column: `AOS / I-485`): `aos-filing`,
  `aos-interview`, `aos-approval`
- **Not symmetric**: `i485-rfe` has no `aos-rfe` counterpart; `aos-interview`
  has no `i485-interview` counterpart. Only `filing` and `approval` overlap.

**Dates (1.8)**
- `i485_filed_date` — Date Form I-485 was filed
- `aos_appointment_date` — AOS interview/appointment date
- `aos_approved_date` — Date AOS application was approved
- **These three do NOT literally duplicate each other** — each covers a
  different milestone (filed / interview / approved). The "redundancy" here
  is inconsistent prefixing (`i485_` vs `aos_`) across one shared journey,
  same shape as the original EAD `i765_filed_date`/`ead_approved_date`
  finding — not a true duplicate pair like `h1b_filed_date`/`i129_filed_date`
  was.

## 2. A structural issue not present in the other two docs: `adjustment-of-status-AOS` looks like an accidental duplicate of `AOS` itself

This is worth flagging on its own, separate from the I-485-vs-AOS action-tag
question that was actually asked, because it's a near-exact structural match
for a bug this codebase **already fixed once**: commit `b28ab53` retired a
standalone 1.10 tag (`port-of-entry`) that duplicated an existing 1.3
abbreviation (`POE`) — the two shared the same real-world meaning, and the
1.10 entry's only real content was in the *description*, while the
abbreviation already covered the concept as a terse, canonical code.

`adjustment-of-status-AOS` (1.10) has the identical shape: it duplicates
`AOS` (1.3), and the literal string `adjustment-of-status-AOS` is *also*
what `AOS`'s own `alternate_tag` column already points to — meaning the
1.10 entry isn't even providing a distinct alias, it's a second, fully
independent, separately-selectable tag carrying the exact same string that
`AOS` already cross-references for search purposes (`search_client.py`'s
`_facet_registry()`, per commit `cc772e1`, already indexes `AOS`'s
alternate_tag/Full Name columns as search synonyms — **this indexing exists
and works independent of whether `adjustment-of-status-AOS` also exists as
its own separate 1.10 tag**, confirmed by reading `_code_variants()`/
`_facet_registry()` in `search_client.py`).

Mobile's composer `TAGS` autocomplete list
(`mobile/src/constants/onboardingData.ts:70`) currently offers
`adjustment-of-status-AOS` as a manually-addable tag — **exactly the same
situation `port-of-entry` was in before it was retired** (also present in
that same composer list at the time).

## 3. Live verification

Ran `_extract()` against synthetic posts covering I-485-specific,
AOS-specific, and shared filing/approval language. Read-only, no CSV changes,
no publish. (Two calls hit a transient `429 RESOURCE_EXHAUSTED` from the
Gemini API mid-run — unrelated to this investigation, retried successfully.)

| Test post | Tags returned |
|---|---|
| "I just submitted my I-485... basis is my approved I-140 in EB-2" | `I-485`, `I-140`, **`aos-filing`, `i485-filing`, `adjustment-of-status-AOS`** (all three simultaneously), `i140-approval`, `eb2-petition`, `employment-based-immigration` |
| "Finally filed for my adjustment of status..." (no form number) | `aos-filing`, `employment-based-immigration` |
| "Got my adjustment of status interview notice..." | `aos-filing`, `aos-interview` (no i485 tag — correct, no equivalent exists) |
| "Got a Request for Evidence on my I-485..." | `I-485`, `RFE`, `aos-filing`, `rfe-denied` *(mistagged — text never mentions a denial)*, `pending` — **`i485-rfe` was available but not chosen** |
| "My I-485 application was approved today..." | `I-485`, `approved`, **`aos-approval`** *(not `i485-approval`, despite it being available)*, `green-card-status` |
| "Just started my adjustment of status process..." (vague, no specifics) | *(no AOS/I-485 tags at all — too vague to trigger any of them)* |

**Findings:**
- **Real redundancy, confirmed live and more directly than either prior
  case**: the first test applied `i485-filing`, `aos-filing`, **and**
  `adjustment-of-status-AOS` to the *same single posting simultaneously* —
  not an either/or choice like EAD/H-1B showed, but genuine overlapping
  over-tagging happening today.
- **Same preference direction as the EAD case**: when the model does pick
  one action-tag prefix, it leans toward `aos-*` (5 of 6 tests) over
  `i485-*` (only 1 of 6, and that one co-occurred with `aos-filing` rather
  than replacing it). This mirrors `ead-filing` being preferred over
  `i765-filing` — across both cases, the model favors the human-friendly
  benefit/process name over the bureaucratic form number for *action* tags,
  while still applying the form tag itself (`I-485`, `I-765`) correctly
  whenever the form number is mentioned in text.
- **Unlike `i765-filing` (never chosen even once across all EAD tests)**,
  `adjustment-of-status-AOS` *was* chosen here — it isn't dead weight the
  way the EAD case's redundant tag was. Retiring it would be a real behavior
  change, not a no-op — though still likely a desirable one, since it's
  adding a third overlapping tag on top of two that already cover the same
  ground.
- **Side finding, not central to this doc's question**: `i485-rfe` was
  never selected even for RFE-specific text — the model reached for the
  generic `RFE` abbreviation instead. Possibly under-surfaced in the prompt;
  flagged for awareness, not a redundancy issue.

## 4. The existing safety net: `_AOS_TAGS` already normalizes all of this downstream

Critical mitigating factor, and the reason none of this is currently causing
incorrect behavior: `backend/posting.py:647-648` already defines

```python
_AOS_TAGS = {"I-485", "i485-filing", "i485-approval", "i485-rfe",
             "aos-filing", "aos-interview", "aos-approval", "adjustment-of-status-AOS"}
```

— an explicit, deliberate set treating **all eight variants as equivalent**
for the purpose of backfilling `adjustment-of-status` when no more specific
basis is stated. The comment at `posting.py:518` states this outright:
*"I-485 and 'AOS'/'adjustment of status' are used interchangeably by posters
for the same real-world action... treat a mention of either the same way."*

This is a materially different starting point than the EAD case, where no
such normalization existed at all. **The redundancy here is a data-quality/
UX cost (cluttered `tags` arrays, more facets a user has to know about), not
a correctness risk** — the downstream visa-category derivation already
treats every variant identically.

## 5. Code-dependency comparison

`i485-filing`/`I-485`/`aos-filing`/`aos-approval`/`adjustment-of-status-AOS`
have **substantially more test coverage than either prior case** —
`backend/tests/test_posting_tagging.py` alone references specific tags from
this set in at least 15 separate checks: E12d, E53, E54, E55, E56, E57, E58,
E59a, E59b, E66, E69, E71, E73, F10, F11, F12. A representative sample:

| Test | What it fixtures |
|---|---|
| E54 (`test_posting_tagging.py:622-624`) | `adjustment-of-status-AOS` **alone** backfills to `adjustment-of-status` — dedicated single-tag test |
| E53 | `["I-485", "aos-filing"]` → `adjustment-of-status` |
| E55 | `["i485-filing", "family-based-immigration"]` — specific basis wins over generic |
| E59a/E59b | bare `I-485`/`aos-filing` resolve end-to-end via `build_canonical()` |
| F10-F12 | live end-to-end Gemini retries confirming AOS + specific-basis interplay |

`i485_filed_date`/`aos_approved_date` are also named directly in the Gemini
onboarding prompt (`profile.py:487,500`), same as `h1b_filed_date` was —
**more entrenched than `i765_filed_date` ever was**, reinforcing that these
particular date keys shouldn't be renamed even though the prefix
inconsistency exists (same conclusion as not touching `h1b_filed_date`).

**`adjustment-of-status-AOS` specifically** has a much smaller, cleaner
footprint: only **two** test references found (`test_posting_tagging.py:622`
dedicated E54 check, and `:330` as one fixture entry in a larger list) —
comparable in size to how small `port-of-entry`'s footprint was before it
was retired.

## 6. Recommendation — the clear, low-effort fix

**Retire `adjustment-of-status-AOS` (1.10)**, following the exact `b28ab53`
POE playbook:
1. Confirm actual live-published-data usage first (same prerequisite as the
   other two docs — not yet done, needs Firestore/Discovery Engine access
   this environment doesn't have configured).
2. Remove the row from `1.10-common-misc.csv`.
3. Update `_AOS_TAGS` (`posting.py:648`) to drop `"adjustment-of-status-AOS"`
   from the set — the remaining 7 members already cover every case it did,
   confirmed by §4's normalization logic.
4. Update the two test references (`test_posting_tagging.py:622-624` and
   `:330`) to use a different existing AOS-family tag as their fixture.
5. Remove `'adjustment-of-status-AOS'` from mobile's composer `TAGS` list
   (`onboardingData.ts:70`) — same lockstep update the POE fix made.
6. No search-discoverability loss: `AOS`'s own `alternate_tag`
   (`adjustment-of-status-AOS`, same string) is already indexed as a search
   synonym independent of the 1.10 tag's existence (§2).

This is genuinely comparable in scope and risk to the already-completed POE
fix — small test footprint, a proven playbook, and (per §3) confirmed live
evidence the tag actually gets selected redundantly today, unlike the
theoretical risk POE's retirement addressed.

## 7. Flagged but NOT recommended for this pass: consolidating `i485-filing`/`i485-approval` into `aos-filing`/`aos-approval`

Live evidence (§3) shows the same preference-for-the-friendly-name pattern
that made the EAD/I-765 consolidation safe. But unlike that case:
- **~15 existing tests** reference `i485-filing`/`I-485` as specific
  fixtures (§5) — a materially larger rewrite than EAD's near-zero test
  footprint.
- `_AOS_TAGS` already neutralizes the *correctness* risk of leaving both in
  place (§4) — the urgency to fix this is lower than it was for
  `adjustment-of-status-AOS`, which was contributing a genuine third
  redundant tag on top of an already-redundant pair.
- `i485-rfe` and `aos-interview` must be kept regardless (no equivalent on
  the other side) — so this would only ever be a partial consolidation
  (filing + approval), not a clean full retirement of one prefix.

**Recommendation: revisit this as its own, separate, appropriately-scoped
effort if tag cleanliness becomes a priority** — don't bundle it with §6's
low-risk fix. If pursued later, the correct scope is: retire `i485-filing`
and `i485-approval` only (keep `i485-rfe`, keep `aos-interview`, keep both
`I-485` and `AOS` as they serve different roles), update `_AOS_TAGS`
accordingly, and rewrite the ~10 tests that specifically fixture
`i485-filing`/`I-485` as their `tags` input rather than deleting that
coverage outright.

## 8. Not recommended: renaming `i485_filed_date`/`aos_approved_date`/`aos_appointment_date`

Unlike `i765_filed_date` (zero code dependencies before the EAD fix), these
three are each independently load-bearing (Gemini onboarding prompt,
`_MILESTONE_DATE_KEY`, mobile onboarding milestones, `test_profile.py`'s
`filed_keys` completeness check) and — critically — **they aren't actually
duplicates of each other**, each covers a distinct milestone (filed /
interview / approved). The inconsistent `i485_`/`aos_` prefixing is a
cosmetic naming quirk, not a functional redundancy, and the entrenchment
cost of touching it clearly outweighs the benefit. No action recommended.
