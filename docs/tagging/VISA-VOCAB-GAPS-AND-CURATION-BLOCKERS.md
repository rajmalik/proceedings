# Visa-vocab gaps and curation blockers — found via the 072826 batch

**Status:** Category A resolved and published. Generic-category fallback (proposed as a Category-C mitigation) is now **implemented** — see below. Categories B/C/D otherwise documented with proposed next steps, not yet resolved.
**Context:** A 37-file manual-curation batch (`~/curated/072826/`) run through `tag-suggest-batch.sh` → `publish-batch.sh` had 17 failures, all `"Posting failed validation: Capture a visa/status in 'Current status' or 'Visa applying for' before submitting"`. Investigated each individually against the source text and `tags-cleaned/1.1`/`1.2`/`1.6` vocab, then triaged into four categories by how confidently each could be resolved. This doc is the writeup.

| Category | Meaning | Count |
|---|---|---|
| **A** | Confidently fixable — clear evidence in the text (or a real code bug) | 2 |
| **B** | Probably fixable — a likely answer exists, but worth confirming before publishing | 2 |
| **C** | Needs a human's judgment — text genuinely doesn't specify enough | 9 |
| **D** | Real vocabulary gap — no valid code exists at all, regardless of wording | 4 |

---

## Category A — fixed and published

### A1. `congressional-inquiry.txt`
US citizen applying for I-130 + I-485 concurrently, text explicitly says **"my wife"** → unambiguously `IR-1` (Immediate Relative - Spouse of U.S. Citizen). Manually patched `visa_applying_for: ["IR-1"]` into the reviewed `.tags.json`, republished.
**Published as `app-2026-07-28-f1376cc4`.**

### A2. `travels-ggestion.txt`
Turned out not to be a tagging issue at all. The file was 2 lines (title + content, no blank separator line), but every curation script (`tag-suggest.sh`, `publish.sh`, `-batch` variants) assumes `title \n blank \n description...` and reads the description via `tail -n +3`. With no line 3+, the description sent to `/api/tag-suggest` came back empty, and the `422 string_too_short` error response got written into `travels-ggestion.tags.json` in place of a real tags draft — indistinguishable from an ordinary "empty visa fields" failure without actually opening the file and checking for a `groups` key.

Fixed by inserting the missing blank line 2 (content itself left byte-for-byte unchanged). Re-ran `tag-suggest.sh`, which this time correctly derived `current_visa_or_greencard_category: ["F-1"]` directly from context ("recent graduate... Initial OPT EAD card" — OPT is an F-1-only benefit) — no code fix was even needed for this specific file.
**Published as `app-2026-07-28-aed6f2ad`.**

**Follow-up worth doing:** audit the rest of this batch (and future batches) for the same 2-line-file shape before assuming every failure is a vocab issue — `awk 'NR==2{if($0!="")print FILENAME}' *.txt` catches it in one pass, since every correctly-formatted file has an empty line 2.

### A3. Code fix found along the way — `_derive_visa_from_tags()`'s over-strict "/" handling
While confirming A2 didn't need it, found a real, separate bug worth fixing regardless: the deterministic backfill that infers `visa_applying_for` from a process tag (e.g. `h1b-petition` → `H-1B`) refused to touch *any* 1.6 mapping containing `/`, to avoid guessing at genuinely ambiguous change-of-status pairs (`l1-to-h1b` → `"L-1 / H-1B"`, both sides real visa codes). But `opt-application`/`opt-extension`/`stem-opt-extension`/`cpt-application` all map to `"OPT / F-1"` / `"CPT / F-1"` — and `"OPT"`/`"CPT"` are benefit names, never selectable vocab codes, so there was never any real ambiguity there.

**Fix:** only treat a `/`-joined mapping as ambiguous when *more than one* side is itself a valid `1.1`/`1.2` code (`posting.py`, `_derive_visa_from_tags()`). Verified this doesn't change behavior for any genuinely ambiguous mapping (`l1-to-h1b`, `f1-to-h1b`, `h1b-to-f1`, `f1-to-h4`, `j1-to-h1b`, `h1b-to-l1`, `b1b2-to-h1b` — all still correctly skipped, including the 3-way `"B-1/B-2 / H-1B"` case) or any fully-unmappable one (`aos-filing`, `ead-filing`, `ap-filing` — neither side is a real vocab code, still correctly skipped). Bonus: also fixes `niw-petition` (`"NIW / EB-2"` → `EB-2`), same reasoning.

Tests: `test_posting_tagging.py` E12a–E12d. 96/96 passing. Committed to `build-release-1.1` (`d3b8f77`).

---

## Casing convention in 1.2 (2026-08-06)

`1.2-greencard-categories.csv` was uniformly uppercase, which put the three
multi-word *generic* codes in the same visual class as the real category codes.
They are now lowercase-kebab:

| was | is |
|---|---|
| `ADJUSTMENT-OF-STATUS` | `adjustment-of-status` |
| `FAMILY-IMMIGRATION` | `family-immigration` |
| `EMPLOYMENT-IMMIGRATION` | `employment-immigration` |

**The rule, now that 1.2 has one:** UPPERCASE is reserved for an actual code or
abbreviation — `EB-2`, `IR-1`, `DV`, `SB-1`, `F1-FAMILY`, `SIV`. Anything that
is a descriptive phrase rather than a code is lowercase-kebab, matching 1.6
(`stem-opt-extension`) and 1.10 (`humanitarian-parole`). Prompted by the
eligibility dropdown, which draws from five vocabularies at once (1.1, 1.2,
1.3, 1.6, 1.10) and so surfaces any inconsistency between them.

No data migration was needed: a live check found zero Firestore groups, zero
profiles and zero indexed postings carrying any of the three old codes.
`backend/scripts/rename_generic_category_codes.py` exists for the case where
one appears between this change and a deploy.

## Generic-category fallback — implemented

Prompted by Category C containing files like `dont-know-what-to-think.txt` (I-485 pending, `employment-based-immigration` tag present, but no EB level stated) — cases where the text clearly signals the *broad* immigration path but not the *specific* code — added two last-resort fallback vocab codes and a deterministic backfill that fills them in only when nothing more specific is derivable, so `validate()` no longer flatly rejects these.

**Vocab (`backend/tags-cleaned/1.2-greencard-categories.csv`):**
- `family-immigration` — "Family-Based - Unspecified Category"
- `employment-immigration` — "Employment-Based - Unspecified Category"

Both are documented in-CSV as last-resort-only — a specific code (`IR-1`, `EB-2`, etc.) should always be preferred when the text supports one.

**Backend (`backend/posting.py`):**
- `_apply_visa_backfill(groups)` runs the full backfill order: (1) `_derive_visa_from_tags()` — specific, from an unambiguous 1.6 process tag; (2) the new generic fallback — only if step 1 found nothing AND both `visa_applying_for` and `current_visa_or_greencard_category` are still empty, keyed off the presence of the `family-based-immigration`/`employment-based-immigration` tag (the same tag `_I130_TAGS` already adds for bare I-130 mentions).
- Ordering fix: the `_I130_TAGS` → `family-based-immigration` tag-add now runs *before* `_apply_visa_backfill()` in both `suggest_tags()` and `build_canonical()` (previously backfill ran first, which would have missed a same-pass tag add).
- Never overrides an already-populated `visa_applying_for`/`current_visa_or_greencard_category` — purely a last-resort fill for otherwise-empty fields.
- Prompt guardrail added to `_SYSTEM_PROMPT` (and `docs/tagging/LLM-EXTRACTION-PROMPT.md`) warning the model against reaching for these codes when a specific one is supportable.

**Tests:** `test_posting_tagging.py` E14/E15 updated (behavior intentionally changed — bare I-130 content now resolves to `family-immigration` and passes `validate()`), plus new E16a–E16m covering isolated triggers, the real `dont-know-what-to-think.txt` shape, specific-wins-over-generic, no-signal-stays-empty, never-overrides-populated-fields, end-to-end via `build_canonical()`, and the exact call-order fix. Full suite: 109/109 passing.

**Live-user UX (website `src/app/post/page.tsx`, mobile `PostScreen.tsx`):** this backfill exists for manual curation, where there's no original poster to ask for the missing specifics. A live app user is right there, so a generic-only code must **not** be enough to enable Submit — the UI should push them for the exact category instead:
- `hasVisa` now requires at least one *specific* (non-fallback) code in either visa field — a generic-only result is treated the same as no result.
- When the only signal is a generic code, a distinct message replaces the original "Add at least one visa/status" warning: *"We could tell this is family/employment-based, but need the exact category — please add the specific one below (e.g. IR-1, EB-2) if you know it."*
- The generic code is still shown as a normal removable chip (not hidden) — the user can replace it with a specific one or add one alongside it, and Submit re-enables the moment a specific code is present.
- Live-verified end-to-end in a real browser against a real Gemini call: narrative I-130/I-485 content → backend derived `family-immigration` → page showed the new message, `Submit posting` disabled → removed the generic chip, added `IR-1` → message cleared, Submit enabled.
- Website: `src/app/post/__tests__/page.test.tsx` — 5 new tests (generic-only per code, specific-alongside-or-instead, no-signal-shows-original-message, unrelated specific-code-still-works). Full website suite: 82/82 passing.
- Mobile: same `hasVisa`/message logic mirrored in `PostScreen.tsx` (Alert copy + inline warning text); no existing test file for this screen, so no automated coverage added there yet — a known gap, not yet addressed.

**Scope note:** this only covers the family/employment ambiguity shape. It does not touch Category B (citizen-vs-LPR petitioner), the rest of Category C (files with no derivable signal at all), or Category D (asylum/naturalization — no vocab exists yet for either, so no fallback is possible until that's added).

---

## Category B — probably fixable, confirm before publishing

Both hinge on the same open question: whether the petitioning spouse is a **U.S. citizen** (`IR-1`, no annual limit) or a **green-card holder** (`F2A-FAMILY`, subject to the family-preference backlog) — a materially different answer for the reader, so worth confirming rather than assuming.

| File | Likely code | Why not certain |
|---|---|---|
| `i130.txt` | `IR-1` | "the attorney told my husband..." implies a spousal case, but citizen-vs-LPR petitioner status is never stated |
| `i751-eveidence.txt` | `IR-1` | I-751 (remove conditions) implies a prior marriage-based conditional green card, same citizen-vs-LPR ambiguity |

**Proposed next step:** confirm which applies (do you know from the original source thread?), then patch `visa_applying_for: ["IR-1"]` (or `["F2A-FAMILY"]`) into each `.tags.json` and publish — identical mechanism to A1, no code change needed. I can do this the moment either is confirmed.

---

## Category C — needs a human's judgment, no probable answer

No vocab gap — a real code exists for each of these — but the source text itself doesn't specify enough to pick the right one confidently. Guessing risks publishing incorrect legal-category data.

| File | What's missing |
|---|---|
| `changed-my-mind.txt` | "overstayed my visa" — visa type never named anywhere in the text |
| `different-name-ssn-gc.txt` | AOS approved, but the underlying petition basis (family/employment/other) isn't stated |
| `dont-know-what-to-think.txt` | I-485 pending, `employment-based-immigration` tag present, but no EB-1/2/3/4/5 level stated |
| `duplicate-status-updates.txt` | No visa/case-type information at all |
| `i130-approval.txt` | A *general discussion question* ("for those who filed 130 and 485...") with no personal relationship stated — could be spouse, parent, child, or sibling |
| `i539-approved.txt` | I-539 (extend/change nonimmigrant status) approved, but the underlying nonimmigrant category (F-1? H-4? B-2?) isn't named |
| `traffic-ticket.txt` | I-485 pending, concerned about a traffic misdemeanor affecting the green card — underlying category (family/employment/other) never stated |
| `uscis-reps.txt` | I-765/EAD delay — underlying status basis for the EAD not stated |
| `usps-ead-delivery.txt` | EAD delivery issue — underlying status basis not stated |

**Proposed next step:** for each, either (a) you supply the missing detail from context you have (the original source thread, if any) and I patch + publish, or (b) they stay unpublished — there's no safe deterministic way to fill these in.

**Update:** 2 of these 9 now auto-resolve via the generic-category fallback below, since they already carry a bare `family-based-immigration`/`employment-based-immigration` tag with no specific code: `dont-know-what-to-think.txt` → `employment-immigration`, `i130-approval.txt` → `family-immigration`. Both now pass `validate()` instead of blocking outright. The other 7 (`changed-my-mind.txt`, `different-name-ssn-gc.txt`, `duplicate-status-updates.txt`, `i539-approved.txt`, `traffic-ticket.txt`, `uscis-reps.txt`, `usps-ead-delivery.txt`) have no derivable family/employment signal at all and remain blocked pending human input.

---

## Category D — real vocabulary gap, no valid code exists

Checked `1.1-non-immigration-visas.csv` and `1.2-greencard-categories.csv` in full; neither has anything for either of these two case types, so no amount of re-reading the text would surface a valid code.

### D1. Asylum / refugee — `unlawful-presence.txt`
The post is clearly asylum-based (`I-589`, `I-730` referenced directly), and `asylum`/`refugee` already exist as general **tags** (`1.10-common-misc.csv`) — but there is no selectable `visa_applying_for`/`current_visa_or_greencard_category` code for "asylee" or "asylum-based adjustment" anywhere in `1.1`/`1.2`.

### D2. Naturalization / citizenship — `n400-after-divorce.txt`, `n400-interview.txt`, `n400-update.txt` (3 of the 17 failures)
Same shape of gap: no N-400/citizenship code exists. By definition, an N-400 applicant is *already* a green-card holder — so `current_visa_or_greencard_category` should really reflect the **original** GC category (family/employment/diversity/asylum-based) that got them the green card in the first place. But naturalization narratives, unsurprisingly, don't restate that origin story — none of these 3 posts mention it. This is a **systemic** pattern (3/17 in one batch), not a one-off.

### Proposed next steps for Category D — needs a product/vocab decision, not a code patch
This is exactly the kind of gap `docs/ingestion/TAG-LIFECYCLE.md`'s new-tag-proposal process exists for (currently DRAFT/unbuilt — see that doc). Two options, not mutually exclusive:

1. **Add real vocab entries** — e.g. an asylum-based-adjustment code to `1.2-greencard-categories.csv`, and either an N-400/naturalization entry or an explicit curator convention ("if the post is about naturalization and doesn't restate the original GC category, look it up before drafting tags"). Requires deciding the actual code name/shape — a vocab-owner call, not something to invent unilaterally here.
2. **Change `validate()`'s rule for these specific cases** — e.g. don't require a visa/GC code when a deterministic asylum/naturalization signal is already present (mirroring the existing `news-update` exception already in `validate()`), if adding vocab entries isn't judged worth it for a rarer content type.

Until one of these is decided, the 4 affected files can't be published without *either* a vocab change *or* stretching an existing code to fit (not recommended — e.g. forcing `IR-1` onto an asylum case would be factually wrong).

---

## Summary table

| Category | Count | Files | Status / next step |
|---|---|---|---|
| **A** — fixed | 2 | `congressional-inquiry.txt`, `travels-ggestion.txt` | ✅ Published (`app-2026-07-28-f1376cc4`, `app-2026-07-28-aed6f2ad`); code fix committed (`d3b8f77`) |
| **B** — probable fix | 2 | `i130.txt`, `i751-eveidence.txt` | Confirm citizen-vs-LPR petitioner, then patch + publish |
| **C** — needs human input | 9 (7 remaining) | see table above | 2 now auto-resolve via generic fallback (✅ implemented); 7 still need supplied detail, then patch + publish (or leave unpublished) |
| **D** — vocab gap | 4 | `unlawful-presence.txt`, `n400-*.txt` ×3 | Vocab-owner decision (add codes, or relax `validate()`) |
| **Total** | **17** | | matches all 17 original batch failures |
