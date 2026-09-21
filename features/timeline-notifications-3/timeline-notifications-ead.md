## Timeline and Notifications Enhancements

## Overview
Evaluate and capture STEM OPT processing data attributes correctly with no redundancy. 
Processing Type: Initial POST‑COMPLETION OPT / STEM OPT EXTENSION

The  basic data attributes for this USCIS processing are:
Premium Processing: YES / NO
Date Applied: MM/DD/YYYY
Request for Initial Evidence (RFIE) MM/DD/YYYY (if applicable)
Biometrics Requested: YES/NO | MM/DD/YYYY (if applicable)
Biometrics Completed: MM/DD/YYYY
Notice of Intent to Deny (NOID): YES/NO | MM/DD/YYYY (if applicable)
Date Approved: MM/DD/YYYY
Date Card Produced: MM/DD/YYYY
Date Card Received: MM/DD/YYYY

## Task
1. Evaluate the right tag names for above data attributes
2. Evaluate if there are any duplicate tags for this. For example: `i765-filing` and `ead-filing`
3. Remove redundancy after impact analysis

---

> **STATUS: Redundancy fix (§3) IMPLEMENTED.** `i765-filing`/`i765-approval`
> retired from `1.6-visa-form-actions.csv`; `i765_filed_date` renamed to
> `ead_filed_date` in `1.8-key-dates.csv` with `posting.py`'s
> `_MILESTONE_DATE_KEY` updated in lockstep. Live-data check confirmed zero
> published usage of any of the three before removal (same methodology as
> the `b28ab53` POE precedent). Full backend/mobile test suites green.
> **§5's open questions (RFIE, Card Produced/Received, NOID, Premium
> Processing, naming convention, dual-key normalization) are still
> unanswered and §6/§7's proposed new attribute tags have NOT been
> implemented** — this status update covers only the redundancy-removal
> task (Task items 2-3), not the full attribute-tracking feature.

---

## 1. Current state — tag inventory per attribute

Source of truth: `backend/tags-cleaned/1.7-key-stages.csv` (`key_stages_or_info`
keys) and `1.8-key-dates.csv` (`key_dates` keys), cross-checked against
`1.3-abbreviations.csv`, `1.5-forms.csv`, `1.6-visa-form-actions.csv`,
`1.9-outcomes.csv`.

| Attribute | Existing tag(s) | Status |
|---|---|---|
| **Premium Processing: YES/NO** | `premium-processing`, `regular-processing`, `pp-clock` (1.10, topic tags); `I-907` (1.5, the actual USCIS form for requesting it) | ⚠️ Topic-level only — no structured `key_stages_or_info` boolean/status field exists. Presence of the topic tag doesn't currently encode yes/no as a queryable attribute. |
| **Date Applied** | `i765_filed_date` (1.8) | ✅ Exists — generic to Form I-765 (STEM OPT extensions are filed on I-765, so this is the correct field), not STEM-OPT-labeled specifically. |
| **Request for Initial Evidence (RFIE)** | **No exact match.** What exists: `RFE` (Request for **Evidence** — 1.3 abbreviation, 1.9 outcome), `rfe_date`/`rfe_response_date` (1.8), `rfe_status` (1.7), plus form-specific action tags `h1b-rfe`/`i129-rfe`/`i485-rfe` (1.6, **no `i765-rfe`/`ead-rfe` exists**) | ❓ **Open question, see §5** — "RFIE" is not standard USCIS terminology as far as this vocabulary or general USCIS documentation uses it; the only close match is the standard `RFE` (Request for Evidence). Need to confirm with requirements owner whether "RFIE" means RFE, or is a deliberately distinct concept (some services do distinguish an initial-evidence request from a later evidence request) before choosing a tag. |
| **Biometrics Requested: YES/NO \| Date** | `biometrics_appointment_date` (1.8), `biometrics_status` (1.7), `biometrics` (1.10, topic) | ✅ Well covered for the date + status. No literal YES/NO boolean field — "requested" would currently be inferred from `biometrics_appointment_date` being set, or `biometrics_status` having a value. |
| **Biometrics Completed: Date** | `biometrics_completed_date` (1.8) | ✅ Exists, exact match. |
| **Notice of Intent to Deny (NOID): YES/NO \| Date** | `NOID` (1.3 abbreviation **and** 1.9 outcome) | ⚠️ Status exists (`application_status`/`outcome_status` = `NOID`), but **no date tag** — nothing like `noid_date`/`noid_issued_date` in 1.8. Same shape of gap as "Date Denied" below. |
| **Date Approved** | `ead_approved_date` (1.8) | ✅ Exists. |
| **Date Denied** *(implied by "Date Approved" pairing, not in the original list but flagged in the earlier evaluation)* | **None.** | ❌ Gap. Denial as a *status* is captured via `application_status`/`outcome_status` = `denied` (1.9), but there is no field for *when*. |
| **Date Card Produced** | **None.** | ❌ Gap. Nothing represents USCIS's standard "Card Is Being Produced" case-tracker milestone anywhere in the vocabulary. |
| **Date Card Received** | `green_card_received_date` (1.8) exists but is **hardcoded to the Green Card**, not EAD | ❌ Gap for EAD/STEM-OPT specifically — no `ead_received_date`/generic "card received" tag exists. |
| **Service Center / Location** | `service_center_assigned` (1.7) | ✅ Exists, exact match ("USCIS Service Center assigned for processing"). |

## 2. Where "STEM OPT" / "I-765" / "EAD" show up as tags (background)

These are the broader topic/action tags this attribute set sits inside of —
none of them are the specific date/stage keys in §1 above, they're coarser
labels:

- `stem-opt-extension` (`1.6-visa-form-actions.csv`) — content/topic tag ("this posting is about a STEM OPT extension")
- `stem-opt` (`1.10-common-misc.csv`) — misc/status tag
- `stem_opt` (`backend/profile.py:198`, `MILESTONES` list) — a **free-text journey milestone label**, explicitly documented as "NOT controlled tags, and NEVER drives current-state fields" (`profile.py:187-189`)
- `I-765` (`1.5-forms.csv`) — the form number itself, used as the KEY in the `key_stages_or_info: {form: outcome}` pattern (e.g. `{"I-765": "approved"}`)
- `EAD` (`1.3-abbreviations.csv`) — the document/benefit name

## 3. The i765-vs-ead duplicate-tag question (Task item 2)

Not all "i765" tags are the same kind of thing — three categories, three different risk profiles:

| Tag | Role | Redundant with EAD? | Code dependency |
|---|---|---|---|
| `I-765` (1.5) | The **form number** | **No — structurally different**, not a naming choice. Every other 1.5 entry is a form number, never a benefit name; collapsing this into "EAD" would break the `{form: outcome}` pattern the onboarding prompt relies on (`profile.py:475`). | Onboarding prompt's `key_stages_or_info` pattern |
| `i765-filing`, `i765-approval` (1.6) | General action/topic tags | **Yes, genuinely redundant** with `ead-filing`/`ead-renewal` (1.6) | **None found in code** — zero references outside the CSVs |
| `i765_filed_date` (1.8) | A `key_dates` key | **This is the real inconsistency** — `ead_approved_date` and `ead_expire_date` already say "ead"; only the filed-date says "i765" for the same document's lifecycle | **Real dependency**: hardcoded in `backend/posting.py:1772`'s `_MILESTONE_DATE_KEY` dict (`"opt_application": "i765_filed_date"`) |

**Recommendation for this piece:**
1. Keep `I-765` (1.5) as-is — not redundant, don't touch.
2. Retire `i765-filing`/`i765-approval` (1.6) — see live-verification results in §4, this is low-risk.
3. Rename `i765_filed_date` → `ead_filed_date` in 1.8, updating `posting.py:1772`'s dict value at the same time — this is the change that actually fixes the naming inconsistency.

### Precedent already in this codebase for exactly this kind of change
Commit `b28ab53` retired a duplicate `port-of-entry` tag in favor of the
already-in-use `POE`. Its process, which should be repeated here:
1. **Confirm actual live-data usage first** (they checked a real published
   posting to see which of the two tags was actually in use before deciding
   which to retire) — **not yet done for i765/ead**, see §5.
2. Reword any other tag's *description* text that still name-drops the
   retired string, so the tagging prompt doesn't keep pointing at it.
3. Update `mobile/src/constants/onboardingData.ts` in lockstep (it hardcodes
   its own picker/autocomplete lists rather than fetching them dynamically).
   Website didn't need a change last time — its tag list is served
   dynamically from the backend vocab.
4. No backfill of already-published documents was needed last time *because*
   step 1 confirmed there was nothing live to migrate. If step 1 turns up
   existing `i765_filed_date`/`i765-filing`/`i765-approval` usage on
   already-published data this time, a backfill would be needed (same shape
   as the `news-update` tag-leak correction documented in
   `docs/ingestion/IMMIHELP-SEED-PLAN.md` §8).

## 4. Live verification — does removing `i765-filing` actually work?

Ran the real Gemini tagging pipeline (`backend/posting.py`'s `_extract()`)
against synthetic posts, with `i765-filing`/`i765-approval` filtered out of
the in-memory vocabulary to simulate the post-change state (no CSV files
were touched; no data was published — this was a read-only test).

| Test post | Baseline (i765-filing available) | Simulated (i765-filing removed) |
|---|---|---|
| "I just submitted my I-765 to USCIS today..." | `ead-filing` selected (i765-filing was available but **not** chosen) | `ead-filing` selected — identical result |
| "Got the approval notice for my I-765..." | `EAD` + `approved` selected (decomposed, no combined action tag used) | Same — `EAD` + `approved` |
| "Filed my STEM OPT extension (I-765)..." | `opt-extension` selected (more specific tag correctly preferred over any generic I-765/EAD action tag) | Same |

**Findings:**
- Confirms the auto-translation works: Gemini reads only the *bare tag name*
  for 1.3/1.5/1.6/1.9 tags (`_master_tags_block()`, `posting.py:451` — labeled
  "self-explanatory," no description or cross-reference text is sent to the
  model for this bucket), so this relies entirely on the model's own general
  knowledge that I-765 = EAD, not on any vocabulary metadata. Same mechanism
  already validated by the POE precedent.
- **Stronger than expected**: even in the *baseline* run, with `i765-filing`
  fully available, the model never chose it — it picked `ead-filing` anyway.
  This is leading evidence (not proof) that `i765-filing` may already have
  near-zero real usage in already-published content — reinforcing why §5's
  live-data check matters before removing anything.
- The model never reaches for a combined "approval" action tag at all for
  EAD approvals — it decomposes into `EAD` (abbreviation) + `approved`
  (outcome) instead. This means **adding a new `ead-approval` tag to replace
  `i765-approval` may not be necessary** — the existing decomposition already
  covers it. Worth deciding explicitly rather than assuming a 1:1
  replacement tag is needed (see §5 open questions).

### 4a. Reverse direction — does "EAD" language also tag the `I-765` form?

Tested the opposite case: posts that say "EAD" and never mention "I-765" or
the numeral 765 anywhere. **This is a pre-existing behavior of the current
system, independent of the i765/ead consolidation above** — tested against
today's vocab, unmodified.

| Text says... | `I-765` tag applied? | `key_dates` captured correctly? | `key_stages_or_info` key used |
|---|---|---|---|
| "I-765" explicitly | ✅ Yes | ✅ `i765_filed_date` | `"I-765"` |
| "EAD" only (filing) | ❌ No | ✅ `i765_filed_date` (correct value, right field) | `"EAD"` |
| "EAD" only (approval) | ❌ No | ✅ `ead_approved_date` (correct value, right field) | `"EAD"` |

**Findings:**
- **Asymmetric.** I-765 language reliably produces `ead-*` action tags (§4
  above), but EAD language does **not** reliably produce the `I-765` form
  tag back. One direction works, the other doesn't.
- **The actual dates are unaffected either way** — `key_dates` lands in the
  correct field (`i765_filed_date`/`ead_approved_date`) with the correct
  value regardless of which term the user used. This is the part that
  matters most for the Date Applied/Approved tracking this feature is
  actually about, and it's solid.
- **The real gotcha, for implementation:** `key_stages_or_info` uses
  *whichever term appeared in the text* as its key — `"EAD"` (a valid 1.3
  abbreviation key) for EAD-only posts, `"I-765"` (a valid 1.5 form key) for
  I-765-mentioning posts. The model isn't doing anything invalid (both are
  legitimate `key_stages_or_info` keys per `profile_stage_keys` = 1.7+1.5+1.1+1.3),
  it's just not normalizing to one canonical key. **Any code that reads
  `key_stages_or_info` to determine EAD/I-765 status must check both
  `"I-765"` and `"EAD"` as possible keys** — checking only one will silently
  miss roughly half of real content, split by which word the person happened
  to use. This is exactly the kind of thing that causes "the date shows up
  sometimes and I don't know why" bugs if missed during implementation.

## 5. Open questions for the requirements owner (please answer before implementation starts)

1. **"RFIE"** — is this meant to be the standard `RFE` (Request for
   Evidence), or a deliberately distinct concept from RFE? If distinct, what
   differentiates it, and should it get its own tag family (abbreviation +
   date + status), or reuse RFE's?
2. **Date Denied** — not in the original attribute list but a natural pair
   to "Date Approved." Should this be added as a new `1.8` key (e.g.
   `ead_denied_date`)? Same question for **NOID date** (e.g. `noid_date`).
3. **Card Produced / Card Received** — these are the two attributes with
   zero existing representation. Proposed names for discussion:
   `ead_card_produced_date`, `ead_card_received_date` — naming open for
   input. Should "Card Received" be EAD-specific, or should this doc also
   propose fixing `green_card_received_date` to be less green-card-specific
   (bigger, separate change — flagging, not recommending)?
4. **Premium Processing / Biometrics Requested / NOID as YES/NO** — do these
   need to become real structured fields (new `1.7` key_stages keys with a
   boolean-ish value domain), or is "the date field is populated" an
   acceptable proxy for "yes," with no explicit boolean needed?
5. **`i765-approval` replacement** — per §4's finding, confirm whether a new
   `ead-approval` tag should be added at all, or whether relying on the
   existing `EAD` + `approved` decomposition is the preferred path.
6. **Live-data check** — who/how should this be run before any tag is
   retired? (Needs Firestore/Discovery Engine query access this environment
   doesn't currently have configured — see precedent's step 1 in §3.)
7. **Naming convention** — should all new date keys use an `ead_` prefix
   uniformly (matching `ead_approved_date`/`ead_expire_date`), or should some
   stay STEM-OPT-specific (e.g. `stem_opt_filed_date`) given STEM OPT is one
   of several I-765 use cases (initial OPT, STEM OPT extension, H-4/L-2 EAD
   all file the same form)? This affects whether the new fields are
   EAD-generic or STEM-OPT-specific — worth deciding explicitly since it
   changes several of the proposed names above.
8. **`key_stages_or_info` dual-key normalization** (per §4a) — should the
   extraction/publish pipeline normalize `"EAD"`/`"I-765"` down to one
   canonical `key_stages_or_info` key at write time (so downstream readers
   only ever check one key), or should the timeline/notifications feature's
   read-side logic simply check both keys? Normalizing at write time is more
   work now but removes the "check both keys everywhere" burden from every
   future consumer; leaving it to read-side logic is cheaper now but is the
   kind of implicit assumption that's easy to forget in a second or third
   consumer later.

## 6. Final tag list — proposed `key_stages`/`key_dates` keys per attribute

One row per attribute from the Overview. **"New"** rows are proposals, not
yet added to `tags-cleaned/`. Where an open question from §5 affects the
name, the default assumed here is stated explicitly — flag if you want a
different call.

| Attribute | Key type | Key name | New / Existing | Notes |
|---|---|---|---|---|
| Premium Processing: YES/NO | — | *(none — see note)* | n/a | No `key_stages`/`key_dates` key proposed. The existing `premium-processing` **topic tag** (`tags`, 1.10) already signals yes/no by presence/absence; a boolean doesn't need its own structured key unless a **date** is later required (e.g. "date premium processing requested"), which wasn't asked for. |
| Date Applied | `key_dates` | `ead_filed_date` | **Renamed** from existing `i765_filed_date` | Per §3's recommendation — closes the naming inconsistency with `ead_approved_date`/`ead_expire_date`. Requires updating `posting.py:1772`'s `_MILESTONE_DATE_KEY` dict value in lockstep. |
| Date Applied (status pairing) | `key_stages_or_info` | `"I-765"` or `"EAD"` → `"filed"` | Existing (dual-key, §4a) | Both keys are valid today; §5 item 8 asks whether to normalize to one. Default assumed here: **no normalization yet**, read-side must check both. |
| Request for Initial Evidence (RFIE) | `key_dates` | `rfe_date`, `rfe_response_date` | Existing | **Assumes RFIE = standard RFE** (§5 item 1, unconfirmed) — flag if this is a distinct concept. |
| RFIE (status pairing) | `key_stages_or_info` | `rfe_status` | Existing | Value domain: 1.9 outcomes. |
| RFIE (form-specific gap) | `tags` | *(none — gap)* | — | `h1b-rfe`/`i129-rfe`/`i485-rfe` exist (1.6) but **no `ead-rfe`/`i765-rfe` equivalent**. Only relevant if form-specific RFE tracking (not just the generic date/status) is wanted. |
| Biometrics Requested: YES/NO \| Date | `key_dates` | `biometrics_appointment_date` | Existing | An appointment being scheduled is the "requested" signal — no separate boolean key proposed. |
| Biometrics Requested (status pairing) | `key_stages_or_info` | `biometrics_status` | Existing | |
| Biometrics Completed: Date | `key_dates` | `biometrics_completed_date` | Existing | Exact match, no change. |
| Notice of Intent to Deny (NOID): YES/NO | `key_stages_or_info` | `application_status` / `outcome_status` → `"NOID"` | Existing | `NOID` is both a 1.3 abbreviation and a valid 1.9 outcome value already. |
| NOID: Date | `key_dates` | `noid_date` | **New** | Proposed **generic** (not `ead_`-prefixed) — NOID applies across many form types (I-485, I-140, etc. can also get one), matching the existing generic pattern of `rfe_date` rather than the form-specific pattern of `*_approved_date`. |
| Date Approved | `key_dates` | `ead_approved_date` | Existing | Exact match, no change. |
| Date Denied *(implied pairing, not in original list)* | `key_dates` | `ead_denied_date` | **New** | Proposed EAD-specific (unlike `noid_date`/`rfe_date`) — matches the existing pattern where *approval* dates are form/benefit-specific (`h1b_approved_date`, `i140_approved_date`, `ead_approved_date`, ...), so its denial counterpart follows the same shape. |
| Date Card Produced | `key_dates` | `ead_card_produced_date` | **New** | No existing equivalent anywhere (confirmed gap, §1). |
| Date Card Received | `key_dates` | `ead_card_received_date` | **New** | Distinct from the existing `green_card_received_date`, which stays green-card-specific and is untouched. |
| Service Center / Location | `key_stages_or_info` | `service_center_assigned` | Existing | Exact match, no change. |

**Not proposing new `key_stages_or_info` status keys for Card Produced/Card
Received** (e.g. an `ead_card_status`) — matches how most existing `1.8`
date-only milestones work today (e.g. `slot_booked_date`, `i797a_receipt_date`
have no paired `1.7` status key); presence of the date is the status signal,
consistent with the majority pattern already in the vocab.

**Net new tags this list proposes:** `noid_date`, `ead_denied_date`,
`ead_card_produced_date`, `ead_card_received_date` (all `1.8`), plus the
`i765_filed_date` → `ead_filed_date` rename. Everything else reuses an
existing tag as-is. All four new tags and the rename are still contingent on
§5's open questions being answered — this table states the assumed default
for each so there's a concrete starting point to react to.

## 7. Final summary — Business Attribute → Tag

One row per business attribute, both pre-existing and newly proposed tags
included. `(new)` marks a tag that doesn't exist in `tags-cleaned/` yet and
is still pending confirmation per §5.

| Business Attribute Name | Corresponding tag name |
|---|---|
| Premium Processing (YES/NO) | `premium-processing` (`tags`, 1.10) |
| Date Applied | `ead_filed_date` (`key_dates` — renamed from `i765_filed_date`); `key_stages_or_info["I-765"` or `"EAD"] = "filed"` |
| Request for Initial Evidence (RFIE) — *assumes RFIE = standard RFE, §5 item 1* | `rfe_date` (`key_dates`); `rfe_status` (`key_stages_or_info`) |
| Biometrics Requested (YES/NO / Date) | `biometrics_appointment_date` (`key_dates`); `biometrics_status` (`key_stages_or_info`) |
| Biometrics Completed (Date) | `biometrics_completed_date` (`key_dates`) |
| Notice of Intent to Deny — NOID (YES/NO) | `application_status` / `outcome_status` = `"NOID"` (`key_stages_or_info`) |
| Notice of Intent to Deny — NOID (Date) | `noid_date` (`key_dates`) — **(new)** |
| Date Approved | `ead_approved_date` (`key_dates`) |
| Date Denied *(implied pairing, not in original list)* | `ead_denied_date` (`key_dates`) — **(new)** |
| Date Card Produced | `ead_card_produced_date` (`key_dates`) — **(new)** |
| Date Card Received | `ead_card_received_date` (`key_dates`) — **(new)** |
| Service Center / Location | `service_center_assigned` (`key_stages_or_info`) |