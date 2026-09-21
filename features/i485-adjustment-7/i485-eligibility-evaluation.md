# I-485 (Adjustment of Status) filing categories → our tag vocabulary

**Status:** evaluation, 2026-08-08. Written to answer four questions before any
"Processing type → Adjustment of Status" UI work ships:

1. What makes an applicant **eligible** to file an I-485 at all?
2. Which **categories** must they be in to file?
3. Which of those categories map **one-to-one** to a tag we already have?
4. Where are the **gaps** (category with no tag) and **overlaps** (one concept,
   several tags)?

**Authority and what was actually verified.**

| Claim | Source | Verified? |
|---|---|---|
| Eligibility gates, bars, §245(i)/(k)/(l)/(m) | INA § 245 = [8 U.S.C. § 1255](https://www.law.cornell.edu/uscode/text/8/1255) | ✅ fetched and read |
| The Part 2 category list (§2 below) | Form I-485 **edition 12/23/22**, [NIWAP mirror](https://niwaplibrary.wcl.american.edu/wp-content/uploads/i-485.pdf), text extracted from the PDF | ✅ verbatim |
| Current form edition is **01/20/25** | USCIS newsroom + a USCIS *Table of Changes* dated 10/21/2025 ([regulations.gov](https://downloads.regulations.gov/USCIS-2025-0304-0006/content.pdf)) | ✅ |
| The 01/20/25 Part 2 list is unchanged from 12/23/22 | — | ❌ **not verified** — see §8 |

`uscis.gov` returns 403 to our fetcher (the same bot wall the
[EAD evaluation](../ead-eligibility-5/ead-eligibility-evaluation.md) hit), so the
category list below is transcribed from the last edition we could obtain in
full. The 1.a–1.g structure has been stable since the 2017 redesign and the
01/20/25 revision was driven by public-charge questions rather than the
category list — but **§8 lists this as an open verification item**, and no
vocabulary change should be shipped on the assumption alone.

> This is engineering analysis for building a tag taxonomy. It is **not legal
> advice** and must never be surfaced to users as eligibility guidance — the
> same guardrail `query.py` enforces for answers.

---

## 1. Eligibility — the gates, which are *not* categories

A category alone does not make someone able to file. INA § 245 imposes gates
that cut **across** every category, and conflating the two is the first way a
taxonomy goes wrong.

### 1.1 The three core requirements — § 245(a)

1. The applicant was **inspected and admitted or paroled** into the U.S.
2. An **immigrant visa is immediately available** at the time of filing.
3. The applicant is **admissible** (or has a waiver) and eligible to receive an
   immigrant visa.

Requirement 2 is the one users talk about constantly: it is the Visa Bulletin.
Whether a month is filable turns on **Final Action Dates** vs **Dates for
Filing**, and USCIS announces which chart applies each month. Immediate
relatives (IR-1…IR-5) are exempt from numerical limits, so a visa is always
immediately available to them — which is why they can file I-130 and I-485
concurrently and the rest of the family categories usually cannot.

### 1.2 The bars — § 245(c)

Barred (non-exhaustively): alien crewmen; anyone who engaged in **unauthorized
employment**; anyone who **failed to maintain continuous lawful status**;
transit-without-visa entrants; visa-waiver entrants; S visa holders; and
employment-based applicants not in lawful nonimmigrant status on the filing
date.

### 1.3 The exceptions that matter most

| Provision | Effect |
|---|---|
| **§ 245(c) exemption** | **Immediate relatives** and VAWA self-petitioners are forgiven status/unauthorized-work violations. This is the single biggest asymmetry in the whole area. |
| **§ 245(k)** | Employment-based (EB-1…EB-5) applicants are forgiven if their aggregate violations since last lawful admission are **≤ 180 days**. |
| **§ 245(i)** | Grandfathering: a petition or labor certification filed **on or before April 30, 2001**, plus **physical presence on December 21, 2000**, lets an otherwise-barred applicant adjust for a **$1,000** penalty. Filed on **Supplement A**. |
| **§ 245(l) / (m)** | T and U nonimmigrants adjust under their own rules — a **3-year continuous presence** requirement, with humanitarian/public-interest discretion. |

**Taxonomy consequence.** None of these belong in the category dropdown.
§ 245(i) in particular is a *yes/no* on the form (Part 2, Item 2), orthogonal to
the category — the form itself says a §245(i) applicant must *also* have picked
a family / employment / special-immigrant / DV category. In our model these are
**post-join attributes** (`key_stages_or_info`), never criteria tags. See §7.3.

---

## 2. The categories — Form I-485, Part 2, verbatim

> "I am applying to register lawful permanent residence or adjust status to
> that of a lawful permanent resident based on the following immigrant category
> (**select only one box**)."

That parenthetical is the whole reason a one-to-one tag mapping is even
coherent: USCIS models this as a single-select, so exactly one tag should carry
it.

**1.a Family-based**
1. Immediate relative of a U.S. citizen — Form I-130
2. Other relative of a U.S. citizen, or relative of an LPR, under the family-based preference categories — Form I-130
3. Person admitted as a fiancé(e) or child of a fiancé(e) of a U.S. citizen — Form I-129F (K-1/K-2)
4. Widow or widower of a U.S. citizen — Form I-360
5. VAWA self-petitioner — Form I-360

**1.b Employment-based**
6. Alien worker — Form I-140
7. Alien entrepreneur — Form I-526

**1.c Special Immigrant**
8. Special immigrant juvenile — Form I-360
9. Certain Afghan or Iraqi national — Form I-360 or DS-157
10. Religious worker — Form I-360
11. Certain international broadcaster — Form I-360
12. Certain G-4 international organization employee/family member, or NATO-6 employee/family member — Form I-360

**1.d Asylee or Refugee**
13. Asylum status (INA § 208) — Form I-589 or I-730
14. Refugee status (INA § 207) — Form I-590 or I-730

**1.e Human Trafficking Victim or Crime Victim**
15. Crime victim (U nonimmigrant) — Form I-918, I-918A, or I-929
16. Human trafficking victim (T nonimmigrant) — Form I-914 or I-914A

**1.f Special Programs Based on Certain Public Laws**
17. The Cuban Adjustment Act
18. The Cuban Adjustment Act for battered spouses and children
19. Dependent status under the Haitian Refugee Immigrant Fairness Act (HRIFA)
20. Dependent status under HRIFA for battered spouses and children
21. Lautenberg Parolees
22. Indochinese Parole Adjustment Act of 2000
23. Diplomats or high-ranking officials unable to return home (Section 13, Act of September 11, 1957)

**1.g Additional Options**
24. Diversity Visa program
25. Individual born in the United States under diplomatic status
26. Continuous residence in the United States since before January 1, 1972 ("Registry")
27. Other eligibility

**27 checkboxes.** Note item 27: the form has its own last-resort catch-all,
which independently validates the design of our `adjustment-of-status` fallback
tag.

---

## 3. The mapping

"Our tag" is the closest existing entry in `backend/tags-cleaned/`. Every
presence/absence below was checked against the **loaded** vocabulary
(`posting._Vocab`), not just the CSV text.

| # | I-485 category | Our tag | File | Verdict |
|---|---|---|---|---|
| 1 | Immediate relative (I-130) | `IR-1` `IR-2` `IR-3` `IR-4` `IR-5` | 1.2 | ⚠️ **finer than the checkbox** — no group tag |
| 2 | Family preference (I-130) | `F1-FAMILY` `F2A-FAMILY` `F2B-FAMILY` `F3-FAMILY` `F4-FAMILY` | 1.2 | ⚠️ finer than the checkbox |
| 3 | Fiancé(e) K-1/K-2 (I-129F) | `K-1` | 1.1 | ⚠️ **`K-2` missing** |
| 4 | Widow(er) of U.S. citizen (I-360) | — | — | ❌ **no tag** |
| 5 | VAWA self-petitioner (I-360) | `VAWA` | **1.3** | ⚠️ exists, but filed as an *abbreviation* |
| 6 | Alien worker (I-140) | `EB-1` `EB-1A` `EB-1B` `EB-1C` `EB-2` `EB-3` | 1.2 | ⚠️ finer than the checkbox |
| 7 | Alien entrepreneur (I-526) | `EB-5` | 1.2 | ✅ |
| 8 | Special immigrant juvenile (I-360) | *(inside `EB-4`'s description)* | — | ❌ **no tag** |
| 9 | Certain Afghan or Iraqi national (I-360) | `SIV` | 1.2 | ✅ |
| 10 | Religious worker (I-360) | *(inside `EB-4`'s description)* | — | ❌ **no tag** |
| 11 | Certain international broadcaster (I-360) | — | — | ❌ no tag |
| 12 | G-4 / NATO-6 special immigrant (I-360) | — | — | ❌ no tag (`G-4` is the *visa*, not this) |
| 13 | Asylum status (I-589 / I-730) | `asylum` | 1.10 | ✅ |
| 14 | Refugee status (I-590 / I-730) | `refugee` | 1.10 | ✅ |
| 15 | Crime victim, U (I-918) | `U-1` (+ `U-2` `U-3`) | 1.1 | ✅ |
| 16 | Trafficking victim, T (I-914) | `T-1` (+ `T-2`…`T-6`) | 1.1 | ✅ |
| 17 | Cuban Adjustment Act | — | — | ❌ no tag |
| 18 | CAA, battered spouses/children | — | — | ❌ no tag |
| 19 | HRIFA dependent | — | — | ❌ no tag |
| 20 | HRIFA, battered spouses/children | — | — | ❌ no tag |
| 21 | Lautenberg Parolees | — | — | ❌ no tag |
| 22 | Indochinese Parole Adjustment Act 2000 | — | — | ❌ no tag |
| 23 | Section 13 diplomats | — | — | ❌ no tag |
| 24 | Diversity Visa program | `DV` | 1.2 | ✅ |
| 25 | Born in the U.S. under diplomatic status | — | — | ❌ no tag |
| 26 | Registry (pre-1972) | — | — | ❌ no tag |
| 27 | Other eligibility | `adjustment-of-status` | 1.2 | ✅ **exact match to the form's own catch-all** |

**Score: 8 clean one-to-one · 5 granularity mismatches · 14 with no tag at all.**

---

## 4. Gaps — categories with no tag

### 4.1 Common enough to matter

| Category | Why it will show up |
|---|---|
| **Widow(er) of a U.S. citizen** | A real, recurring family-based path with its own I-360 and its own timeline. |
| **Special immigrant juvenile** | High-volume, and currently invisible — swallowed by `EB-4`'s prose. |
| **Religious worker** | Same problem, plus a statutory sunset that generates news. |
| **VAWA** | Tag exists but in the wrong file (§5.4). |
| **K-2** | We have `K-1`, `K-3`, `K-4` but not `K-2` — an arbitrary hole in a sequence we otherwise cover. |

### 4.2 Rare, legacy, or closed-cohort

International broadcaster · G-4/NATO-6 special immigrant · Cuban Adjustment Act
(± battered) · HRIFA (± battered) · Lautenberg · Indochinese Parole Adjustment
Act 2000 · Section 13 diplomats · born-in-US-diplomatic-status · Registry.

These are genuinely uncommon in a consumer immigration forum. The
`adjustment-of-status` fallback already covers them without loss of
correctness — a posting tagged that way is still findable, just not
sub-categorised. **Recommendation: do not add these until one is actually
observed in live content.** Adding 9 tags nobody uses makes the Gemini tagging
prompt longer and *less* accurate for the categories that do matter.

---

## 5. Overlaps — one concept, several tags

These are more damaging than the gaps: a gap loses detail, an overlap splits
the same cohort into two that can never find each other.

### 5.1 `i485-*` vs `aos-*` — the same lifecycle, twice ⚠️ worst offender

`backend/tags-cleaned/1.6-visa-form-actions.csv` contains **both**:

```
i485-filing   i485-approval   i485-rfe
aos-filing    aos-interview   aos-approval
```

Six tags for what is at most four events — and neither family is complete:
`i485-*` has the RFE but no interview, `aos-*` has the interview but no RFE. Two
users describing the identical milestone will be tagged differently depending on
whether they wrote "I-485" or "AOS". For a Timeline group scoped by processing
type this is a cohort-splitter.

**Recommendation: keep one family, alias the other.** `i485-*` is the better
survivor — it names the form, matches `i130-*` / `i140-*` / `i539-*` / `i131-*`
in the same file, and "AOS" is an abbreviation we already carry separately.
Target set: `i485-filing`, `i485-rfe`, `i485-interview` (new), `i485-approval`,
`i485-denial` (new).

### 5.2 `AOS` vs `adjustment-of-status`

`AOS` (1.3, abbreviation) and `adjustment-of-status` (1.2, greencard category)
are the same concept in two files with two different meanings-in-use — one is a
term, one is a filing basis. This is tolerable *only* because they live in
different vocabulary classes and `_clean_criteria()` treats them differently.
Worth an explicit note in the CSVs so nobody "tidies" one into the other.

Also: `1.3-abbreviations.csv` line 35 still carries
`AOS,adjustment-of-status-AOS` in its `alternate_tag` column, but
`adjustment-of-status-AOS` is **not in the loaded vocabulary** — it was retired
in `81f9618`. The CSV cell is dead text. **Cleanup: blank that cell.**

### 5.3 `family-immigration` vs `family-based-immigration` 🚨

| Tag | File | Class |
|---|---|---|
| `family-immigration` | 1.2 greencard-categories | greencard category |
| `family-based-immigration` | 1.10 common-misc | misc tag |

Two tags, four words apart, in different files and different vocabulary
classes. Identically for `employment-immigration` (1.2) vs
`employment-based-immigration` (1.10). Nothing in the names tells you which is
which, and `_clean_criteria()` admits them from different fields — so picking
the wrong one silently changes whether the value survives into group criteria.

This is a live footgun independent of I-485. **Recommendation: rename the 1.10
pair to something unmistakably topical (`family-immigration-topic`) or retire
them in favour of the 1.2 codes.**

### 5.4 `EB-4` swallows three distinct I-485 checkboxes

`EB-4`'s description reads *"Religious workers, Special Immigrant Juveniles, and
certain former U.S. government employees."* Those are checkboxes 10, 8 and 9 on
the form — three separate filing categories, each with its own timeline. And
checkbox 9 *also* has its own tag (`SIV`), so `EB-4` and `SIV` overlap for
Afghan/Iraqi nationals.

`EB-4` is a real visa-preference code and should stay. But it is a **preference
category**, not an I-485 filing category, and using it as one loses the
distinction the form draws.

### 5.5 `VAWA` is in the wrong file

`VAWA` sits in `1.3-abbreviations.csv`. It is not merely an abbreviation here —
it is an I-485 **filing category** (checkbox 5) and a § 245(c) bar exemption.
**Recommendation: add a `VAWA` entry to 1.2 greencard-categories** (keeping the
1.3 abbreviation for text matching), so it can serve as a group criterion.

### 5.6 `green-card-application` / `green-card-status` / `I-485` / `adjustment-of-status`

Four tags in the neighbourhood of "applying for a green card from inside the
U.S.". They are not strictly synonyms — `I-485` is a form, `green-card-status`
is an outcome — but the tagging prompt has to choose between them on thin
evidence. Worth a disambiguation note in the CSVs rather than a retirement.

### 5.7 The sibling axis: `consular-processing`

`consular-processing` (1.10) is the **alternative** to adjustment of status —
the same immigrant category pursued abroad through NVC and a consulate instead
of via I-485. Its own CSV definition already makes it greencard-only and
mutually exclusive with change-of-status: *"A nonimmigrant visa interview /
stamping at a consulate is NOT consular-processing"*
(`1.10-common-misc.csv:3`).

Not an overlap, but the two should be documented as a pair, because "EB-2,
India, filed March 2026" means a materially different timeline depending on
which route it is. **If an AOS processing type ships, `consular-processing`
is its sibling and should ship as an explicit alternative**, or users on the
consular route will pick AOS because it is the only option that mentions their
category.

---

## 6. The core design problem: granularity

Five categories are marked ⚠️ above for the same reason, and it is worth naming
directly.

**The form's checkbox is coarser than our tag.** "Immediate relative of a U.S.
citizen" is *one* box; we have five tags (IR-1…IR-5). "Alien worker" is one box;
we have six (EB-1…EB-3 and variants).

This is **not a defect** — our finer codes are strictly more useful. IR-5 filers
and IR-1 filers have different timelines and should not share a cohort. The
mismatch only becomes a problem if we try to build a dropdown whose options are
the form's checkboxes and whose values are our tags, because five tags cannot
be one option.

**Resolution:** treat the two levels as different things.

- The **checkbox** is a *grouping* in the UI — a heading, not a value.
- The **tag** is the specific code, chosen one level down.
- Where the specific code is genuinely unknown, the existing last-resort tags
  (`family-immigration`, `employment-immigration`, `adjustment-of-status`)
  already carry the checkbox-level meaning. That is exactly what they were added
  for, and it means we *already* have one-to-one coverage at checkbox level for
  categories 1, 2 and 6 — via the fallback, not via a new tag.

So the honest score is better than §3's raw count suggests: **11 of 27
checkboxes have an exact or fallback-exact tag today**, and the five ⚠️
granularity rows are a UI-layer concern rather than a vocabulary gap.

---

## 7. Recommendation — the one-to-one set

### 7.1 Tier 1 — add now (5 tags)

| Category | Proposed tag | File | Note |
|---|---|---|---|
| Widow(er) of U.S. citizen | `widow-widower-IW` | 1.2 | I-360; distinct timeline |
| Special immigrant juvenile | `special-immigrant-juvenile-SIJ` | 1.2 | unbundle from EB-4 |
| Religious worker | `religious-worker-SR` | 1.2 | unbundle from EB-4 |
| VAWA self-petitioner | `VAWA` | **1.2** | *move/duplicate* from 1.3 |
| Fiancé(e) derivative child | `K-2` | 1.1 | fills the K-1/K-3/K-4 hole |

### 7.2 Tier 2 — fix the overlaps (no new tags)

1. Retire `aos-filing` / `aos-interview` / `aos-approval`; add `i485-interview`
   and `i485-denial`; keep the `i485-*` family as the single lifecycle. **Needs
   a live-data check first** — the same one done for the EAD retirements in
   `81f9618` — because retiring a tag that live postings carry orphans them.
2. Blank the dead `adjustment-of-status-AOS` cell in 1.3.
3. Rename or retire `family-based-immigration` / `employment-based-immigration`
   (1.10) against `family-immigration` / `employment-immigration` (1.2).
4. Add disambiguation prose to `EB-4`, `SIV`, `green-card-application`,
   `adjustment-of-status`, `consular-processing`.

### 7.3 Not tags — attributes

These come up constantly in I-485 discussion and must **not** become category
tags. They belong in the Timeline attribute config as post-join rows
(`key_dates` / `key_stages_or_info`), exactly as the H-1B petition fields do:

| Concept | Where it goes |
|---|---|
| Priority date | `priority_date` — **already a post-join row** for `adjustment-of-status` |
| Filing under § 245(i) | new checkbox row |
| § 245(k) reliance | new checkbox row |
| Concurrent filing (I-130/I-140 + I-485) | new checkbox row |
| Receipt date, RFE date, interview date, approval date | `key_dates` rows — mirror the H-1B template |
| Biometrics, medical (I-693), EAD/AP combo card | `key_dates` rows |
| Visa Bulletin chart used (Final Action vs Dates for Filing) | select row |

We already have `visa-bulletin`, `priority-date-current`, `medical-exam`,
`public-charge`, `affidavit-of-support` and `unlawful-presence` as topical tags
— those are fine as *topics* and should not be duplicated as attributes.

### 7.4 Deliberately not doing

The nine Tier-3 categories in §4.2. `adjustment-of-status` covers them
correctly today, and nine unused tags would measurably degrade the tagging
prompt.

---

## 8. Open verification items

1. **Confirm the Part 2 list against edition 01/20/25.** Everything in §2 is
   verbatim from 12/23/22. Do this before adding any Tier-1 tag whose wording
   comes from the form. `uscis.gov` 403s our fetcher; a human opening
   [uscis.gov/i-485](https://www.uscis.gov/i-485) resolves it in a minute.
2. **A public-charge change is in flight.** The USCIS *Table of Changes* we
   fetched is dated 10/21/2025, is titled *"Public Charge Rescission NPRM"*, and
   names a *"Future Edition Date xx/xx/2026"*. An NPRM is a **proposal**, not
   law — but our `public-charge` tag and any Part 9 assumptions may need
   revisiting when it lands.
3. **May 22, 2026 USCIS policy guidance on adjustment of status** was reported
   in search results but not read. Should be reviewed before Tier-1 ships.
4. **Live-data check before any retirement** in §7.2 item 1 — count postings
   carrying `aos-filing` / `aos-interview` / `aos-approval` in the Vertex
   datastore first.

---

## 9. Related documents

- [`../ead-eligibility-5/ead-eligibility-evaluation.md`](../ead-eligibility-5/ead-eligibility-evaluation.md)
  — the same exercise for Form I-765, and the source of the "(b) classes never
  file" rule
- [`../timeline-attributes-6/timeline-attribute-framework.md`](../timeline-attributes-6/timeline-attribute-framework.md)
  — how a category becomes a Timeline group's scope and post-join rows
- [`../../docs/TIMELINE-ATTRIBUTE-CONFIG.md`](../../docs/TIMELINE-ATTRIBUTE-CONFIG.md)
  — the runbook for actually shipping a category into the dropdowns
- [`../../backend/config/README.md`](../../backend/config/README.md)
  — scope-row vs post-join-row judgement, which §7.3 depends on
