## Timeline and Notifications Enhancements — H-1B filing

## Overview
Parallel analysis to `timeline-notifications-ead.md`, requested to check
whether the same kind of tag redundancy exists for H-1B filing tags vs the
generic Form `I-129` tags.

## Task
1. Inventory what tags exist for H-1B filing.
2. Evaluate whether H-1B-specific tags are redundant with `I-129` tags
   (I-129 is the actual USCIS form H-1B petitions are filed on — same
   relationship as I-765/EAD).
3. Recommend action.

---

> **STATUS: Investigation complete. Recommendation: no tag removal —
> see §5.** This is the opposite conclusion from the EAD/I-765 analysis, for
> reasons specific to how `I-129` is used across multiple visa categories —
> explained in §3. Nothing in `backend/tags-cleaned/`, `posting.py`, or any
> mobile/website code has been changed.

---

## 1. Current state — tag inventory

`I-129` ("Petition for a Nonimmigrant Worker") is filed for **H, L, O, P,
and TN** cases, not just H-1B — same multi-category relationship I-765 has
to OPT/STEM-OPT/H4-EAD/L2-EAD. Full inventory from `backend/tags-cleaned/`:

**Form (1.5)**
- `I-129` — Petition for a Nonimmigrant Worker (H, L, O, P, TN, etc.)

**H-1B-specific action tags (1.6)** — a much larger set than EAD had:
`h1b-petition`, `h1b-filing`, `h1b-lottery`, `h1b-transfer`, `h1b-extension`,
`h1b-renewal`, `h1b-withdrawal`, `h1b-portability-rule`, `h1b-material-change`,
`h1b-6-year-rule`, `h1b-selection-rule`, `h1b-amendment`, `h1b-stamping`,
`h1b-rfe`, `h1b-denial`, `h1b-approval`, `h1b-revocation`, `h1b-reinstatement`,
`h1b-100k-fee`

**Generic I-129 action tags (1.6)** — a much smaller set:
`i129-filing`, `i129-rfe`, `i129-approval` (no `i129-denial`,
`i129-withdrawal`, or `i129-revocation` exist at all)

**Other visas that also file on I-129, with their own action tags:**
`l1-petition`, `l1-extension`, `l1-amendment` (L-1); `o1-petition`,
`o1-extension` (O-1); `tn-renewal` (TN, **no `tn-petition`/`tn-filing`
exists**). **No P-1-specific action tags exist at all.**

**Dates (1.8)**
- H-1B-specific: `h1b_filed_date`, `h1b_receipt_date`, `h1b_approved_date`,
  `h1b_expire_date`, `h1b_processing_start_date`
- Generic: `i129_filed_date` (only one — no `i129_approved_date`,
  `i129_receipt_date`, etc.)
- **No visa-specific filed-date key exists for L-1, O-1, TN, or P-1** —
  `i129_filed_date` is their only option.

## 2. Where H-1B/I-129 show up as milestones (background)

- `h1b_filing`, `h1b_approval`, `h1b_rfe` — free-text `MILESTONES` journey
  labels (`backend/profile.py:198`), same "not controlled tags" caveat as
  `stem_opt` had.
- `h1b_registration`, `h1b_lottery`, `h1b_filing`, `h1b_approval`, `h1b_rfe`
  — mobile onboarding milestone picker entries
  (`mobile/src/constants/onboardingData.ts:129-133`).
- `h1b_filed_date`, `h1b_receipt_date`, `h1b_approved_date`, `h1b_expire_date`
  are **explicitly named in the Gemini onboarding prompt itself**
  (`backend/profile.py:485,500,523,579`) — unlike EAD/I-765, which weren't
  mentioned in that prompt at all.

## 3. Why this is structurally different from the I-765/EAD case

The EAD analysis found `i765-filing`/`i765-approval` genuinely redundant
because **every one of I-765's major real-world use cases already had its
own visa/benefit-specific action tag** (`stem-opt-extension`, `h4-ead`,
`l2-ead`) — there was no coverage gap if the generic form tags were removed.

**I-129 doesn't have that property.** Two of the visas it covers have little
or no visa-specific action-tag coverage of their own:
- **TN** has `tn-renewal` but **no `tn-petition`/`tn-filing`** — an initial
  TN petition has nothing more specific to reach for than `i129-filing`.
- **P-1** has **no action tags at all** — `i129-filing`/`i129-approval`/
  `i129-rfe` and `i129_filed_date` are its *only* coverage.

So `i129-filing`/`i129-approval`/`i129-rfe`/`i129_filed_date` aren't simply
duplicates of the H-1B-specific tags — they're the fallback for the visa
categories (TN, P-1) that don't have their own equivalent, plus the correct
answer for a genuinely underspecified "filed my I-129" post where the visa
type isn't stated at all.

## 4. Live verification

Ran the real Gemini tagging pipeline (`_extract()`) against synthetic posts
covering explicit H-1B language, mixed H-1B+I-129 language, underspecified
I-129 language, and other-visa I-129 language (TN, L-1). Read-only — no CSV
changes, no publish.

| Test post | Tags returned | `key_dates` |
|---|---|---|
| "My employer filed my H-1B petition..." | `h1b-petition`, `h1b-filing` (no i129 tag at all) | `h1b_filed_date` |
| "Got my H-1B approval notice..." | `h1b-approval` (no i129 tag) | — |
| "My company submitted Form I-129... for my H-1B..." (both terms present) | `I-129` (form, correctly kept) + `h1b-petition`, `h1b-filing` (**not** `i129-filing`) | — |
| "My employer just filed my I-129 petition" (**no visa type stated**) | `I-129` + `i129-filing` | — |
| "My employer filed my I-129 petition for TN status..." | `I-129` + `tn-renewal` (closest available TN tag — no `tn-petition` exists) | **`i129_filed_date`** (correctly, not `h1b_filed_date`) |
| "My company filed my L-1 intracompany transfer petition..." | `l1-petition` (L-1's own tag, no I-129 form tag forced) | — |

**Findings:**
- **Confirms §3's reasoning directly.** Whenever H-1B context is available
  (even alongside explicit "I-129" text), the model prefers the H-1B-specific
  action tag and date key over the generic I-129 one — same
  preference-for-specificity pattern the EAD analysis found, achieved with
  **zero code changes needed**, exactly like the EAD case.
- **Critically, for TN**, the model correctly used `i129_filed_date` (not
  `h1b_filed_date`) — direct proof `i129_filed_date` is still doing real,
  necessary work for non-H-1B I-129 filings, not sitting unused the way
  `i765-filing` was.
- `i129-filing` only appeared for the genuinely underspecified post — exactly
  the fallback role §3 predicted, not evidence of redundancy.
- `h1b-petition` and `h1b-filing` **co-occurred together** in both H-1B tests
  rather than being chosen as alternatives to each other — no evidence they're
  duplicates of *each other* either, despite their descriptions reading
  similarly at a glance (`h1b-petition`: "Petition filed by employer...";
  `h1b-filing`: "Act of filing the H-1B petition"). Worth a human read of
  both descriptions side by side if tightening the vocabulary is ever
  revisited, but no action recommended from this evidence alone.

## 5. Code-dependency comparison — another reason not to touch these

Unlike `i765_filed_date` (which had **zero** code/test/prompt references
before the EAD analysis), `h1b_filed_date` is deeply embedded:

| Reference | `h1b_filed_date` | `i129_filed_date` |
|---|---|---|
| `_MILESTONE_DATE_KEY` dict (`posting.py:1770`) | ✅ | — |
| Gemini onboarding prompt text (`profile.py:485,500,523,579`) | ✅ named explicitly | — |
| Website onboarding tests — used as the **canonical example** date_key | ✅ (`page.test.tsx:18`, `page.edge.test.tsx:19,72,77`) | — |
| Backend tests | ✅ (`test_profile.py:137-146`, `test_profile_edge.py:93,99,144,150`) | Only as one entry in a generic `filed_keys` completeness tuple (`test_profile.py:145`, **would break if removed**) |
| `seed_synthetic.py` example data | ✅ | — |
| Mobile onboarding milestone picker | ✅ (`h1b_filing` milestone maps to it) | — |

`h1b-petition` similarly has real functional dependency — it's the
**canonical worked example** throughout `_apply_visa_backfill()`'s docstring
and the process-tag→visa-code backfill mapping (`posting.py:665-681`), and is
covered by multiple `test_posting_tagging.py` cases (E8, E16d, E56, E62).
`i129-filing` also has a real, purposeful test
(`test_posting_tagging.py:238-243`, E12) verifying the backfill logic
correctly treats a bare form-number tag as *not* a visa code — removing it
would require rewriting that test, not just deleting a line.

## 6. Recommendation

**No tags should be removed or renamed.** Unlike the EAD/I-765 case:
- The apparent H-1B/I-129 "duplication" already resolves itself correctly
  today, confirmed live, with no vocabulary change needed.
- `i129-filing`/`i129-approval`/`i129-rfe`/`i129_filed_date` are load-bearing
  for TN and P-1, which have no visa-specific alternative.
- `i129-filing` has a real, purposeful regression test (E12) that would need
  rewriting, not just deleting, if it were removed.
- `h1b_filed_date` and `h1b-petition` are both far more deeply embedded in
  code/prompts/tests than their EAD-side counterparts ever were — much
  higher blast radius for a change that the live evidence doesn't even
  support making.

**If anything is worth a small follow-up** (optional, not urgent):
consider adding `tn-petition` and P-1-specific action tags (`p1-petition`,
`p1-extension`) for symmetry with H-1B/L-1/O-1's coverage — that would be
additive (fills a real gap) rather than removing anything, and is unrelated
to the redundancy question this doc was asked to answer.
