# STEM OPT timeline — unified capture (posting ⇄ timeline group)

**Branch:** `feature/stem-opt-processing`
**Status:** plan (approved direction: shared timeline card + bidirectional cross-link)
**Scope:** **STEM OPT only** — the `EAD → stem-opt-extension` timeline use case. Explicitly NOT a general timeline-capture change (see §10 Non-goals).

---

## 1. Goal

A STEM OPT applicant's filing timeline can be captured in two disconnected places today:

- **Free-text posting** (`/post`): a narrative that `tag-suggest` best-effort parses into `key_dates`/`key_stages`.
- **Timeline group** (`/find` → Timeline → **EAD** → **stem-opt-extension**): a structured cohort (`filing_month`+`filing_year`) plus per-member **post-join attributes**.

Both describe the **same** filing (Form I-765 → EAD for the 24-month STEM OPT extension) and write the **same vocabulary keys**, but through two different UIs with no bridge. This change unifies them:

1. **One shared "STEM OPT timeline card"** used in both flows.
2. On the posting side, the card is **auto-prefilled by parsing the free text**, then confirmed — capture once, keep the narrative.
3. **Bidirectional cross-link**: a STEM OPT posting offers to join/create its cohort; a cohort membership offers to publish a posting. No double entry.

## 2. Domain background (why the two are the same thing)

STEM OPT = the `stem-opt-extension` eligibility under the `EAD` processing type. An F-1 STEM graduate files **Form I-765** to receive an **EAD** authorizing employment during the 24-month extension. So "STEM OPT approved" in a posting and "EAD / stem-opt-extension, filed <month/year>" in the timeline form are the same real-world event. Confirmed against the curated corpus (`/Users/KW98T6E/Projects/krish/curated/stem/*.txt`), which are all I-765 STEM OPT approval timelines.

## 3. Current state (the two paths already share a schema)

| | Free-text posting (`/post`) | Timeline group (`/find`, EAD/stem-opt-extension) |
|---|---|---|
| Input | narrative prose | structured form |
| Parser | `posting.suggest_tags()` (Gemini) → `key_dates` (1.8) + `key_stages_or_info` (1.7) | none (manual) |
| Structured store | `key_dates`/`key_stages_or_info` on the posting | cohort key `filing_month`+`filing_year`; per-member **post_join attributes** |
| Reliability | variable extraction, user reviews in the composer | explicit, complete |
| Linkage | none | none |

The key finding: **both write the same keys**, and the Timeline group's `stem-opt-extension` post-join template in `backend/config/timeline_attributes.default.json` is already the canonical field list. The gap is UX + linkage, not schema.

## 4. Canonical STEM OPT timeline schema (single source of fields)

Taken verbatim from the `stem-opt-extension` config (period rows + `post_join_row_extras["stem-opt-extension"]`). This IS the timeline card; no new schema.

| Card field | vocab key | bucket | control | notes |
|---|---|---|---|---|
| Month / Year filed | `filing_month`, `filing_year` | `key_stages_or_info` | select / year | **cohort key**; can be derived from `ead_filed_date` |
| Date Applied | `ead_filed_date` | `key_dates` | date | required to bridge to a cohort |
| Status | `application_status` | `key_stages_or_info` | select (approved/pending/denied/RFE/NOID) | |
| Service Center | `service_center` | `key_stages_or_info` | select (PSC/SRC/LIN/VSC) | |
| Premium Processing | `premium_processing` | `key_stages_or_info` | checkbox | |
| Biometrics Requested | `biometrics_requested` | `key_stages_or_info` | checkbox | |
| Biometrics Completed | `biometrics_completed_date` | `key_dates` | date | |
| RFIE issued | `rfe_date` | `key_dates` | date | |
| NOID issued | `noid_issued` | `key_stages_or_info` | checkbox | |
| Date Approved | `ead_approved_date` | `key_dates` | date | |
| Card Produced / Received | `ead_card_produced_date`, `ead_card_received_date` | `key_dates` | date | optional tail |
| *(derived)* Total days | — | computed | `ead_approved_date − ead_filed_date` | display-only |

All keys already exist in `backend/tags-cleaned/1.7-key-stages.csv` and `1.8-key-dates.csv`, so `tag-suggest` can target them and `validate()` already accepts them. **No vocab or datastore schema change is required.**

## 5. The unified design

### 5.1 Shared component — "STEM OPT timeline card"
A single component that renders the canonical field set (§4). It is driven by the existing `stem-opt-extension` attribute template (so backend config stays the single source), and is rendered in **both** places:
- the posting composer (`/post`), and
- the Timeline join / attribute form (`/find` + `/groups/[id]`).

It always shows a **read-only derived summary** (e.g. "Filed Mar 2026 · approved in 190 days · no PP") so the structured data reads like a timeline, not a form.

### 5.2 Posting flow (free-text on-ramp)
1. User writes their STEM OPT experience as free text (natural narrative).
2. On **Preview**, `suggest_tags()` runs (as today) and, when it detects STEM OPT (`stem-opt-extension` / EAD signal), returns the timeline keys in `key_dates`/`key_stages_or_info`.
3. The **timeline card auto-appears, prefilled** with everything that parsed. Unparsed / low-confidence fields are **left blank and highlighted** for the user (never fabricated — §6).
4. User **confirms** (one tap when the parse is clean) or fills gaps.
5. Submit stores **both** the narrative (`description`) and the structured fields (`key_dates`/`key_stages_or_info`) — exactly the existing posting shape.
6. If `ead_filed_date` (or month/year) is present, offer **"Join / create your EAD · stem-opt cohort"** (→ §5.4).

### 5.3 Timeline-group flow
- The **same card** is the join/attribute form for `stem-opt-extension` (replacing the current row-by-row form for this category).
- Optional free-text on-ramp here too: a "paste your timeline" box → `suggest_tags()` → prefill the card, so the structured side gets the same low-friction entry.
- After joining, offer **"Share this as a posting"** (→ §5.4).

### 5.4 Bidirectional cross-link (both directions, per decision)
- **Posting → cohort:** derive `filing_month`/`filing_year` from `ead_filed_date`; deep-link into `/find?type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=..&filing_year=..` (the AI-Assist timeline deep-link already exists — extend it to derive month/year from the filed date). The user confirms before joining/creating (we don't silently join).
- **Cohort → posting:** prefill a posting draft from the member's stem-opt attributes (reusing the AI-Assist `assistDraft` handoff mechanism): a generated narrative skeleton + the structured card, which the user edits and publishes.

## 6. Handling partial / missing / ambiguous extraction

- **Best-effort, never fabricate.** The card is prefilled only with fields `suggest_tags()` returned; anything else stays blank and visibly "needs your input".
- **Partial is publishable.** A posting can be submitted with an incomplete timeline. Required-ness is **per-action, not per-post**: e.g. `ead_filed_date` is required only to *bridge to a cohort*, so we prompt for just that at the bridge step if it's missing — we never block the post itself.
- **Confidence + confirm.** Even a clean full parse gets a light "looks right? Confirm" — the escape hatch for an extraction slip. (We can later auto-attach on very-high-confidence parses; start with confirm.)
- **Source of truth = the confirmed card** (structured fields). The narrative is preserved verbatim but the structured fields are what feed search/cohorts.

## 7. Backend work

- `backend/posting.py` — `suggest_tags()` prompt: tighten STEM OPT extraction so the `stem-opt-extension` fields (§4) are reliably pulled from prose. The curated `stem/*.txt` are the golden fixtures. No new keys — just better recall/precision on existing ones.
- `backend/config/timeline_attributes.default.json` — remains the single source for the card's field set (read via `/api/tag-vocab`'s `post_join_attribute_templates` / `tag_attribute_templates`). Confirm the `stem-opt-extension` set matches the card table (§4); adjust labels/order only if needed.
- **Derive helper** — a small server-side (or shared client) helper: `ead_filed_date → {filing_month, filing_year}` for the cohort bridge. (`assist.resolve_timeline_criteria` already maps month/year → criteria; add the date→month/year derivation.)
- `backend/api.py` — no new posting endpoint needed (posting stores the structured fields already). The cross-link reuses existing `/api/groups/search|preview|join` + `/api/tag-suggest`.
- Tests: extend `test_posting_tagging` / `test_assist_timeline` with STEM OPT extraction + the date→cohort derivation, using the curated files as fixtures.

## 8. Frontend work

**Website**
- `components/StemOptTimelineCard.tsx` (new) — the shared card over the `stem-opt-extension` template + derived summary.
- `app/post/page.tsx` — after `tag-suggest`, when STEM OPT is detected, render the card (prefilled) in place of / alongside the generic `key_dates` rows; wire the "join your cohort" affordance.
- `app/find/page.tsx` + the timeline attribute form — render the same card for `stem-opt-extension`; add the optional "paste your timeline" on-ramp.
- `components/AiAssist.tsx` / `lib/assistDraft.ts` — the cohort↔posting handoffs (extend the existing timeline deep-link + draft handoff; no new mechanism).

**Mobile** (parity, second)
- `src/screens/PostScreen.tsx`, `src/screens/FindScreen.tsx` + the attribute form (`GroupChatScreen`/`GroupAttributes`) — the RN card; reuse `apiService` tag-suggest + groups calls and the existing deep-link params already added on `feature/sync-mobile`.

## 9. Phased implementation

1. **Schema lock + extraction** (backend): confirm the canonical field set; tighten `suggest_tags()` STEM OPT extraction; add the `ead_filed_date → month/year` derivation; tests against `curated/stem/*.txt`.
2. **Shared card (website)**: build `StemOptTimelineCard`; render in `/post` (prefilled) and the Timeline attribute form; derived summary.
3. **Cross-link (website)**: posting → cohort deep-link (from filed date); cohort → posting draft.
4. **Mobile parity**: card + both flows on RN.
5. **Polish + tests**: partial-parse UX, confirm step, e2e, curated-fixtures regression.

## 10. Non-goals / scope boundaries

- **STEM OPT only.** No change to other EAD categories (h4-ead, AOS/(c)(9), …) or H-1B application types. The card is deliberately built for `stem-opt-extension`; generalizing to other processing types is a **separate, later** effort once this proves out.
- No new vocab keys, no datastore/schema migration — reuse the existing `key_dates`/`key_stages_or_info` + the `stem-opt-extension` config.
- No silent/auto joining of cohorts or auto-publishing — every bridge action is user-confirmed.
- Curated/offline publishing (`curated/publish.sh`) is out of scope for the UI card; it can adopt the same structured keys later so seeded STEM postings populate cohorts.

## 11. Open questions / decisions

- **Generalization boundary (confirmed):** STEM OPT only for now — noted as a non-goal, built so the pattern *can* extend later.
- **Confirm vs auto-attach on a clean parse:** start with a light confirm; revisit auto-attach on high confidence.
- **Cohort bridge granularity:** derive month/year from `ead_filed_date`; **confirm before join/create** (do not silently join).
- **Curated path:** UI-only first; teach `publish.sh`/curation to emit the structured timeline fields in a later pass.
- **Platforms:** website first, then mobile parity.

## 12. Risks

- **Extraction quality** — partial/incorrect parses. Mitigated by the always-editable prefilled card + the curated golden fixtures + never-fabricate rule.
- **Two-surface drift** — the card must render from the single config so `/post` and `/find` never diverge.
- **Scope creep** — resist generalizing mid-build; STEM OPT is the deliberate, contained slice.
